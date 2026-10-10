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
  type Telemetry,
  type Visit,
} from "./bus-state";

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
// Reads the teammate's authoritative pipeline; this is not another RUBus poller.
export async function consumePipeline(config: AutomationConfig) {
  const s = settingsSchema.parse(config.settings),
    at = await nowFor(config.environmentId);
  ensure(s.stops.length > 0, "MISSING_VERIFIED_STOP_CONFIGURATION");
  ensure(s.sourceVerifiedLive, "BUS_SOURCE_NOT_VERIFIED_LIVE");
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
