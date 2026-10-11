import { randomUUID } from "node:crypto";
import { configure } from "./automation";
import { add, createAutomatedMarket, iso, nowFor, rule, settingsSchema } from "./automation/core";
import { db, ensure } from "./db";

const collegeAveStudentCenter = {
  id: "college-avenue-student-center",
  name: "College Avenue Student Center",
  latitude: 40.50073,
  longitude: -74.44866,
  sourceUrl: "https://rutgers.transloc.com/",
};

type VehicleObservation = { vehicle_id: string; route_id: string | null };

/**
 * Creates one idempotent, real-data bus arrival market for the live showcase.
 * The selected vehicle and route come from the latest valid RUBus observation,
 * so the market can also render its live map immediately.
 */
export async function createBusShowcase() {
  const environment = await db.environment.findFirst({
    where: { kind: "LIVE" },
    orderBy: { createdAt: "desc" },
  });
  ensure(environment, "LIVE_ENVIRONMENT_NOT_FOUND", 404);

  const [latest] = await db.$queryRaw<VehicleObservation[]>`
    SELECT vehicle_id, route_id
    FROM public.bus_observations
    WHERE source_system = 'rubus'
      AND is_valid
      AND observation_kind = 'vehicle_position'
      AND route_id IS NOT NULL
    ORDER BY source_measured_at DESC NULLS LAST, id DESC
    LIMIT 1`;
  ensure(latest?.vehicle_id && latest.route_id, "RUBUS_FEED_UNAVAILABLE", 503);

  const existingConfig = await db.automationConfig.findUnique({
    where: { environmentId_type: { environmentId: environment.id, type: "bus" } },
  });
  const currentSettings = existingConfig
    ? settingsSchema.parse(existingConfig.settings)
    : settingsSchema.parse({});
  const stops = currentSettings.stops.some((stop) => stop.id === collegeAveStudentCenter.id)
    ? currentSettings.stops
    : [...currentSettings.stops, collegeAveStudentCenter];
  await configure(environment.id, "bus", true, {
    ...currentSettings,
    sourceSystem: "rubus",
    sourceVerifiedLive: true,
    stops,
  });

  const existing = await db.market.findFirst({
    where: {
      environmentId: environment.id,
      generatorKey: { startsWith: "bus-showcase:" },
      status: { in: ["DRAFT", "OPEN", "PAUSED"] },
    },
    orderBy: { createdAt: "desc" },
  });
  if (existing) return { ...existing, creationReplayed: true };

  const opensAt = await nowFor(environment.id);
  const closesAt = add(opensAt, 15 * 60);
  const deadline = add(opensAt, 20 * 60);
  const voidAfter = add(deadline, 15 * 60);
  const eventId = randomUUID();
  const condition = `YES if a valid RUBus source-timestamped vehicle_position for vehicle ${latest.vehicle_id} on route ${latest.route_id} enters the frozen 65m College Avenue Student Center radius by ${iso(deadline)}. NO only with continuous source-time coverage from market open through the deadline, no gap over 90 seconds, and no qualifying arrival. Otherwise VOID after ${iso(voidAfter)}.`;
  const settings = {
    kind: "arrival_by_deadline" as const,
    sourceSystem: "rubus",
    vehicleId: latest.vehicle_id,
    routeId: latest.route_id,
    stop: collegeAveStudentCenter,
    opensAt: iso(opensAt),
    closesAt: iso(closesAt),
    deadline: iso(deadline),
    voidAfter: iso(voidAfter),
    enterMeters: 65,
    maxGapSeconds: 90,
    latenessSeconds: 30,
    algorithm: "bus-showcase-arrival-v1",
  };
  return createAutomatedMarket({
    environmentId: environment.id,
    generatorKey: `bus-showcase:${eventId}`,
    templateVersion: 1,
    slug: `bus-showcase-${eventId.slice(0, 12)}`,
    title: `Will a Rutgers ${latest.route_id.toUpperCase()} bus reach College Avenue Student Center within 20 minutes?`,
    description: condition,
    category: "BUS_ARRIVAL",
    opensAt: iso(opensAt),
    closesAt: iso(closesAt),
    expectedResolutionAt: iso(deadline),
    resolutionRule: rule(
      "bus",
      "rubus",
      eventId,
      closesAt,
      opensAt,
      deadline,
      voidAfter,
      settings,
      condition,
    ),
    sourceUrl: collegeAveStudentCenter.sourceUrl,
    context: {
      routeId: latest.route_id,
      vehicleId: latest.vehicle_id,
      stopId: collegeAveStudentCenter.id,
      stopName: collegeAveStudentCenter.name,
      deadline: iso(deadline),
    },
  });
}
