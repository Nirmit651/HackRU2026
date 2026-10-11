import { z } from "zod";
import type { BusSnapshot } from "../shared/contracts";
import { db, ensure } from "./db";
import { ruleSchema } from "../shared/contracts";
import type { Visit } from "./automation/bus-state";
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
    if (
      settings.kind === "arrival_by_deadline" ||
      settings.kind === "presence_at_time"
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
        const observation = (row?.data as unknown as {
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
          .sort((a, b) => Date.parse(b.sourceAt) - Date.parse(a.sourceAt))[0];
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
        };
      }
      const [observation] = await db.$queryRaw<
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
        ORDER BY source_measured_at DESC,id DESC LIMIT 1`;
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
