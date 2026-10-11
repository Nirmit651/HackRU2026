import { z } from "zod";
import type { BusSnapshot } from "../shared/contracts";
import { db, ensure } from "./db";
import { ruleSchema } from "../shared/contracts";
import type { Visit } from "./automation/bus-state";
import { tripshotFrozenTrip } from "./tripshot";
const coordinate = {
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
};
export const busSchema = z.object({
  source: z.string(),
  isSimulated: z.boolean(),
  observedAt: z.iso.datetime(),
  receivedAt: z.iso.datetime(),
  vehicles: z
    .array(
      z.object({
        id: z.string(),
        routeId: z.string(),
        ...coordinate,
        heading: z.number().optional(),
        updatedAt: z.iso.datetime(),
      }),
    )
    .max(100),
  stops: z
    .array(z.object({ id: z.string(), name: z.string(), ...coordinate }))
    .max(200),
  routeGeometry: z
    .array(z.tuple([z.number(), z.number()]))
    .max(10000)
    .optional(),
  etaSeconds: z.number().optional(),
  geofenceEnterMeters: z.number().positive().optional(),
  geofenceExitMeters: z.number().positive().optional(),
});
export async function busSnapshot(
  marketId: string,
): Promise<BusSnapshot | null> {
  const market = await db.market.findUniqueOrThrow({ where: { id: marketId } });
  ensure(market.category === "BUS_ARRIVAL", "NOT_BUS_MARKET");
  const env = await db.environment.findUniqueOrThrow({
    where: { id: market.environmentId },
  });
  const automation = ruleSchema.parse(market.resolutionRule).automation;
  if (automation?.type === "bus") {
    const settings = automation.settings;
    if (settings.sourceSystem === "tripshot") {
      try {
        const live = await tripshotFrozenTrip(String(settings.tripId), String(settings.vehicleId));
        return {
          source: "TripShot GTFS + GTFS-Realtime",
          isSimulated: false,
          observedAt: live.observedAt,
          receivedAt: live.vehicleFeedAt,
          vehicles: live.vehicle ? [{ id: live.vehicle.id, routeId: live.vehicle.routeId, latitude: live.vehicle.latitude, longitude: live.vehicle.longitude, heading: live.vehicle.heading, updatedAt: live.vehicle.updatedAt }] : [],
          stops: [settings.stop as BusSnapshot["stops"][number]],
          routeGeometry: live.routeGeometry,
          etaSeconds: settings.predictedArrival ? Math.max(0, Math.round((+new Date(String(settings.predictedArrival)) - Date.now()) / 1000)) : undefined,
          activeRoutes: [String(settings.routeId)],
          trackedVehicleId: live.vehicle?.id ?? null,
          selectedRouteId: String(settings.routeId),
          predictedArrival: String(settings.predictedArrival ?? "") || null,
          tripFeedAt: live.tripFeedAt,
          vehicleFeedAt: live.vehicleFeedAt,
          stale: live.stale,
          geofenceEnterMeters: Number(settings.enterMeters),
          geofenceExitMeters: Number(settings.exitMeters),
        } as BusSnapshot;
      } catch (error) {
        // Keep upstream details server-side, but make a null snapshot diagnosable.
        console.warn("TripShot bus snapshot unavailable", error instanceof Error ? error.message : error);
        return null;
      }
    }
    if (
      settings.kind === "arrival_by_deadline" ||
      settings.kind === "presence_at_time" ||
      settings.kind === "next_bus_break"
    ) {
      if (env.kind === "DEMO") {
        const row = await db.automationState.findUnique({
          where: {
            environmentId_key: {
              environmentId: env.id,
              key: `demo-scheduled:${String(settings.sourceSystem)}:${String(settings.vehicleId)}:${String(settings.routeId)}`,
            },
          },
        });
        const observations = (row?.data as unknown as {
          provider: string;
          vehicleId: string;
          routeId: string | null;
          sourceAt: string;
          receivedAt: string;
          latitude: number;
          longitude: number;
        }[] | undefined)
          ?.filter((item) =>
            item.provider === settings.sourceSystem &&
            item.vehicleId === settings.vehicleId &&
            item.routeId === settings.routeId,
          )
          .sort((a, b) => Date.parse(a.sourceAt) - Date.parse(b.sourceAt)) ?? [];
        const observation = observations.at(-1);
        if (!observation) return null;
        return {
          source: market.provider,
          isSimulated: true,
          observedAt: observation.sourceAt,
          receivedAt: observation.receivedAt,
          vehicles: [{
            id: observation.vehicleId,
            routeId: observation.routeId ?? "Unknown",
            latitude: observation.latitude,
            longitude: observation.longitude,
            updatedAt: observation.sourceAt,
          }],
          stops: [settings.stop as BusSnapshot["stops"][number]],
          routeGeometry: observations.map((item) => [item.longitude, item.latitude]),
        };
      }
      const observations = await db.$queryRaw<
        {
          vehicle_id: string;
          route_id: string;
          source_measured_at: Date;
          retrieved_at: Date;
          latitude: number;
          longitude: number;
        }[]
      >`
        SELECT vehicle_id,route_id,source_measured_at,retrieved_at,latitude,longitude
        FROM public.bus_observations
        WHERE source_system=${String(settings.sourceSystem)}
          AND vehicle_id=${String(settings.vehicleId)}
          AND route_id=${String(settings.routeId)}
          AND is_valid AND observation_kind='vehicle_position'
          AND measurement_time_basis='source'
          AND source_measured_at IS NOT NULL
          AND latitude IS NOT NULL AND longitude IS NOT NULL
        ORDER BY source_measured_at DESC,id DESC LIMIT 80`;
      const observation = observations[0];
      if (!observation) return null;
      const sourceAt = observation.source_measured_at.toISOString();
      return {
        source: market.provider,
        isSimulated: false,
        observedAt: sourceAt,
        receivedAt: observation.retrieved_at.toISOString(),
        vehicles: [
          {
            id: observation.vehicle_id,
            routeId: observation.route_id,
            latitude: observation.latitude,
            longitude: observation.longitude,
            updatedAt: sourceAt,
          },
        ],
        stops: [settings.stop as BusSnapshot["stops"][number]],
        routeGeometry: observations
          .slice()
          .reverse()
          .map((item) => [item.longitude, item.latitude]),
      };
    }
    const row = await db.automationState.findUnique({
      where: {
        environmentId_key: {
          environmentId: env.id,
          key: `visit:${automation.settings.visitId}`,
        },
      },
    });
    const visit = row?.data as unknown as Visit | undefined;
    if (!visit?.last || !visit.stop) return null;
    return {
      source: market.provider,
      isSimulated: env.kind === "DEMO",
      observedAt: visit.last.sourceAt,
      receivedAt: visit.last.receivedAt,
      vehicles: [
        {
          id: visit.last.vehicleId,
          routeId: visit.last.routeId ?? "Unknown",
          latitude: visit.last.latitude,
          longitude: visit.last.longitude,
          updatedAt: visit.last.sourceAt,
        },
      ],
      stops: [visit.stop],
    };
  }
  if (env.kind === "DEMO") {
    const at = env.virtualNow!.toISOString();
    return {
      source: "Synthetic Livingston Plaza fixture",
      isSimulated: true,
      observedAt: at,
      receivedAt: at,
      vehicles: [
        {
          id: "demo-LX",
          routeId: "LX",
          latitude: 40.5231,
          longitude: -74.4364,
          updatedAt: at,
        },
      ],
      stops: [
        {
          id: "livingston-plaza",
          name: "Livingston Plaza (fixture coordinate)",
          latitude: 40.5235,
          longitude: -74.437,
        },
      ],
    };
  }
  if (!process.env.BUS_ADAPTER_URL) return null;
  const url = new URL(process.env.BUS_ADAPTER_URL);
  url.searchParams.set("marketId", marketId);
  const response = await fetch(url, {
    signal: AbortSignal.timeout(4000),
    headers: process.env.BUS_ADAPTER_TOKEN
      ? { Authorization: `Bearer ${process.env.BUS_ADAPTER_TOKEN}` }
      : {},
  });
  if (!response.ok) return null;
  const value = busSchema.parse(await response.json());
  ensure(!value.isSimulated, "SIMULATED_LIVE_FEED", 503);
  return value;
}
