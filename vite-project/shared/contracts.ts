import { z } from "zod";
export const categories = [
  "TEMPERATURE",
  "BUS_ARRIVAL",
  "RAINFALL",
  "VARSITY_SPORTS",
] as const;
export const marketCategories = [...categories, "PRESENTATION_DEMO"] as const;
export const campuses = [
  "BUSCH",
  "LIVINGSTON",
  "COLLEGE_AVE",
  "COOK_DOUGLASS",
  "OTHER",
] as const;
export const money = z.string().regex(/^(0|[1-9]\d{0,15})$/);
export const buyInput = z
  .object({
    environmentId: z.uuid(),
    marketId: z.uuid(),
    side: z.enum(["YES", "NO"]),
    quantity: z.number().int().min(1).max(1000),
    maxCostMicros: money,
    idempotencyKey: z.string().min(8).max(100),
  })
  .strict();
export type BuyInput = z.infer<typeof buyInput>;
export const sellInput = z
  .object({
    environmentId: z.uuid(), marketId: z.uuid(), side: z.enum(["YES", "NO"]),
    quantity: z.number().int().min(1).max(1000), minProceedsMicros: money,
    idempotencyKey: z.string().min(8).max(100),
  })
  .strict();
export type SellInput = z.infer<typeof sellInput>;
export const ruleSchema = z.object({
  canonicalizationVersion: z.literal("rutgers-v1"),
  yesCondition: z.string().min(10).max(1000),
  provider: z.string().min(1),
  externalEventId: z.string().min(1),
  windowStart: z.iso.datetime(),
  windowEnd: z.iso.datetime(),
  cutoff: z.iso.datetime(),
  units: z.string(),
  rounding: z.string(),
  finality: z.literal("FINAL"),
  missingPolicy: z.literal("PENDING_THEN_VOID"),
  voidAfter: z.iso.datetime(),
  cancellationPolicy: z.literal("VOID"),
  tiePolicy: z.enum(["NO", "VOID"]),
  postponementPolicy: z.enum(["VOID", "WAIT_48H_THEN_VOID"]),
  threshold: z.number().optional(),
  comparison: z.enum(["GT", "GTE", "LTE", "TRUE"]).default("TRUE"),
  automation: z
    .object({
      type: z.enum(["temperature", "football", "basketball", "bus"]),
      version: z.number().int().positive(),
      settings: z.record(z.string(), z.json()),
    })
    .optional(),
});
export type Rule = z.infer<typeof ruleSchema>;
export const evidenceSchema = z.object({
  provider: z.string(),
  externalEventId: z.string(),
  observedAt: z.iso.datetime(),
  receivedAt: z.iso.datetime(),
  isFinal: z.boolean(),
  sourceUrl: z.url(),
  normalizedData: z.object({
    units: z.string(),
    value: z.number().optional(),
    result: z.boolean().optional(),
    cancelled: z.boolean().optional(),
    missing: z.boolean().optional(),
    channelsChecked: z.array(z.string()).optional(),
    finalScore: z.string().max(300).optional(),
  }),
  rawPayload: z.record(z.string(), z.unknown()),
});
export type ProviderEvidence = z.infer<typeof evidenceSchema>;
export interface BusSnapshot {
  source: string;
  isSimulated: boolean;
  observedAt: string;
  receivedAt: string;
  vehicles: {
    id: string;
    routeId: string;
    latitude: number;
    longitude: number;
    heading?: number;
    updatedAt: string;
  }[];
  stops: { id: string; name: string; latitude: number; longitude: number }[];
  routeGeometry?: [number, number][];
  etaSeconds?: number;
}
export interface PublicEvent {
  id: string;
  marketId: string;
  version: string;
  kind: string;
  occurredAt: string;
  yesPrice: string;
  tradeAmountMicros: string;
  payload: Record<string, unknown>;
}
export interface PublicMarket {
  id: string;
  environmentId: string;
  slug: string;
  title: string;
  description: string;
  category: (typeof marketCategories)[number];
  status: string;
  opensAt: string;
  closesAt: string;
  expectedResolutionAt: string;
  yesPrice: string;
  yesShares: string;
  noShares: string;
  volumeMicros: string;
  version: string;
  sourceUrl: string;
  provider: string;
  ruleHash: string;
  ruleVersion: number;
  resolutionRule: Rule;
  context: Record<string, unknown>;
}
export interface History {
  events: PublicEvent[];
  throughVersion: string;
  source: string;
  interval: string;
  from: string;
  to: string;
  truncated: boolean;
}
export interface EnvironmentView {
  id: string;
  key: string;
  kind: "LIVE" | "DEMO";
  virtualNow: string | null;
  runState: string;
  speed: number;
}
export const json = (value: unknown) =>
  JSON.stringify(value, (_key, v) =>
    typeof v === "bigint" ? v.toString() : v,
  );
