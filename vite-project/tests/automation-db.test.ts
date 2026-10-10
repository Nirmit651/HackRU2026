import { describe, it, expect, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { db } from "../server/db";
import {
  configure,
  reconcileAutomation,
  handleJob,
} from "../server/automation";
import { claim, executeOne } from "../server/automation/queue";
import { generateWeather, monitorWeather } from "../server/automation/weather";
import {
  demoEnvironment,
  demoTime,
  runAutomationDemo,
} from "../server/automation/demo";
import { dayInterval, add } from "../server/automation/core";
import { buy, grantWallet, reconcile } from "../server/engine";
import { demoStep } from "../server/demo";
afterAll(() => db.$disconnect());
describe("automation PostgreSQL invariants", () => {
  it("legacy demo runner does not inject category fixtures into automation scenarios", async () => {
    const env = await demoEnvironment(),
      c = await configure(env.id, "temperature", true, {});
    await generateWeather(c, { mean: 65, raw: { synthetic: true } });
    await db.environment.update({
      where: { id: env.id },
      data: { runState: "RUNNING" },
    });
    await demoStep(env.id);
    expect(
      await db.settlement.count({ where: { environmentId: env.id } }),
    ).toBe(0);
    expect(
      (await db.market.findFirstOrThrow({ where: { environmentId: env.id } }))
        .status,
    ).toBe("OPEN");
    await db.environment.update({
      where: { id: env.id },
      data: { runState: "PAUSED" },
    });
  });
  it("missing hours stay pending and eventually refund via VOID", async () => {
    const env = await demoEnvironment(),
      config = await configure(env.id, "temperature", true, {});
    await generateWeather(config, { mean: 65, raw: { synthetic: true } });
    const m = await db.market.findFirstOrThrow({
        where: { environmentId: env.id },
      }),
      { start, end } = dayInterval("2026-10-11");
    await db.weatherObservation.create({
      data: {
        environmentId: env.id,
        station: "KSMQ",
        sourceId: "only-one-hour",
        observedAt: start,
        temperatureF: 99,
        quality: "V",
      },
    });
    await demoTime(env.id, add(end, 7200));
    await monitorWeather(m);
    expect(await db.settlement.count({ where: { marketId: m.id } })).toBe(0);
    await demoTime(env.id, add(end, 36 * 3600));
    await monitorWeather(m);
    expect(
      (await db.settlement.findUniqueOrThrow({ where: { marketId: m.id } }))
        .outcome,
    ).toBe("VOID");
  });
  it("insufficient treasury rolls back market and maker creation", async () => {
    const start = new Date("2026-10-10T16:00:00Z");
    const env = await db.environment.create({
      data: {
        key: randomUUID(),
        kind: "DEMO",
        initialSupplyMicros: 1n,
        virtualNow: start,
        simulatedStartAt: start,
      },
    });
    await db.wallet.create({
      data: {
        environmentId: env.id,
        kind: "TREASURY",
        openingBalanceMicros: 1n,
        balanceMicros: 1n,
      },
    });
    const c = await configure(env.id, "temperature", true, {});
    await expect(
      generateWeather(c, { mean: 65, raw: { synthetic: true } }),
    ).rejects.toThrow();
    expect(await db.market.count({ where: { environmentId: env.id } })).toBe(0);
    expect(
      await db.wallet.count({
        where: { environmentId: env.id, kind: "MARKET_MAKER" },
      }),
    ).toBe(0);
  });
  it("browser roles cannot read operational tables", async () => {
    const roles = await db.$queryRaw<
      { exists: boolean }[]
    >`SELECT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') AS exists`;
    if (!roles[0].exists) return;
    await expect(
      db.$transaction(async (tx) => {
        await tx.$executeRaw`SET LOCAL ROLE anon`;
        await tx.automationJob.findMany();
      }),
    ).rejects.toThrow();
    const permission = await db.$queryRaw<
      { allowed: boolean }[]
    >`SELECT has_table_privilege('scarlet_runtime','automation_jobs','SELECT,INSERT,UPDATE') AS allowed`;
    expect(permission[0].allowed).toBe(true);
  });
  it("concurrent generation funds once, frozen forecast, missing enqueue repaired, expired claim recovered, settlement pays once", async () => {
    const env = await demoEnvironment(),
      config = await configure(env.id, "temperature", true, {});
    await Promise.all(
      Array.from({ length: 6 }, () =>
        generateWeather(config, { mean: 65, raw: { synthetic: true } }),
      ),
    );
    const markets = await db.market.findMany({
      where: { environmentId: env.id },
    });
    expect(markets).toHaveLength(1);
    const m = markets[0];
    expect(
      await db.transfer.count({
        where: { environmentId: env.id, kind: "MARKET_FUNDING" },
      }),
    ).toBe(1);
    await generateWeather(config, { mean: 90, raw: { synthetic: true } });
    expect(
      (await db.market.findUniqueOrThrow({ where: { id: m.id } })).ruleHash,
    ).toBe(m.ruleHash);
    const profile = await db.profile.create({
      data: {
        kind: "HUMAN",
        authUserId: randomUUID(),
        handle: randomUUID(),
        displayName: "Automation tester",
      },
    });
    await grantWallet(profile.id, env.id);
    await buy(
      { profileId: profile.id, role: "HUMAN" },
      {
        environmentId: env.id,
        marketId: m.id,
        side: "NO",
        quantity: 10,
        maxCostMicros: "1000000000",
        idempotencyKey: randomUUID(),
      },
    );
    expect(
      await db.automationJob.count({
        where: { environmentId: env.id, kind: "MONITOR" },
      }),
    ).toBe(0);
    await reconcileAutomation(env.id);
    expect(
      await db.automationJob.count({
        where: { environmentId: env.id, kind: "MONITOR" },
      }),
    ).toBe(1);
    // Simulate process death after claim. A new claimant reclaims after lease expiry.
    const job = await db.automationJob.findFirstOrThrow({
      where: { environmentId: env.id, kind: "MONITOR" },
    });
    await db.automationJob.update({
      where: { id: job.id },
      data: {
        status: "PROCESSING",
        leaseToken: randomUUID(),
        leaseUntil: new Date(0),
        attempts: 1,
      },
    });
    let recovered = false;
    for (let i = 0; i < 6; i++) {
      const c = await claim();
      if (!c) break;
      if (c.id === job.id) recovered = true;
      await db.automationJob.update({
        where: { id: c.id },
        data: { status: "DONE", leaseUntil: null },
      });
    }
    expect(recovered).toBe(true);
    const { start, end } = dayInterval("2026-10-11");
    await db.weatherObservation.createMany({
      data: Array.from({ length: 24 }, (_, i) => ({
        environmentId: env.id,
        station: "KSMQ",
        sourceId: String(i),
        observedAt: add(start, i * 3600),
        temperatureF: 65,
        quality: "V",
      })),
    });
    await demoTime(env.id, add(end, 7200));
    await Promise.all([monitorWeather(m), monitorWeather(m)]);
    await handleJob(job);
    await monitorWeather(m);
    expect(
      (await db.settlement.findUniqueOrThrow({ where: { marketId: m.id } }))
        .outcome,
    ).toBe("NO");
    expect(await db.payout.count({ where: { marketId: m.id } })).toBe(1);
    expect((await reconcile(env.id)).ok).toBe(true);
  }, 30000);
  it("deterministic scenarios use real factory and settlement services", async () => {
    const result = await runAutomationDemo();
    expect(result.reconciliation.ok).toBe(true);
    expect(
      result.markets.filter((m) => m.title.includes("average temperature")),
    ).toHaveLength(1);
    expect(
      result.markets.filter((m) => m.title.includes("Rutgers beat")),
    ).toHaveLength(1);
    expect(
      result.markets.filter((m) => m.title.includes("bus return")),
    ).toHaveLength(2);
    expect(
      result.markets.find((m) => m.title.includes("bus yes"))?.settlement
        ?.outcome,
    ).toBe("YES");
    expect(
      result.markets.find((m) => m.title.includes("bus no"))?.settlement
        ?.outcome,
    ).toBe("NO");
    expect(
      result.markets.find((m) => m.title.includes("bus stale"))?.settlement
        ?.outcome,
    ).toBe("VOID");
  }, 60000);
  it("durable worker handler executes persisted monitoring and disabling does not abandon it", async () => {
    const env = await demoEnvironment(),
      c = await configure(env.id, "temperature", true, {});
    await generateWeather(c, { mean: 65, raw: { synthetic: true } });
    await configure(env.id, "temperature", false, {});
    const m = await db.market.findFirstOrThrow({
        where: { environmentId: env.id },
      }),
      { start, end } = dayInterval("2026-10-11");
    await db.weatherObservation.createMany({
      data: Array.from({ length: 24 }, (_, i) => ({
        environmentId: env.id,
        station: "KSMQ",
        sourceId: String(i),
        observedAt: add(start, i * 3600),
        temperatureF: 66,
        quality: "V",
      })),
    });
    await demoTime(env.id, add(end, 7200));
    await reconcileAutomation(env.id);
    expect(
      await db.automationState.count({
        where: { environmentId: env.id, kind: "HEARTBEAT" },
      }),
    ).toBe(0);
    for (let i = 0; i < 10; i++) {
      if (await db.settlement.count({ where: { marketId: m.id } })) break;
      await executeOne(handleJob);
    }
    expect(
      (await db.settlement.findUniqueOrThrow({ where: { marketId: m.id } }))
        .outcome,
    ).toBe("YES");
    expect(
      (
        await db.automationJob.findUniqueOrThrow({
          where: {
            environmentId_key: {
              environmentId: env.id,
              key: `monitor:${m.id}`,
            },
          },
        })
      ).status,
    ).toBe("DONE");
  });
});
