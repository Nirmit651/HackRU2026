import { add, createAutomatedMarket, iso, nowFor, rule } from "./automation/core";
import { meters } from "./automation/bus-state";
import { db, ensure } from "./db";
import { tripshotLive } from "./tripshot";

export const collegeAveStudentCenter = { id: "college-avenue-student-center", name: "College Avenue Student Center", latitude: 40.50073, longitude: -74.44866, sourceUrl: "https://rutgers.transloc.com/" };
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

/** Creates a single idempotent live market, using the teammate's persisted observation pipeline. */
export async function createBusShowcase() {
  const environment = await db.environment.findFirst({ where: { kind: "LIVE" }, orderBy: { createdAt: "desc" } });
  ensure(environment, "LIVE_ENVIRONMENT_NOT_FOUND", 404);
  // Replay before consulting the feed: an already-frozen active market remains the answer.
  const existing = await db.market.findFirst({ where: { environmentId: environment.id, generatorKey: { startsWith: "bus-showcase:" }, status: { in: ["DRAFT", "OPEN", "PAUSED", "CLOSED"] } }, orderBy: { createdAt: "desc" } });
  if (existing) return { ...existing, creationReplayed: true };
  const at = await nowFor(environment.id);
  // Prediction, rather than proximity, determines the next bus.  This is the
  // only selection path for the live market; the legacy RUBus query below is
  // retained for its exported historical test helper, not used here.
  const live = await tripshotLive();
  ensure(!live.stale && live.nextArrival, "NO_LIVE_ARRIVAL_PREDICTION", 503);
  const predicted = live.nextArrival;
  const targetStops = live.targetStops;
  ensure(targetStops.length > 0, "COLLEGE_AVE_STOP_NOT_FOUND", 503);
  const selectedStop = targetStops.find((stop) => stop.id === predicted.stopId) ?? targetStops[0];
  const selected = {
    vehicleId: predicted.vehicleId ?? `trip:${predicted.tripId}`,
    routeId: predicted.routeId,
    tripId: predicted.tripId,
    predictedArrival: predicted.arrivalAt,
    stop: selectedStop,
  };
  const duplicate = await db.market.findFirst({ where: { environmentId: environment.id, category: "BUS_ARRIVAL", status: { in: ["DRAFT", "OPEN", "PAUSED", "CLOSED"] }, context: { path: ["tripId"], equals: selected.tripId } }, orderBy: { createdAt: "desc" } });
  if (duplicate) return { ...duplicate, creationReplayed: true };
  const closesAt = new Date(Math.max(+at + 60_000, +new Date(selected.predictedArrival) - 60_000));
  const target = add(new Date(selected.predictedArrival), 300), voidAfter = add(target, 15 * 60), eventId = `${selected.tripId}:${selected.stop.id}`;
  const stops = targetStops.map((stop) => ({ ...stop, sourceUrl: "https://rutgers.tripshot.com/" }));
  const settings = { kind: "next_bus_break", sourceSystem: "tripshot", vehicleId: selected.vehicleId, routeId: selected.routeId, tripId: selected.tripId, stop: { ...selected.stop, sourceUrl: "https://rutgers.tripshot.com/" }, stops, opensAt: iso(at), closesAt: iso(closesAt), voidAfter: iso(voidAfter), enterMeters: 65, exitMeters: 75, maxGapSeconds: 45, latenessSeconds: 30, durationSeconds: 300, selectedAt: iso(at), predictedArrival: selected.predictedArrival, feedTimestamp: predicted.feedTimestamp, algorithm: "tripshot-next-college-ave-dwell-v2", algorithmVersion: 2 };
  const condition = "YES: the selected bus arrives within the College Avenue Student Center stop radius and remains stationary there for at least 5 continuous minutes. NO: the selected bus arrives, then clearly leaves before 5 minutes. VOID: vehicle/trip identity changes, data becomes stale, there is an excessive data gap, the bus disappears, or the evidence is otherwise insufficient.";
  return createAutomatedMarket({ environmentId: environment.id, generatorKey: `tripshot-college-ave:${selected.tripId}:${selected.stop.id}`, templateVersion: 2, slug: `tripshot-college-ave-${eventId.replace(/[^a-z0-9]/gi, "").slice(0, 18).toLowerCase()}`, title: "Will the next bus to arrive at College Avenue Student Center remain stopped for at least 5 minutes?", description: condition, category: "BUS_ARRIVAL", opensAt: iso(at), closesAt: iso(closesAt), expectedResolutionAt: iso(target), resolutionRule: rule("bus", "TripShot GTFS-Realtime", eventId, closesAt, at, target, voidAfter, settings, condition), sourceUrl: "https://rutgers.tripshot.com/", context: { routeId: selected.routeId, vehicleId: selected.vehicleId, tripId: selected.tripId, stopId: selected.stop.id, stopIds: targetStops.map((stop) => stop.id), stopName: selected.stop.name, stop: selected.stop, destination: selected.stop.name, predictedArrival: selected.predictedArrival, feedTimestamp: predicted.feedTimestamp, evidenceSource: "TripShot GTFS + GTFS-Realtime", deadline: iso(target), dwellSeconds: 300 } });
}
