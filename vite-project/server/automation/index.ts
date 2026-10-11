import { db } from "../db";
import { lifecycle } from "../engine";
import { ruleSchema } from "../../shared/contracts";
import type { AutomationJob } from "../../generated/prisma/client";
import { types, settingsSchema, nowFor, add, iso, finish } from "./core";
import { enqueue, executeOne } from "./queue";
import { generateSports, monitorSports, reviewSports } from "./sports";
import { consumePipeline, monitorBus } from "./bus";
import { ensureNextCollegeAveBreakMarket } from "../bus-showcase";
import { randomUUID } from "node:crypto";

export async function configure(
  environmentId: string,
  type: (typeof types)[number],
  enabled: boolean,
  settings: unknown,
) {
  const parsed = settingsSchema.parse(settings);
  return db.automationConfig.upsert({
    where: { environmentId_type: { environmentId, type } },
    create: {
      environmentId,
      type,
      enabled,
      settings: parsed,
      nextRunAt: await nowFor(environmentId),
    },
    update: { enabled, settings: parsed, version: { increment: 1 } },
  });
}
export async function reconcileAutomation(
  environmentId?: string,
  worker = false,
) {
  const envs = await db.environment.findMany({
    where: environmentId ? { id: environmentId } : {},
  });
  for (const env of envs) {
    const at = await nowFor(env.id);
    // The successor market is created by the existing worker, never by the browser.
    // A persisted retry state makes empty/all-arrived feeds wait ten minutes.
    if (env.kind === "LIVE") await ensureNextCollegeAveBreakMarket(env.id);
    const configs = await db.automationConfig.findMany({
      where: { environmentId: env.id },
    });
    for (const c of configs) {
      if (
        c.enabled ||
        (c.type === "bus" &&
          (await db.market.count({
            where: {
              environmentId: env.id,
              generatorKey: { not: null },
              category: "BUS_ARRIVAL",
              status: { in: ["OPEN", "PAUSED", "CLOSED"] },
            },
          })))
      ) {
        await enqueue(
          env.id,
          `generator:${c.id}`,
          "GENERATE",
          { configId: c.id },
          c.nextRunAt,
        );
        await db.automationJob.updateMany({
          where: {
            environmentId: env.id,
            key: `generator:${c.id}`,
            status: "DONE",
          },
          data: { status: "PENDING", runAt: c.nextRunAt },
        });
      }
    }
    const markets = await db.market.findMany({
      where: {
        environmentId: env.id,
        generatorKey: { not: null },
        status: { notIn: ["RESOLVED", "VOIDED"] },
      },
    });
    if (env.kind === "LIVE") {
      const settled = await db.market.findMany({
        where: {
          environmentId: env.id,
          generatorKey: { not: null },
          category: "VARSITY_SPORTS",
          status: { in: ["RESOLVED", "VOIDED"] },
          settlement: { settledAt: { gte: add(at, -7 * 86400) } },
        },
        include: { settlement: true },
      });
      for (const m of settled)
        await enqueue(
          env.id,
          `review:${m.id}`,
          "REVIEW",
          { marketId: m.id },
          add(m.settlement!.settledAt, 86400),
        );
    }
    for (let m of markets) {
      if (m.status === "DRAFT") {
        if (at < m.closesAt) m = await lifecycle(m.id, "OPEN");
        else {
          await lifecycle(m.id, "CLOSED");
          await finish(
            m,
            {
              units: ruleSchema.parse(m.resolutionRule).units,
              cancelled: true,
            },
            { reason: "RECOVERED_DRAFT_AFTER_CUTOFF_NO_TRADING" },
            at,
          );
          continue;
        }
      }
      if (["OPEN", "PAUSED"].includes(m.status) && at >= m.closesAt)
        m = await lifecycle(m.id, "CLOSED");
      const r = ruleSchema.parse(m.resolutionRule);
      const visit =
        r.automation?.type === "bus"
          ? await db.automationState.findUnique({
              where: {
                environmentId_key: {
                  environmentId: env.id,
                  key: `visit:${r.automation.settings.visitId}`,
                },
              },
            })
          : null;
      await enqueue(
        env.id,
        `monitor:${m.id}`,
        "MONITOR",
        {
          marketId: m.id,
          visitId: r.automation?.settings.visitId ?? null,
          expectedVersion: visit?.version ?? 0,
        },
        at,
      );
    }
    if (worker)
      await db.automationState.upsert({
        where: {
          environmentId_key: { environmentId: env.id, key: "worker-heartbeat" },
        },
        create: {
          environmentId: env.id,
          key: "worker-heartbeat",
          kind: "HEARTBEAT",
          data: { at: iso(at) },
        },
        update: { data: { at: iso(at) } },
      });
  }
}
export async function handleJob(job: AutomationJob): Promise<Date | void> {
  const payload = job.payload as {
    configId?: string;
    marketId?: string;
    visitId?: string;
    expectedVersion?: number;
  };
  if (job.kind === "COORDINATE_BUS") {
    const environmentId = job.environmentId;
    const market = await ensureNextCollegeAveBreakMarket(environmentId);
    if (market) await enqueue(environmentId, `monitor:${market.id}`, "MONITOR", { marketId: market.id }, await nowFor(environmentId));
    // Cron owns the minute-scale wake-up. Returning no next run prevents an
    // idle job from competing with the coordinator between cron invocations.
    return;
  }
  if (job.kind === "GENERATE") {
    const c = await db.automationConfig.findUniqueOrThrow({
        where: { id: payload.configId },
      }),
      at = await nowFor(c.environmentId);
    if (!c.enabled && c.type !== "bus") return;
    const env = await db.environment.findUniqueOrThrow({
      where: { id: c.environmentId },
    });
    if (env.kind === "DEMO") return; // Demo script injects deterministic inputs into the same handlers.
    const run = await db.automationState.create({
      data: {
        environmentId: c.environmentId,
        key: `run:${randomUUID()}`,
        kind: "RUN",
        data: { type: c.type, startedAt: iso(at), status: "RUNNING" },
      },
    });
    try {
      const summary =
        c.type === "bus" ? await consumePipeline(c) : await generateSports(c);
      const next = add(
        at,
        c.type === "bus" ? 5 : 21600,
      );
      await db.automationConfig.update({
        where: { id: c.id },
        data: {
          lastRunAt: at,
          nextRunAt: next,
          summary: { ...summary, errors: 0 },
        },
      });
      await db.automationState.update({
        where: { id: run.id },
        data: {
          data: {
            type: c.type,
            startedAt: iso(at),
            finishedAt: iso(await nowFor(c.environmentId)),
            status: "SUCCEEDED",
            ...summary,
          },
        },
      });
      return next;
    } catch (e) {
      const reason =
        e instanceof Error && /^[A-Z_0-9]+$/.test(e.message)
          ? e.message
          : "PROVIDER_OR_CONFIGURATION_ERROR";
      await db.automationConfig.update({
        where: { id: c.id },
        data: {
          lastRunAt: at,
          summary: { created: 0, skipped: 1, errors: 1, reason },
        },
      });
      await db.automationState.update({
        where: { id: run.id },
        data: {
          data: {
            type: c.type,
            startedAt: iso(at),
            finishedAt: iso(await nowFor(c.environmentId)),
            status: "FAILED",
            reason,
          },
        },
      });
      throw e;
    }
  }
  const m = await db.market.findUniqueOrThrow({
    where: { id: payload.marketId },
  });
  if (job.kind === "REVIEW") {
    await reviewSports(m);
    return;
  }
  if (["RESOLVED", "VOIDED"].includes(m.status)) return;
  const r = ruleSchema.parse(m.resolutionRule);
  if (payload.visitId && payload.visitId !== r.automation?.settings.visitId)
    return;
  if (r.automation?.type === "bus") {
    const visit = await db.automationState.findUnique({
      where: {
        environmentId_key: {
          environmentId: m.environmentId,
          key: `visit:${payload.visitId}`,
        },
      },
    });
    if (visit && visit.version < (payload.expectedVersion ?? 0))
      return add(await nowFor(m.environmentId), 10);
    return monitorBus(m);
  }
  return monitorSports(m);
}
export async function automationTick() {
  await reconcileAutomation(undefined, true);
  for (let i = 0; i < 10; i++) if (!(await executeOne(handleJob))) break;
}
async function archiveTerminalBusCycle(market: Awaited<ReturnType<typeof db.market.findUniqueOrThrow>>) {
  const settlement = await db.settlement.findUnique({ where: { marketId: market.id }, select: { outcome: true } });
  await db.marketArchive.upsert({
    where: { marketId: market.id },
    create: { marketId: market.id, reason: settlement ? `settled_bus_break_${settlement.outcome.toLowerCase()}` : "terminal_bus_break" },
    update: {},
  });
  await ensureNextCollegeAveBreakMarket(market.environmentId);
}
/**
 * Serverless fallback for the existing five-second frozen-bus map request.
 * It advances only that market; it never selects a replacement vehicle. A
 * terminal YES/NO settlement is followed by the normal idempotent successor
 * creation path, while VOID preserves its persisted ten-minute retry.
 */
export async function tickLiveBusMarket(marketId: string) {
  const market = await db.market.findUniqueOrThrow({ where: { id: marketId } });
  if (market.category !== "BUS_ARRIVAL") return market;
  const automation = ruleSchema.parse(market.resolutionRule).automation;
  if (automation?.type !== "bus" || automation.settings.kind !== "next_bus_break") return market;
  if (["RESOLVED", "VOIDED"].includes(market.status)) {
    await archiveTerminalBusCycle(market);
    return market;
  }
  await monitorBus(market);
  const updated = await db.market.findUniqueOrThrow({ where: { id: marketId } });
  if (["RESOLVED", "VOIDED"].includes(updated.status)) await archiveTerminalBusCycle(updated);
  return updated;
}
export async function automationStatus(environmentId: string) {
  const [configs, jobs, heartbeat, unresolved, runs, providerFreshness] =
    await Promise.all([
      db.automationConfig.findMany({ where: { environmentId } }),
      db.automationJob.findMany({
        where: { environmentId, status: { not: "DONE" } },
        orderBy: { updatedAt: "desc" },
        take: 100,
      }),
      db.automationState.findUnique({
        where: {
          environmentId_key: { environmentId, key: "worker-heartbeat" },
        },
      }),
      db.market.count({
        where: {
          environmentId,
          generatorKey: { not: null },
          status: { notIn: ["RESOLVED", "VOIDED"] },
        },
      }),
      db.automationState.findMany({
        where: { environmentId, kind: { in: ["RUN", "REVIEW"] } },
        orderBy: { updatedAt: "desc" },
        take: 20,
        select: { id: true, kind: true, data: true, updatedAt: true },
      }),
      db.automationState.findMany({
        where: { environmentId, kind: { in: ["CACHE", "COOLDOWN"] } },
        orderBy: { updatedAt: "desc" },
        take: 20,
        select: { key: true, kind: true, updatedAt: true },
      }),
    ]);
  return {
    configs,
    jobs,
    heartbeat: heartbeat?.updatedAt ?? null,
    unresolved,
    runs,
    providerFreshness,
  };
}
