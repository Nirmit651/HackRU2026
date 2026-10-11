import { add, createAutomatedMarket, iso, nowFor, rule } from "./automation/core";
import { meters } from "./automation/bus-state";
import { db, ensure } from "./db";
import { selectNextEligibleArrival, tripshotLive } from "./tripshot";

// Official TripShot static GTFS stop 10035. Keep the legacy position-based
// fallback aligned with the same destination used by the live selector.
export const collegeAveStudentCenter = { id: "10035", name: "College Avenue Student Center", latitude: 40.503664735, longitude: -74.452402128, sourceUrl: "https://rutgers.tripshot.com/" };
const CANDIDATE_FRESH_SECONDS = 90;
const FALLBACK_SPEED_MPS = 4.5; // Conservative urban bus speed when two useful fixes are unavailable.
const MAX_ETA_SECONDS = 2 * 60 * 60;
export type VehicleObservation = { vehicle_id: string; route_id: string | null; latitude: number; longitude: number; source_measured_at: Date; retrieved_at: Date };
export type NextBusCandidate = { vehicleId: string; routeId: string; etaSeconds: number; etaMethod: "recent-position-speed" | "conservative-fallback-speed" };
const median = (values: number[]) => values.slice().sort((a, b) => a - b)[Math.floor(values.length / 2)];

/** Picks one frozen vehicle only; ETA is straight-line distance divided by observed or conservative speed. */
export function selectNextBusCandidate(latest: VehicleObservation[], history: VehicleObservation[], at: Date): NextBusCandidate | null {
  const newest = new Map<string, VehicleObservation>();
  for (const row of latest) {
    if (!row.vehicle_id || !row.route_id || !Number.isFinite(row.latitude) || !Number.isFinite(row.longitude) || !row.source_measured_at || +at - +new Date(row.source_measured_at) > CANDIDATE_FRESH_SECONDS * 1000 || meters(collegeAveStudentCenter, row) <= 65) continue;
    const old = newest.get(row.vehicle_id);
    if (!old || +row.source_measured_at > +old.source_measured_at) newest.set(row.vehicle_id, row);
  }
  const candidates = [...newest.values()].map((row) => {
    const points = history.filter((x) => x.vehicle_id === row.vehicle_id && x.route_id === row.route_id && +x.source_measured_at <= +row.source_measured_at).sort((a, b) => +a.source_measured_at - +b.source_measured_at);
    const speeds: number[] = [];
    for (let i = 1; i < points.length; i++) {
      const seconds = (+points[i].source_measured_at - +points[i - 1].source_measured_at) / 1000;
      const speed = seconds > 0 ? meters(points[i - 1], points[i]) / seconds : 0;
      if (speed >= 0.5 && speed <= 20) speeds.push(speed);
    }
    const speed = speeds.length ? median(speeds) : FALLBACK_SPEED_MPS, etaSeconds = Math.ceil(meters(row, collegeAveStudentCenter) / speed);
    return Number.isFinite(etaSeconds) && etaSeconds >= 1 && etaSeconds <= MAX_ETA_SECONDS ? { vehicleId: row.vehicle_id, routeId: row.route_id!, etaSeconds, etaMethod: speeds.length ? "recent-position-speed" as const : "conservative-fallback-speed" as const } : null;
  }).filter((candidate): candidate is NextBusCandidate => candidate !== null);
  return candidates.sort((a, b) => a.etaSeconds - b.etaSeconds || a.vehicleId.localeCompare(b.vehicleId))[0] ?? null;
}

const RETRY_KEY = "tripshot-college-ave:retry", RETRY_SECONDS = 600, DWELL_SECONDS = 600;
async function deferNextMarket(environmentId: string, at: Date, reason: string) {
  const retryAt = add(at, RETRY_SECONDS);
  await db.automationState.upsert({
    where: { environmentId_key: { environmentId, key: RETRY_KEY } },
    create: { environmentId, key: RETRY_KEY, kind: "BUS_NEXT_RETRY", data: { retryAt: iso(retryAt), reason } },
    update: { data: { retryAt: iso(retryAt), reason }, version: { increment: 1 } },
  });
  return retryAt;
}

/** Ensures exactly one frozen, eligible College Ave TripShot market is active. */
export async function ensureNextCollegeAveBreakMarket(environmentId?: string) {
  const environment = environmentId
    ? await db.environment.findUniqueOrThrow({ where: { id: environmentId } })
    : await db.environment.findFirst({ where: { kind: "LIVE" }, orderBy: { createdAt: "desc" } });
  ensure(environment, "LIVE_ENVIRONMENT_NOT_FOUND", 404);
  const existing = await db.market.findFirst({ where: { environmentId: environment.id, generatorKey: { startsWith: "tripshot-college-ave:" }, status: { in: ["DRAFT", "OPEN", "PAUSED", "CLOSED"] } }, orderBy: { createdAt: "desc" } });
  if (existing) return { ...existing, creationReplayed: true };
  const at = await nowFor(environment.id);
  const retry = await db.automationState.findUnique({ where: { environmentId_key: { environmentId: environment.id, key: RETRY_KEY } } });
  const retryAt = (retry?.data as { retryAt?: string } | undefined)?.retryAt;
  if (retryAt && at < new Date(retryAt)) return null;
  const live = await tripshotLive();
  if (live.stale) { await deferNextMarket(environment.id, at, "STALE_TRIPSHOT_FEED"); return null; }
  const candidate = selectNextEligibleArrival(live);
  if (!candidate) { await deferNextMarket(environment.id, at, "NO_ELIGIBLE_BUS_OUTSIDE_STUDENT_CENTER"); return null; }
  const selected = { vehicleId: candidate.vehicle.id, routeId: candidate.arrival.routeId, tripId: candidate.arrival.tripId, predictedArrival: candidate.arrival.arrivalAt, stop: candidate.stop };
  const duplicate = await db.market.findFirst({ where: { environmentId: environment.id, category: "BUS_ARRIVAL", status: { in: ["DRAFT", "OPEN", "PAUSED", "CLOSED"] }, context: { path: ["tripId"], equals: selected.tripId } }, orderBy: { createdAt: "desc" } });
  if (duplicate) return { ...duplicate, creationReplayed: true };
  // A terminal market may legitimately select the same trip again after a
  // retry. Key a new cycle to its immediate terminal predecessor, so concurrent
  // runs replay one creation while never replaying an archived market.
  const predecessor = await db.market.findFirst({
    where: { environmentId: environment.id, generatorKey: { startsWith: "tripshot-college-ave:" }, status: { in: ["RESOLVED", "VOIDED"] } },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });
  const cycleKey = predecessor?.id ?? "initial";
  const closesAt = add(new Date(selected.predictedArrival), 60 * 60), target = add(new Date(selected.predictedArrival), DWELL_SECONDS), voidAfter = add(closesAt, 15 * 60), eventId = `${selected.tripId}:${selected.stop.id}`;
  const stop = { ...selected.stop, sourceUrl: "https://rutgers.tripshot.com/" };
  const initialObservation = { provider: "tripshot", vehicleId: candidate.vehicle.id, tripId: candidate.vehicle.tripId, routeId: candidate.vehicle.routeId, sourceAt: candidate.vehicle.updatedAt, receivedAt: live.vehicleFeedAt, latitude: candidate.vehicle.latitude, longitude: candidate.vehicle.longitude };
  const settings = { kind: "next_bus_break", sourceSystem: "tripshot", vehicleId: selected.vehicleId, routeId: selected.routeId, tripId: selected.tripId, stop, stops: [stop], opensAt: iso(at), closesAt: iso(closesAt), voidAfter: iso(voidAfter), enterMeters: 65, exitMeters: 75, anchorMeters: 25, maxGapSeconds: 45, latenessSeconds: 30, durationSeconds: DWELL_SECONDS, selectedAt: iso(at), predictedArrival: selected.predictedArrival, feedTimestamp: candidate.arrival.feedTimestamp, initialObservation, algorithm: "tripshot-next-college-ave-break-v3", algorithmVersion: 3 };
  const condition = "YES if the frozen bus enters the College Avenue Student Center geofence and remains continuously there for 10 minutes. NO if it enters and confirmed departure occurs before 10 minutes. Trading closes at first entry. Stale, missing, conflicting, or identity-changing evidence VOIDs.";
  const market = await createAutomatedMarket({ environmentId: environment.id, generatorKey: `tripshot-college-ave:${selected.tripId}:${selected.stop.id}:${cycleKey}`, templateVersion: 1, slug: `tripshot-college-ave-${eventId.replace(/[^a-z0-9]/gi, "").slice(0, 18).toLowerCase()}-${cycleKey.slice(0, 8)}`, title: "Will the next bus to arrive at College Avenue Student Center take a 10-minute break?", description: condition, category: "BUS_ARRIVAL", opensAt: iso(at), closesAt: iso(closesAt), expectedResolutionAt: iso(target), resolutionRule: rule("bus", "TripShot GTFS-Realtime", eventId, closesAt, at, target, voidAfter, settings, condition), sourceUrl: "https://rutgers.tripshot.com/", context: { routeId: selected.routeId, vehicleId: selected.vehicleId, tripId: selected.tripId, stopId: selected.stop.id, stopName: selected.stop.name, stop, destination: selected.stop.name, predictedArrival: selected.predictedArrival, feedTimestamp: candidate.arrival.feedTimestamp, evidenceSource: "TripShot GTFS + GTFS-Realtime", deadline: iso(target), dwellSeconds: DWELL_SECONDS, cyclePredecessorId: predecessor?.id ?? null } });
  await db.automationState.delete({ where: { environmentId_key: { environmentId: environment.id, key: RETRY_KEY } } }).catch(() => {});
  return market;
}
export const createBusShowcase = ensureNextCollegeAveBreakMarket;
export async function deferCollegeAveBreakRetry(environmentId: string, at: Date, reason: string) { return deferNextMarket(environmentId, at, reason); }
