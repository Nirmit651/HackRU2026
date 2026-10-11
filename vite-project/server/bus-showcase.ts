import { randomUUID } from "node:crypto";
import { configure } from "./automation";
import { add, createAutomatedMarket, iso, nowFor, rule, settingsSchema } from "./automation/core";
import { meters } from "./automation/bus-state";
import { db, ensure } from "./db";

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
  const latest = await db.$queryRaw<VehicleObservation[]>`
    SELECT DISTINCT ON (vehicle_id) vehicle_id,route_id,latitude,longitude,source_measured_at,retrieved_at FROM public.bus_observations
    WHERE source_system='rubus' AND is_valid AND observation_kind='vehicle_position' AND measurement_time_basis='source'
      AND route_id IS NOT NULL AND latitude IS NOT NULL AND longitude IS NOT NULL AND source_measured_at IS NOT NULL
    ORDER BY vehicle_id,source_measured_at DESC,id DESC`;
  const history = await db.$queryRaw<VehicleObservation[]>`
    SELECT vehicle_id,route_id,latitude,longitude,source_measured_at,retrieved_at FROM public.bus_observations
    WHERE source_system='rubus' AND is_valid AND observation_kind='vehicle_position' AND measurement_time_basis='source'
      AND route_id IS NOT NULL AND latitude IS NOT NULL AND longitude IS NOT NULL AND source_measured_at >= ${add(at, -15 * 60)}
    ORDER BY vehicle_id,source_measured_at,id`;
  const selected = selectNextBusCandidate(latest, history, at);
  ensure(selected, "NO_ELIGIBLE_RUTGERS_BUS", 503);
  const existingConfig = await db.automationConfig.findUnique({ where: { environmentId_type: { environmentId: environment.id, type: "bus" } } });
  const currentSettings = existingConfig ? settingsSchema.parse(existingConfig.settings) : settingsSchema.parse({});
  const stops = currentSettings.stops.some((stop) => stop.id === collegeAveStudentCenter.id) ? currentSettings.stops : [...currentSettings.stops, collegeAveStudentCenter];
  await configure(environment.id, "bus", true, { ...currentSettings, sourceSystem: "rubus", sourceVerifiedLive: true, stops });
  const closesAt = add(at, MAX_ETA_SECONDS), target = add(at, selected.etaSeconds + 600), voidAfter = add(closesAt, 15 * 60), eventId = randomUUID();
  const condition = `YES if frozen Rutgers bus ${selected.vehicleId} on route ${selected.routeId} enters the College Avenue Student Center 65m geofence and remains continuously within it for at least 10 minutes. NO if it enters and is confirmed outside the geofence before 10 minutes. Trading closes on first qualifying entry. Missing, stale, conflicting, or wrong-route source-timestamped evidence is VOID after ${iso(voidAfter)}.`;
  const settings = { kind: "next_bus_break", sourceSystem: "rubus", vehicleId: selected.vehicleId, routeId: selected.routeId, stop: collegeAveStudentCenter, opensAt: iso(at), closesAt: iso(closesAt), voidAfter: iso(voidAfter), enterMeters: 65, exitMeters: 75, maxGapSeconds: CANDIDATE_FRESH_SECONDS, latenessSeconds: 30, durationSeconds: 600, selectedAt: iso(at), selectedEtaSeconds: selected.etaSeconds, etaMethod: selected.etaMethod, algorithm: "rutgers-next-bus-break-v1", algorithmVersion: 1 };
  return createAutomatedMarket({ environmentId: environment.id, generatorKey: `bus-showcase:${eventId}`, templateVersion: 1, slug: `bus-showcase-${eventId.slice(0, 12)}`, title: "Will the next bus arriving at College Avenue Student Center take a break?", description: condition, category: "BUS_ARRIVAL", opensAt: iso(at), closesAt: iso(closesAt), expectedResolutionAt: iso(target), resolutionRule: rule("bus", "rubus", eventId, closesAt, at, target, voidAfter, settings, condition), sourceUrl: collegeAveStudentCenter.sourceUrl,
    context: { routeId: selected.routeId, vehicleId: selected.vehicleId, stopId: collegeAveStudentCenter.id, stopName: collegeAveStudentCenter.name, stop: collegeAveStudentCenter, destination: collegeAveStudentCenter.name, frozenEtaSeconds: selected.etaSeconds, selectionTimestamp: iso(at), selectionAlgorithm: settings.algorithm, selectionAlgorithmVersion: settings.algorithmVersion, etaMethod: selected.etaMethod, deadline: iso(target) } });
}
