import { DateTime } from "luxon";
import { z } from "zod";
import { db, clock, ensure } from "../db";
import { createMarket, createMarketInput } from "../markets";
import { lifecycle, settle } from "../engine";
import { hash } from "../math";
import { ruleSchema, type ProviderEvidence } from "../../shared/contracts";
import type { Market } from "../../generated/prisma/client";

export const zone = "America/New_York";
export const types = ["temperature", "football", "basketball", "bus"] as const;
const scheduledMarketSchema = z
  .object({
    id: z.string().min(1).max(100),
    kind: z.enum(["arrival_by_deadline", "presence_at_time"]),
    vehicleId: z.string().min(1).max(100),
    routeId: z.string().min(1).max(50),
    stopId: z.string().min(1).max(100),
    opensAt: z.iso.datetime(),
    closesAt: z.iso.datetime(),
    targetTime: z.iso.datetime().optional(),
    deadline: z.iso.datetime().optional(),
    voidAfter: z.iso.datetime(),
  })
  .superRefine((m, ctx) => {
    const opens = +new Date(m.opensAt), closes = +new Date(m.closesAt);
    const decision = +(new Date(m.targetTime ?? m.deadline ?? 0));
    if (!(opens < closes && closes <= decision && decision < +new Date(m.voidAfter)))
      ctx.addIssue({ code: "custom", message: "Scheduled market times are not ordered" });
    if (m.kind === "arrival_by_deadline" && !m.deadline)
      ctx.addIssue({ code: "custom", message: "Arrival markets require deadline" });
    if (m.kind === "arrival_by_deadline" && m.targetTime)
      ctx.addIssue({ code: "custom", message: "Arrival markets do not accept targetTime" });
    if (m.kind === "presence_at_time" && !m.targetTime)
      ctx.addIssue({ code: "custom", message: "Presence markets require targetTime" });
    if (m.kind === "presence_at_time" && m.deadline)
      ctx.addIssue({ code: "custom", message: "Presence markets do not accept deadline" });
  });
export const settingsSchema = z
  .object({
    station: z
      .string()
      .regex(/^[A-Z0-9]{3,8}$/)
      .default("KSMQ"),
    stationName: z.string().default("Somerville, Somerset Airport"),
    latitude: z.number().min(-90).max(90).default(40.62),
    longitude: z.number().min(-180).max(180).default(-74.67),
    graceHours: z.number().min(1).max(12).default(2),
    maxWaitHours: z.number().min(12).max(72).default(36),
    horizonDays: z.number().int().min(1).max(60).default(30),
    teamId: z.number().int().positive().optional(),
    provider: z.enum(["ESPN", "CFBD", "CBBD"]).default("ESPN"),
    maxGames: z.number().int().min(1).max(5).default(1),
    marketTypes: z
      .array(z.enum(["win", "team-points", "total-points"]))
      .min(1)
      .max(3)
      .default(["win", "team-points", "total-points"]),
    footballRutgersPointsThreshold: z.number().min(0).max(100).default(24.5),
    footballTotalPointsThreshold: z.number().min(0).max(150).default(48.5),
    basketballRutgersPointsThreshold: z
      .number()
      .min(0)
      .max(150)
      .default(72.5),
    basketballTotalPointsThreshold: z
      .number()
      .min(0)
      .max(300)
      .default(145.5),
    sourceVerifiedLive: z.boolean().default(false),
    sourceSystem: z.string().default("rubus"),
    enterMeters: z.number().positive().default(50),
    exitMeters: z.number().positive().default(75),
    anchorMeters: z.number().positive().default(25),
    maxGapSeconds: z.number().min(10).max(120).default(60),
    latenessSeconds: z.number().min(1).max(30).default(10),
    durationSeconds: z.literal(600).default(600),
    cutoffSeconds: z.literal(60).default(60),
    stops: z
      .array(
        z.object({
          id: z.string(),
          name: z.string(),
          latitude: z.number().min(-90).max(90),
          longitude: z.number().min(-180).max(180),
          sourceUrl: z.url(),
        }),
      )
      .max(200)
      .default([]),
    scheduledMarkets: z.array(scheduledMarketSchema).max(100).default([]),
  })
  .superRefine((s, ctx) => {
    if (s.exitMeters <= s.enterMeters)
      ctx.addIssue({ code: "custom", message: "Exit radius must exceed enter radius" });
    const ids = new Set<string>();
    for (const market of s.scheduledMarkets) {
      if (ids.has(market.id))
        ctx.addIssue({ code: "custom", message: "Scheduled market IDs must be unique" });
      ids.add(market.id);
      if (!s.stops.some((stop) => stop.id === market.stopId))
        ctx.addIssue({
          code: "custom",
          message: `Scheduled market ${market.id} references an unconfigured stop`,
        });
    }
  });
export type Settings = z.infer<typeof settingsSchema>;
export const iso = (at: Date | number) => new Date(at).toISOString();
export const add = (at: Date, seconds: number) =>
  new Date(+at + seconds * 1000);
export function dayInterval(date: string) {
  const start = DateTime.fromISO(date, { zone }).startOf("day");
  ensure(start.isValid, "INVALID_LOCAL_DATE");
  return { start: start.toJSDate(), end: start.plus({ days: 1 }).toJSDate() };
}
export const nowFor = (id: string) => clock(db, id);
export function rule(
  type: (typeof types)[number],
  provider: string,
  event: string,
  cutoff: Date,
  start: Date,
  end: Date,
  deadline: Date,
  settings: Record<string, unknown>,
  condition: string,
) {
  return ruleSchema.parse({
    canonicalizationVersion: "rutgers-v1",
    yesCondition: condition,
    provider,
    externalEventId: event,
    cutoff: iso(cutoff),
    windowStart: iso(start),
    windowEnd: iso(end),
    voidAfter: iso(deadline),
    units: "boolean",
    rounding: "No rounding for comparison",
    finality: "FINAL",
    missingPolicy: "PENDING_THEN_VOID",
    cancellationPolicy: "VOID",
    tiePolicy: "NO",
    postponementPolicy: "VOID",
    automation: { type, version: 1, settings },
  });
}
export async function createAutomatedMarket(
  input: z.input<typeof createMarketInput> & { generatorKey: string },
) {
  const parsed = createMarketInput.parse(input);
  ensure(parsed.resolutionRule.automation, "AUTOMATION_RULE_REQUIRED");
  const market = await createMarket(parsed);
  // A crash after funding leaves a recoverable DRAFT, never another funded market.
  if (
    market.status === "DRAFT" &&
    (await nowFor(market.environmentId)) < market.closesAt
  ) {
    try {
      return {
        ...(await lifecycle(market.id, "OPEN")),
        creationReplayed: market.creationReplayed,
      };
    } catch (error) {
      const current = await db.market.findUniqueOrThrow({
        where: { id: market.id },
      });
      if (current.status !== "DRAFT")
        return { ...current, creationReplayed: market.creationReplayed };
      throw error;
    }
  }
  return market;
}
export const slug = (key: string) => `auto-${hash(key).slice(0, 40)}`;
export async function close(m: Market) {
  if (["OPEN", "PAUSED"].includes(m.status)) {
    try {
      await lifecycle(m.id, "CLOSED");
    } catch {
      const fresh = await db.market.findUniqueOrThrow({ where: { id: m.id } });
      ensure(!["OPEN", "PAUSED"].includes(fresh.status), "CLOSE_FAILED");
    }
  }
}
export async function finish(
  m: Market,
  data: ProviderEvidence["normalizedData"],
  raw: Record<string, unknown>,
  observed: Date,
) {
  if (await db.settlement.findUnique({ where: { marketId: m.id } })) return;
  await close(m);
  const at = await nowFor(m.environmentId);
  const evidence: ProviderEvidence = {
    provider: m.provider,
    externalEventId: m.externalEventId!,
    sourceUrl: m.sourceUrl,
    observedAt: iso(observed),
    receivedAt: iso(at),
    isFinal: true,
    normalizedData: data,
    rawPayload: raw,
  };
  // Persist the exact proposed receipt before settlement. All retries use identical evidence.
  const pending = await db.automationState.upsert({
    where: {
      environmentId_key: {
        environmentId: m.environmentId,
        key: `receipt:${m.id}`,
      },
    },
    create: {
      environmentId: m.environmentId,
      key: `receipt:${m.id}`,
      kind: "RECEIPT",
      data: evidence as never,
    },
    update: {},
  });
  await settle(m.id, pending.data as unknown as ProviderEvidence);
}
