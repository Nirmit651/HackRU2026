import { db, transaction, lockEnvironment, lockMarket, ensure } from "../db";
import { lifecycle, appendEvent } from "../engine";
import { ruleSchema } from "../../shared/contracts";
import type { AutomationConfig, Market } from "../../generated/prisma/client";
import {
  settingsSchema,
  nowFor,
  add,
  iso,
  rule,
  slug,
  createAutomatedMarket,
  finish,
  close,
} from "./core";
import {
  advanceVisit,
  emptyVisit,
  meters,
  type Telemetry,
  type Visit,
} from "./bus-state";

const DECISION_WINDOW_SECONDS = 30;
type ScheduledObservation = Telemetry;
type ScheduledEvaluation =
  | { result: boolean; observation: ScheduledObservation; reason: string }
  | { void: string };

function scheduledInvalid(
  rows: ScheduledObservation[],
  settings: { maxGapSeconds: number; latenessSeconds: number },
) {
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (+new Date(row.receivedAt) - +new Date(row.sourceAt) > settings.latenessSeconds * 1000)
      return "STALE_SOURCE_OBSERVATION";
    if (i && +new Date(row.sourceAt) === +new Date(rows[i - 1].sourceAt) &&
      (row.latitude !== rows[i - 1].latitude || row.longitude !== rows[i - 1].longitude || row.routeId !== rows[i - 1].routeId))
      return "CONFLICTING_SOURCE_OBSERVATION";
  }
  return null;
}

export function evaluateScheduledMarket(
  market: {
    kind: "arrival_by_deadline" | "presence_at_time";
    routeId: string;
    stop: { latitude: number; longitude: number };
    opensAt: string;
    deadline?: string;
    targetTime?: string;
  },
  rows: ScheduledObservation[],
  settings: { enterMeters: number; maxGapSeconds: number; latenessSeconds: number },
): ScheduledEvaluation | null {
  const invalid = scheduledInvalid(rows, settings);
  if (invalid) return { void: invalid };
  if (rows.some((row) => row.routeId !== market.routeId)) return { void: "ROUTE_IDENTITY_CHANGED" };
  if (market.kind === "presence_at_time") {
    const target = +new Date(market.targetTime!);
    const row = rows.find((x) => +new Date(x.sourceAt) >= target && +new Date(x.sourceAt) <= target + DECISION_WINDOW_SECONDS * 1000);
    if (!row) return null;
    return {
      result: meters(market.stop, row) <= settings.enterMeters,
      observation: row,
      reason: "FIRST_QUALIFYING_SOURCE_OBSERVATION_AFTER_TARGET",
    };
  }
  const deadline = +new Date(market.deadline!);
  const arrival = rows.find((row) => +new Date(row.sourceAt) <= deadline && meters(market.stop, row) <= settings.enterMeters);
  if (arrival) return { result: true, observation: arrival, reason: "ENTERED_STOP_RADIUS_BY_DEADLINE" };
  const first = rows[0], last = rows.at(-1);
  if (!first || !last || +new Date(first.sourceAt) > +new Date(market.opensAt) + settings.maxGapSeconds * 1000 || +new Date(last.sourceAt) < deadline)
    return null;
  for (let i = 1; i < rows.length; i++)
    if (+new Date(rows[i].sourceAt) - +new Date(rows[i - 1].sourceAt) > settings.maxGapSeconds * 1000)
      return null;
  return { result: false, observation: last, reason: "CONTINUOUS_SOURCE_TIME_COVERAGE_WITHOUT_ARRIVAL" };
}

async function generateScheduledMarkets(config: AutomationConfig, at: Date) {
  const s = settingsSchema.parse(config.settings);
  for (const scheduled of s.scheduledMarkets) {
    if (at < new Date(scheduled.opensAt) || at >= new Date(scheduled.closesAt)) continue;
    const stop = s.stops.find((candidate) => candidate.id === scheduled.stopId)!;
    const timing = scheduled.kind === "arrival_by_deadline" ? scheduled.deadline! : scheduled.targetTime!;
    const question = scheduled.kind === "arrival_by_deadline"
      ? `Will ${scheduled.routeId} bus ${scheduled.vehicleId} reach ${stop.name} by ${timing}?`
      : `Will ${scheduled.routeId} bus ${scheduled.vehicleId} be at ${stop.name} at ${timing}?`;
    const condition = scheduled.kind === "arrival_by_deadline"
      ? `YES if a valid ${s.sourceSystem} source-timestamped vehicle_position for vehicle ${scheduled.vehicleId} on route ${scheduled.routeId} enters the frozen ${s.enterMeters}m stop radius by ${timing}. NO only with continuous source-time coverage from market open through the deadline, no gap over ${s.maxGapSeconds}s, and no qualifying arrival. Otherwise VOID after ${scheduled.voidAfter}.`
      : `YES/NO is determined by the first valid ${s.sourceSystem} source-timestamped vehicle_position for vehicle ${scheduled.vehicleId} on route ${scheduled.routeId} at or within ${DECISION_WINDOW_SECONDS}s after ${timing}: YES inside, NO outside the frozen ${s.enterMeters}m stop radius. This does not claim literal physical presence at an unobserved instant; missing, stale, conflicting, or wrong-route evidence VOIDs.`;
    const settings = {
      ...scheduled,
      stop,
      enterMeters: s.enterMeters,
      maxGapSeconds: s.maxGapSeconds,
      latenessSeconds: s.latenessSeconds,
      sourceSystem: s.sourceSystem,
      algorithm: `bus-scheduled-${scheduled.kind}-v1`,
      decisionWindowSeconds: scheduled.kind === "presence_at_time" ? DECISION_WINDOW_SECONDS : undefined,
    };
    await createAutomatedMarket({
      environmentId: config.environmentId,
      generatorKey: `bus-scheduled:${scheduled.id}`,
      templateVersion: 1,
      slug: slug(`bus-scheduled:${scheduled.id}`),
      title: question,
      description: condition,
      category: "BUS_ARRIVAL",
      opensAt: scheduled.opensAt,
      closesAt: scheduled.closesAt,
      expectedResolutionAt: timing,
      resolutionRule: rule("bus", s.sourceSystem, scheduled.id, new Date(scheduled.closesAt), new Date(scheduled.opensAt), new Date(timing), new Date(scheduled.voidAfter), settings, condition),
      sourceUrl: stop.sourceUrl,
      context: { routeId: scheduled.routeId, stopId: stop.id, stopName: stop.name, deadline: timing, vehicleId: scheduled.vehicleId },
    });
  }
}

export async function consumeTelemetry(
  config: AutomationConfig,
  observation: Telemetry,
  simulated = false,
) {
  const at = await nowFor(config.environmentId),
    s = settingsSchema.parse(config.settings);
  const visit = await transaction(async (tx) => {
    const env = await lockEnvironment(tx, config.environmentId);
    ensure(!simulated || env.kind === "DEMO", "SIMULATED_LIVE_TELEMETRY");
    ensure(simulated || env.kind === "LIVE", "LIVE_TELEMETRY_IN_DEMO");
    const key = `vehicle:${observation.provider}:${observation.vehicleId}`;
    const row = await tx.automationState.findUnique({
      where: { environmentId_key: { environmentId: env.id, key } },
    });
    let previous = row ? (row.data as unknown as Visit) : emptyVisit();
    // Keep the finished visit immutable; a new visit must first observe outside.
    if (
      ["ENDED", "QUALIFIED"].includes(previous.state) ||
      (previous.state === "UNCERTAIN" &&
        previous.visitId &&
        +at > +new Date(previous.t0!) + 720000)
    )
      previous = { ...emptyVisit(), last: previous.last };
    const value = advanceVisit(previous, observation, s, at);
    await tx.automationState.upsert({
      where: { environmentId_key: { environmentId: env.id, key } },
      create: {
        environmentId: env.id,
        key,
        kind: "BUS_VEHICLE",
        data: value as never,
      },
      update: { data: value as never, version: { increment: 1 } },
    });
    if (value.visitId)
      await tx.automationState.upsert({
        where: {
          environmentId_key: {
            environmentId: env.id,
            key: `visit:${value.visitId}`,
          },
        },
        create: {
          environmentId: env.id,
          key: `visit:${value.visitId}`,
          kind: "BUS_VISIT",
          data: value as never,
        },
        update: { data: value as never, version: { increment: 1 } },
      });
    if (
      value.visitId &&
      ["ENDED", "QUALIFIED", "UNCERTAIN"].includes(value.state)
    ) {
      const existing = await tx.market.findUnique({
        where: {
          environmentId_generatorKey: {
            environmentId: env.id,
            generatorKey: `bus-dwell:${value.visitId}`,
          },
        },
      });
      if (existing) {
        const locked = await lockMarket(tx, existing.id);
        const status = value.state === "UNCERTAIN" ? "PAUSED" : "CLOSED";
        if (
          locked.status === "OPEN" ||
          (locked.status === "PAUSED" && status === "CLOSED")
        ) {
          const updated = await tx.market.update({
            where: { id: locked.id },
            data: { status, version: { increment: 1 } },
          });
          await appendEvent(tx, updated, "STATUS_CHANGED", at, {
            status,
            reason: value.reason ?? value.state,
          });
        }
      }
    }
    return value;
  });
  if (!visit.visitId) return;
  const generatorKey = `bus-dwell:${visit.visitId}`,
    start = new Date(visit.t0!),
    cutoff = add(start, 60),
    target = add(start, 600),
    deadline = add(target, 120);
  let market = await db.market.findUnique({
    where: {
      environmentId_generatorKey: {
        environmentId: config.environmentId,
        generatorKey,
      },
    },
  });
  if (!market && config.enabled && visit.state === "DWELLING" && at < cutoff) {
    const condition = `YES: bus ${observation.vehicleId} remains stationary at ${visit.stop!.name} for at least 600 seconds from ${visit.t0}. NO: confirmed movement begins before 600 seconds. Two fresh samples confirm arrival/departure; fixed ${s.anchorMeters}m anchor, ${s.enterMeters}/${s.exitMeters}m geofences, maximum gap ${s.maxGapSeconds}s, lateness ${s.latenessSeconds}s. Uncertain evidence pauses trading and VOID after 120 seconds of grace.`;
    const r = rule(
      "bus",
      simulated ? `demo-${observation.provider}` : observation.provider,
      visit.visitId,
      cutoff,
      start,
      deadline,
      deadline,
      {
        ...s,
        visitId: visit.visitId,
        vehicleId: observation.vehicleId,
        stop: visit.stop,
        t0: visit.t0,
        target: iso(target),
      },
      condition,
    );
    market = await createAutomatedMarket({
      environmentId: config.environmentId,
      generatorKey,
      templateVersion: 1,
      slug: slug(generatorKey),
      title: `Will bus ${observation.vehicleId} make a 10-minute stop at ${visit.stop!.name}?`,
      description: condition,
      category: "BUS_ARRIVAL",
      opensAt: iso(at),
      closesAt: iso(cutoff),
      expectedResolutionAt: iso(add(target, s.latenessSeconds)),
      resolutionRule: r,
      sourceUrl: visit.stop!.sourceUrl,
      context: {
        routeId: observation.routeId,
        stopId: visit.stop!.id,
        stopName: visit.stop!.name,
        deadline: iso(target),
        vehicleId: observation.vehicleId,
        stop: visit.stop,
        t0: visit.t0,
        resolutionTarget: iso(target),
        visitId: visit.visitId,
      },
    });
    await db.automationState.update({
      where: {
        environmentId_key: {
          environmentId: config.environmentId,
          key: `visit:${visit.visitId}`,
        },
      },
      data: { marketId: market.id },
    });
  }
  if (market) await monitorBus(market);
}
export async function monitorBus(m: Market) {
  const at = await nowFor(m.environmentId),
    r = ruleSchema.parse(m.resolutionRule),
    settings = r.automation!.settings;
  if (settings.kind === "arrival_by_deadline" || settings.kind === "presence_at_time")
    return monitorScheduledBus(m, settings, at);
  const row = await db.automationState.findUnique({
    where: {
      environmentId_key: {
        environmentId: m.environmentId,
        key: `visit:${settings.visitId}`,
      },
    },
  });
  const v = row?.data as unknown as Visit | undefined;
  const target = new Date(String(settings.target)),
    deadline = new Date(r.voidAfter);
  if (v) {
    const gap =
      !v.last ||
      +at - +new Date(v.last.sourceAt) >
        Number(settings.maxGapSeconds) * 1000 +
          Number(settings.latenessSeconds) * 1000;
    if (
      v.state === "UNCERTAIN" ||
      (gap && !["ENDED", "QUALIFIED"].includes(v.state))
    ) {
      if (m.status === "OPEN") {
        try {
          await lifecycle(m.id, "PAUSED");
        } catch {
          /* concurrent close is harmless */
        }
      }
    }
    if (v.state === "ENDED") {
      await close(m);
      if (+new Date(v.departureAt!) < +target) {
        await finish(
          m,
          { units: "boolean", result: false },
          { visit: v },
          new Date(v.last!.sourceAt),
        );
        return;
      }
    }
    if (
      v.state === "QUALIFIED" &&
      at >= add(new Date(v.qualifiedAt!), Number(settings.latenessSeconds))
    ) {
      await finish(
        m,
        { units: "boolean", result: true },
        { visit: v },
        new Date(v.qualifiedAt!),
      );
      return;
    }
  }
  if (at >= deadline) {
    await finish(
      m,
      { units: "boolean", missing: true },
      { visit: v ?? null, reason: "INSUFFICIENT_CONTINUOUS_EVIDENCE" },
      at,
    );
    return;
  }
  return add(at, 10);
}
async function monitorScheduledBus(m: Market, settings: Record<string, unknown>, at: Date) {
  const kind = settings.kind as "arrival_by_deadline" | "presence_at_time";
  const stop = settings.stop as { latitude: number; longitude: number };
  const decision = new Date(String(kind === "arrival_by_deadline" ? settings.deadline : settings.targetTime));
  const rows = await db.$queryRaw<{
    source_system: string; vehicle_id: string; source_measured_at: Date; retrieved_at: Date;
    latitude: number; longitude: number; route_id: string | null; source_observation_id: string | null;
  }[]>`
    SELECT source_system,vehicle_id,source_measured_at,retrieved_at,latitude,longitude,route_id,source_observation_id
    FROM public.bus_observations
    WHERE source_system=${String(settings.sourceSystem)} AND vehicle_id=${String(settings.vehicleId)}
      AND is_valid AND observation_kind='vehicle_position' AND measurement_time_basis='source'
      AND source_measured_at >= ${new Date(String(settings.opensAt))} AND source_measured_at <= ${kind === "presence_at_time" ? add(decision, DECISION_WINDOW_SECONDS) : decision}
      AND latitude IS NOT NULL AND longitude IS NOT NULL
    ORDER BY source_measured_at,id`;
  const observations = rows.map((row) => ({
    provider: row.source_system, vehicleId: row.vehicle_id, sourceAt: iso(row.source_measured_at), receivedAt: iso(row.retrieved_at),
    latitude: row.latitude, longitude: row.longitude, routeId: row.route_id, sequenceId: row.source_observation_id ?? undefined,
  })).filter((row, index, all) => index === 0 ||
    row.sourceAt !== all[index - 1].sourceAt || row.latitude !== all[index - 1].latitude ||
    row.longitude !== all[index - 1].longitude || row.routeId !== all[index - 1].routeId);
  const result = evaluateScheduledMarket({
    kind, routeId: String(settings.routeId), stop, opensAt: String(settings.opensAt),
    deadline: settings.deadline as string | undefined, targetTime: settings.targetTime as string | undefined,
  }, observations, { enterMeters: Number(settings.enterMeters), maxGapSeconds: Number(settings.maxGapSeconds), latenessSeconds: Number(settings.latenessSeconds) });
  if (result && "result" in result) {
    await finish(m, { units: "boolean", result: result.result }, { algorithm: settings.algorithm, observation: result.observation, reason: result.reason, frozen: settings }, new Date(result.observation.sourceAt));
    return;
  }
  const windowEnded = kind === "presence_at_time" && at >= add(decision, DECISION_WINDOW_SECONDS);
  if ((result && "void" in result) || windowEnded || at >= new Date(String(settings.voidAfter))) {
    await finish(m, { units: "boolean", missing: true }, { algorithm: settings.algorithm, reason: result && "void" in result ? result.void : "INSUFFICIENT_QUALIFYING_SOURCE_EVIDENCE", frozen: settings }, at);
    return;
  }
  return add(at, 10);
}
// Reads the teammate's authoritative pipeline; this is not another RUBus poller.
export async function consumePipeline(config: AutomationConfig) {
  const s = settingsSchema.parse(config.settings),
    at = await nowFor(config.environmentId);
  ensure(s.stops.length > 0, "MISSING_VERIFIED_STOP_CONFIGURATION");
  ensure(s.sourceVerifiedLive, "BUS_SOURCE_NOT_VERIFIED_LIVE");
  if (config.enabled) await generateScheduledMarkets(config, at);
  const rows = await db.$queryRaw<
    {
      source_system: string;
      vehicle_id: string;
      source_measured_at: Date;
      retrieved_at: Date;
      latitude: number;
      longitude: number;
      route_id: string | null;
      source_observation_id: string | null;
    }[]
  >`
    SELECT source_system,vehicle_id,source_measured_at,retrieved_at,latitude,longitude,route_id,source_observation_id
    FROM public.bus_observations WHERE source_system=${s.sourceSystem} AND is_valid AND observation_kind='vehicle_position' AND measurement_time_basis='source'
      AND source_measured_at >= ${add(at, -120)} AND source_measured_at <= ${add(at, -s.latenessSeconds)}
      AND latitude IS NOT NULL AND longitude IS NOT NULL
    ORDER BY source_measured_at,id LIMIT 5000`;
  for (const o of rows)
    await consumeTelemetry(config, {
      provider: o.source_system,
      vehicleId: o.vehicle_id,
      sourceAt: iso(o.source_measured_at),
      receivedAt: iso(o.retrieved_at),
      latitude: o.latitude,
      longitude: o.longitude,
      routeId: o.route_id,
      sequenceId: o.source_observation_id ?? undefined,
    });
  return {
    created: 0,
    skipped: 0,
    observations: rows.length,
    reason: rows.length
      ? "SOURCE_TIMESTAMPS_ACCEPTED"
      : "NO_FRESH_SOURCE_OBSERVATIONS",
  };
}
