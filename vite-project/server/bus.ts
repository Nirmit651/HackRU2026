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
