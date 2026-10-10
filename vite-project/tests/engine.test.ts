import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { createLive, createMarket } from "../server/markets";
import { ruleSchema } from "../shared/contracts";
import { db, transaction, lockWallets } from "../server/db";
import {
  newDemo,
  setDemoTime,
  fixture,
  replay,
  demoStep,
} from "../server/demo";
import {
  buy,
  sell,
  grantWallet,
  settle,
  reconcile,
  lifecycle,
  transfer,
} from "../server/engine";
let env: Awaited<ReturnType<typeof newDemo>>,
  market: Awaited<ReturnType<typeof db.market.findFirstOrThrow>>,
  profile: Awaited<ReturnType<typeof db.profile.create>>;
beforeAll(async () => {
  env = await newDemo(4, `test-${randomUUID()}`);
  market = await db.market.findFirstOrThrow({
    where: { environmentId: env.id, category: "TEMPERATURE" },
  });
  profile = await db.profile.create({
    data: {
      kind: "HUMAN",
      authUserId: randomUUID(),
      handle: randomUUID(),
      displayName: "Test human",
    },
  });
}, 30000);
afterAll(async () => {
  await db.$disconnect();
});
const order = (
  key = randomUUID(),
  quantity = 10,
  side: "YES" | "NO" = "YES",
) => ({
  environmentId: env.id,
  marketId: market.id,
  side,
  quantity,
  maxCostMicros: "1000000000",
  idempotencyKey: key,
});
const actor = () => ({ profileId: profile.id, role: "HUMAN" as const });
describe("PostgreSQL financial invariants", () => {
  it("concurrent wallet grants happen exactly once", async () => {
    const wallets = await Promise.all(
      Array.from({ length: 12 }, () => grantWallet(profile.id, env.id)),
    );
    expect(new Set(wallets.map((w) => w.id)).size).toBe(1);
    expect(wallets[0].balanceMicros).toBe(1000000000n);
    expect(
      await db.transfer.count({
        where: { toWalletId: wallets[0].id, kind: "STARTING_GRANT" },
      }),
    ).toBe(1);
  });
  it("identical retries charge once and conflicting reuse fails", async () => {
    const input = order();
    const results = await Promise.all(
      Array.from({ length: 10 }, () => buy(actor(), input)),
    );
    expect(new Set(results.map((r) => r.trade.id)).size).toBe(1);
    await expect(
      buy(actor(), { ...input, quantity: 11 }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });
  it("allows adding to the held side but not opening the opposite side", async () => {
    const e = await newDemo(),
      m = await db.market.findFirstOrThrow({ where: { environmentId: e.id, category: "TEMPERATURE" } });
    await grantWallet(profile.id, e.id);
    await buy(actor(), { ...order(), environmentId: e.id, marketId: m.id, side: "YES" });
    await expect(buy(actor(), { ...order(), environmentId: e.id, marketId: m.id, side: "YES" }))
      .resolves.toMatchObject({ trade: { side: "YES", action: "BUY" } });
    await expect(buy(actor(), { ...order(), environmentId: e.id, marketId: m.id, side: "NO" }))
      .rejects.toMatchObject({ code: "OPPOSITE_POSITION" });
  });
  it("serializes simultaneous spending without negative balances", async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, () => buy(actor(), order(randomUUID(), 200))),
    );
    expect(results.some((r) => r.status === "rejected")).toBe(true);
    expect(results.some((r) => r.status === "fulfilled")).toBe(true);
    expect((await reconcile(env.id)).ok).toBe(true);
  });
  it("rejects runner impersonation and cross-environment requests", async () => {
    await expect(
      buy({ ...actor(), role: "RUNNER", environmentId: env.id }, order()),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    const other = await newDemo();
    await grantWallet(profile.id, other.id);
    await expect(
      buy(actor(), { ...order(), environmentId: other.id }),
    ).rejects.toMatchObject({ code: "ENVIRONMENT_MISMATCH" });
  });
  it("rolls back on slippage with ledger and outbox unchanged", async () => {
    const before = await reconcile(env.id),
      events = await db.marketEvent.count({ where: { marketId: market.id } });
    await expect(
      buy(actor(), { ...order(), maxCostMicros: "0" }),
    ).rejects.toMatchObject({ code: "SLIPPAGE_EXCEEDED" });
    expect(await reconcile(env.id)).toEqual(before);
    expect(await db.marketEvent.count({ where: { marketId: market.id } })).toBe(
      events,
    );
  });
  it("sells held shares, credits cash, and moves the price back down", async () => {
    const position = await db.position.findUniqueOrThrow({
        where: { marketId_walletId: { marketId: market.id, walletId: (await grantWallet(profile.id, env.id)).id } },
      }),
      before = await db.market.findUniqueOrThrow({ where: { id: market.id } }),
      quantity = Number(position.yesShares > 10n ? 10n : position.yesShares);
    expect(quantity).toBeGreaterThan(0);
    const result = await sell(actor(), {
      environmentId: env.id, marketId: market.id, side: "YES", quantity,
      minProceedsMicros: "1", idempotencyKey: randomUUID(),
    });
    expect(result.trade.action).toBe("SELL");
    expect(result.wallet.balanceMicros).toBeGreaterThan(0n);
    expect(result.market.yesShares).toBe(before.yesShares - BigInt(quantity));
    expect(result.market.yesPrice.lessThan(before.yesPrice)).toBe(true);
    expect(await db.transfer.count({ where: { referenceId: result.trade.id, kind: "SALE" } })).toBe(1);
    expect((await reconcile(env.id)).ok).toBe(true);
  });
  it("uses cutoff clock and retrieves committed retries after closing", async () => {
    const bot = await db.profile.findFirstOrThrow({
        where: { kind: "BOT", wallets: { some: { environmentId: env.id } } },
      }),
      input = order(),
      a = { profileId: bot.id, role: "RUNNER" as const, environmentId: env.id };
    const first = await buy(a, input);
    await setDemoTime(env.id, market.closesAt);
    await expect(buy(a, order())).rejects.toMatchObject({
      code: "MARKET_CLOSED",
    });
    expect((await buy(a, input)).trade.id).toBe(first.trade.id);
  });
  it("settles YES once and rejects conflicting evidence", async () => {
    await setDemoTime(env.id, new Date(+market.opensAt + 180000));
    const evidence = fixture(market, new Date(+market.opensAt + 180000));
    const results = await Promise.all([
      settle(market.id, evidence),
      settle(market.id, evidence),
    ]);
    expect(results[0].id).toBe(results[1].id);
    await expect(
      settle(market.id, {
        ...evidence,
        normalizedData: { units: "F", value: 40 },
      }),
    ).rejects.toMatchObject({ code: "SETTLEMENT_CONFLICT" });
    expect((await reconcile(env.id)).ok).toBe(true);
  });
  it("replays the ordered log to identical economic totals", async () => {
    const result = await replay(env.id);
    expect(result.equal).toBe(true);
    expect(result.reconciliation.ok).toBe(true);
  }, 30000);
  it("pays NO and refunds VOID costs, recording zero losing payouts", async () => {
    for (const outcome of ["NO", "VOID"]) {
      const e = await newDemo(),
        m = await db.market.findFirstOrThrow({
          where: { environmentId: e.id, category: "TEMPERATURE" },
        });
      await grantWallet(profile.id, e.id);
      await buy(actor(), {
        ...order(),
        environmentId: e.id,
        marketId: m.id,
        side: "YES",
      });
      await buy(actor(), {
        ...order(),
        environmentId: e.id,
        marketId: m.id,
        side: "NO",
      });
      await setDemoTime(e.id, new Date(+m.opensAt + 180000));
      const ev = fixture(m, new Date(+m.opensAt + 180000));
      ev.normalizedData =
        outcome === "NO"
          ? { units: "F", value: 40 }
          : { units: "F", cancelled: true };
      const s = await settle(m.id, ev);
      expect(s.outcome).toBe(outcome);
      expect((await reconcile(e.id)).ok).toBe(true);
    }
  }, 30000);
  it("worker trades use the engine and pause holds virtual time", async () => {
    const e = await newDemo();
    await db.environment.update({
      where: { id: e.id },
      data: { runState: "RUNNING" },
    });
    await demoStep(e.id);
    expect(await db.demoAction.count({ where: { environmentId: e.id } })).toBe(
      1,
    );
    await db.environment.update({
      where: { id: e.id },
      data: { runState: "PAUSED" },
    });
    const before = await db.environment.findUniqueOrThrow({
      where: { id: e.id },
    });
    await demoStep(e.id);
    expect(
      (await db.environment.findUniqueOrThrow({ where: { id: e.id } }))
        .virtualNow,
    ).toEqual(before.virtualNow);
    expect((await reconcile(e.id)).ok).toBe(true);
  });
  it("a failure after debiting rolls back balances and transfers", async () => {
    const wallets = await db.wallet.findMany({
      where: { environmentId: env.id, kind: "USER" },
      take: 2,
    });
    const before = await reconcile(env.id);
    await expect(
      transaction(async (tx) => {
        await lockWallets(
          tx,
          wallets.map((w) => w.id),
        );
        await transfer(
          tx,
          env.id,
          wallets[0].id,
          wallets[1].id,
          1n,
          "TRADE",
          randomUUID(),
          "rollback-test",
          new Date(),
        );
        throw new Error("Injected downstream failure");
      }),
    ).rejects.toThrow("Injected downstream failure");
    expect(await reconcile(env.id)).toEqual(before);
  });
  it("LIVE cutoff is checked after waiting for the market lock", async () => {
    const e = await createLive(`live-test-${randomUUID()}`);
    await grantWallet(profile.id, e.id);
    const open = new Date(Date.now() - 10000),
      close = new Date(Date.now() + 1000),
      end = new Date(Date.now() + 60000);
    const rule = ruleSchema.parse({
      canonicalizationVersion: "rutgers-v1",
      yesCondition: "Final authorized observation is true.",
      provider: "manual",
      externalEventId: "clock-test",
      windowStart: new Date(+close + 1000).toISOString(),
      windowEnd: end.toISOString(),
      cutoff: close.toISOString(),
      units: "boolean",
      rounding: "none",
      finality: "FINAL",
      missingPolicy: "PENDING_THEN_VOID",
      voidAfter: end.toISOString(),
      cancellationPolicy: "VOID",
      tiePolicy: "NO",
      postponementPolicy: "VOID",
    });
    const m = await createMarket({
      environmentId: e.id,
      slug: "clock-test",
      title: "Authoritative clock lock race",
      description: "test",
      category: "CONCERT",
      opensAt: open.toISOString(),
      closesAt: close.toISOString(),
      expectedResolutionAt: end.toISOString(),
      sourceUrl: "https://example.com/official",
      resolutionRule: rule,
    });
    await lifecycle(m.id, "OPEN");
    let signal!: () => void;
    const locked = new Promise<void>((r) => {
      signal = r;
    });
    const blocker = db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM markets WHERE id=${m.id}::uuid FOR UPDATE`;
      signal();
      await tx.$queryRaw`SELECT pg_sleep(1.1)::text`;
    });
    await locked;
    await expect(
      buy(actor(), { ...order(), environmentId: e.id, marketId: m.id }),
    ).rejects.toMatchObject({ code: "MARKET_CLOSED" });
    await blocker;
    expect((await reconcile(e.id)).ok).toBe(true);
  });
  it("freezes rules and blocks direct anonymous reads/mutations", async () => {
    await expect(
      db.market.update({
        where: { id: market.id },
        data: { ruleHash: "tampered" },
      }),
    ).rejects.toThrow();
    const tables = await db.$queryRaw<
      { relrowsecurity: boolean }[]
    >`SELECT relrowsecurity FROM pg_class WHERE relname IN ('wallets','trades','market_events')`;
    expect(tables.every((t) => t.relrowsecurity)).toBe(true);
  });
});
