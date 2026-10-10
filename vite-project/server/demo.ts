import { randomUUID } from "node:crypto";
import { db, transaction, lockEnvironment, ensure } from "./db";
import {
  transfer,
  grantWallet,
  lifecycle,
  buy,
  sell,
  settle,
  reconcile,
} from "./engine";
import { hash } from "./math";
import {
  categories,
  ruleSchema,
  type ProviderEvidence,
} from "../shared/contracts";
const start = new Date("2026-10-10T16:00:00.000Z");
export const titles = [
  "Will the demo station reach 75°F?",
  "Will the demo LX reach Livingston on time?",
  "Will the demo station record 0.10 inches of rain?",
  "Will Rutgers win the simulated football game?",
];

// The demo is deterministic for replay, but the order flow is intentionally
// noisy. Each market has a different seeded sentiment so the screen shows a
// useful spread of probabilities instead of six markets hovering at 50%.
function random01(seed: number, tick: number, salt: number) {
  let value =
    (Math.imul(seed ^ salt, 1664525) + 1013904223 + Math.imul(tick, 374761393)) >>>
    0;
  value ^= value >>> 13;
  value = Math.imul(value, 1274126177) >>> 0;
  value ^= value >>> 16;
  return (value >>> 0) / 4294967296;
}

const demoSentiment = [0.82, 0.68, 0.28, 0.76];
export async function newDemo(
  seed = 2026,
  key = `demo-${randomUUID().slice(0, 8)}`,
) {
  const env = await transaction(async (tx) => {
    const e = await tx.environment.create({
      data: {
        key,
        kind: "DEMO",
        initialSupplyMicros: 1_000_000_000_000n,
        seed,
        scenarioVersion: "campus-v1",
        simulatedStartAt: start,
        virtualNow: start,
      },
    });
    await tx.wallet.create({
      data: {
        environmentId: e.id,
        kind: "TREASURY",
        openingBalanceMicros: e.initialSupplyMicros,
        balanceMicros: e.initialSupplyMicros,
      },
    });
    return e;
  });
  for (let i = 0; i < 20; i++) {
    const bot = await db.profile.create({
      data: {
        kind: "BOT",
        handle: `${key}-bot-${i}`,
        displayName: `Sim ${["Scarlet", "Knight", "River", "Maple", "Quarry"][i % 5]} ${i + 1}`,
        campus: ["BUSCH", "LIVINGSTON", "COLLEGE_AVE", "COOK_DOUGLASS"][
          i % 4
        ] as "BUSCH",
      },
    });
    await grantWallet(bot.id, env.id);
  }
  for (let i = 0; i < categories.length; i++) {
    const closesAt = new Date(+start + 120000),
      windowStart = new Date(+start + 121000),
      windowEnd = new Date(+start + 180000),
      voidAfter = new Date(+start + 240000),
      provider = "demo-fixture-v1",
      externalEventId = `campus-v1-${categories[i]}`;
    const rule = ruleSchema.parse({
      canonicalizationVersion: "rutgers-v1",
      yesCondition:
        i === 0
          ? "Observed temperature is at least 75 degrees Fahrenheit."
          : i === 2
            ? "Accumulated rainfall is at least 0.10 inches."
            : "The named synthetic event has a final positive result.",
      provider,
      externalEventId,
      windowStart: windowStart.toISOString(),
      windowEnd: windowEnd.toISOString(),
      cutoff: closesAt.toISOString(),
      units: i === 0 ? "F" : i === 2 ? "in" : "boolean",
      rounding: "Compare the unrounded observed value.",
      finality: "FINAL",
      missingPolicy: "PENDING_THEN_VOID",
      voidAfter: voidAfter.toISOString(),
      cancellationPolicy: "VOID",
      tiePolicy: "NO",
      postponementPolicy: "VOID",
      threshold: i === 0 ? 75 : i === 2 ? 0.1 : undefined,
      comparison: i === 0 || i === 2 ? "GTE" : "TRUE",
    });
    const market = await transaction(async (tx) => {
      await lockEnvironment(tx, env.id);
      const treasury = await tx.wallet.findFirstOrThrow({
          where: { environmentId: env.id, kind: "TREASURY" },
        }),
        maker = await tx.wallet.create({
          data: { environmentId: env.id, kind: "MARKET_MAKER" },
        });
      const m = await tx.market.create({
        data: {
          environmentId: env.id,
          slug: categories[i].toLowerCase(),
          title: titles[i],
          description:
            "Synthetic HackRU scenario. Prices come from actual simulated purchases; outcomes are fixtures.",
          category: categories[i],
          opensAt: start,
          closesAt,
          expectedResolutionAt: windowEnd,
          resolutionRule: rule,
          ruleHash: hash(rule),
          provider,
          sourceUrl: "https://example.invalid/hackru/campus-v1",
          externalEventId,
          context:
            i === 1
              ? {
                  routeId: "LX",
                  stopId: "livingston-plaza",
                  stopName: "Livingston Plaza",
                  deadline: windowEnd.toISOString(),
                }
              : {},
          marketMakerWalletId: maker.id,
        },
      });
      await transfer(
        tx,
        env.id,
        treasury.id,
        maker.id,
        100_000_000n,
        "MARKET_FUNDING",
        `fund:${m.id}`,
        m.id,
        start,
      );
      return m;
    });
    await lifecycle(market.id, "OPEN");
  }
  return env;
}
export async function setDemoTime(environmentId: string, at: Date) {
  return transaction(async (tx) => {
    const env = await lockEnvironment(tx, environmentId);
    ensure(env.kind === "DEMO" && at >= env.virtualNow!, "INVALID_DEMO_CLOCK");
    return tx.environment.update({
      where: { id: environmentId },
      data: { virtualNow: at },
    });
  });
}
export function fixture(
  m: {
    category: string;
    provider: string;
    externalEventId: string | null;
    sourceUrl: string;
  },
  at: Date,
): ProviderEvidence {
  return {
    provider: m.provider,
    externalEventId: m.externalEventId!,
    observedAt: new Date(+start + 150000).toISOString(),
    receivedAt: at.toISOString(),
    isFinal: true,
    sourceUrl: m.sourceUrl,
    normalizedData: {
      units:
        m.category === "TEMPERATURE"
          ? "F"
          : m.category === "RAINFALL"
            ? "in"
            : "boolean",
      ...(m.category === "TEMPERATURE"
        ? { value: 77 }
        : m.category === "RAINFALL"
          ? { value: 0.06 }
          : { result: true }),
      channelsChecked: ["Synthetic official-channel fixture"],
    },
    rawPayload: { fixtureVersion: "campus-v1", synthetic: true },
  };
}
export async function demoStep(environmentId: string, seconds = 1) {
  const env = await transaction(async (tx) => {
    const e = await lockEnvironment(tx, environmentId);
    ensure(e.kind === "DEMO", "FORBIDDEN", 403);
    if (e.runState !== "RUNNING") return null;
    return tx.environment.update({
      where: { id: environmentId },
      data: { virtualNow: new Date(+e.virtualNow! + seconds * 1000 * e.speed) },
    });
  });
  if (!env || env.scenarioVersion !== "campus-v1") return;
  const elapsed = Math.floor(
      (+env.virtualNow! - +env.simulatedStartAt!) / 1000,
    ),
    previousElapsed = Math.max(0, elapsed - seconds * env.speed),
    markets = await db.market.findMany({
      where: { environmentId, generatorKey: null },
      orderBy: { slug: "asc" },
    });
  if (elapsed < 150) {
    const bots = await db.profile.findMany({
      where: { kind: "BOT", wallets: { some: { environmentId } } },
      orderBy: { handle: "asc" },
    });
    // Generate one accepted-order attempt for every virtual second crossed.
    // This keeps 10× playback visually active instead of producing only one
    // trade per real worker tick.
    const firstTradeTick = Math.max(1, previousElapsed + 1);
    const lastTradeTick = Math.min(elapsed, 119);
    for (let tick = firstTradeTick; tick <= lastTradeTick; tick++) {
      const marketIndex = Math.floor(
          random01(env.seed ?? 0, tick, 11) * markets.length,
        ),
        m = markets[marketIndex],
        actor = bots[
          Math.floor(random01(env.seed ?? 0, tick, 23) * bots.length)
        ],
        yesChance = demoSentiment[marketIndex] ?? 0.5,
        side =
          random01(env.seed ?? 0, tick, 37) < yesChance ? ("YES" as const) : ("NO" as const),
        quantity = 1 + Math.floor(random01(env.seed ?? 0, tick, 41) * 12);
      await buy(
        { profileId: actor.id, role: "RUNNER", environmentId },
        {
          environmentId,
          marketId: m.id,
          side,
          quantity,
          maxCostMicros: "100000000",
          idempotencyKey: `demo-bot:${tick}`,
        },
      ).catch((e) => {
        if (!["MARKET_CLOSED", "INSUFFICIENT_FUNDS"].includes(e.code)) throw e;
      });
    }
    if (elapsed >= 120) {
    for (const m of markets)
      if (["OPEN", "PAUSED"].includes(m.status))
        await lifecycle(m.id, "CLOSED");
    }
  }
  if (elapsed >= 150) {
    for (const m of markets)
      if (!["RESOLVED", "VOIDED"].includes(m.status))
        await settle(m.id, fixture(m, env.virtualNow!));
    await db.environment.update({
      where: { id: environmentId },
      data: { runState: "PAUSED" },
    });
  }
}
export async function replay(environmentId: string) {
  const source = await db.environment.findUniqueOrThrow({
    where: { id: environmentId },
  });
  ensure(source.kind === "DEMO", "DEMO_REQUIRED");
  const actions = await db.demoAction.findMany({
      where: { environmentId },
      orderBy: { sequence: "asc" },
    }),
    oldMarkets = await db.market.findMany({ where: { environmentId } });
  const target = await newDemo(source.seed ?? 2026),
    newMarkets = await db.market.findMany({
      where: { environmentId: target.id },
    }),
    profileMap = new Map<string, string>();
  for (const action of actions) {
    let id = profileMap.get(action.actorProfileId);
    if (!id) {
      const profile = await db.profile.findUniqueOrThrow({
        where: { id: action.actorProfileId },
      });
      if (profile.kind === "BOT") {
        const suffix = profile.handle.split("-bot-")[1];
        id = (
          await db.profile.findUniqueOrThrow({
            where: { handle: `${target.key}-bot-${suffix}` },
          })
        ).id;
      } else {
        id = profile.id;
        await grantWallet(id, target.id);
      }
      profileMap.set(profile.id, id);
    }
    await setDemoTime(target.id, action.virtualAt);
    const input = action.input as unknown as Parameters<typeof buy>[1],
      old = oldMarkets.find((m) => m.id === input.marketId)!,
      m = newMarkets.find((m) => m.slug === old.slug)!;
    const p = await db.profile.findUniqueOrThrow({ where: { id } });
    const actor = { profileId: id, role: p.kind === "BOT" ? "RUNNER" as const : "HUMAN" as const, environmentId: target.id };
    if (action.actionType === "SELL")
      await sell(actor, { ...input, environmentId: target.id, marketId: m.id, minProceedsMicros: (input as unknown as { minProceedsMicros: string }).minProceedsMicros });
    else await buy(actor, { ...input, environmentId: target.id, marketId: m.id });
  }
  await setDemoTime(target.id, source.virtualNow!);
  for (const old of oldMarkets) {
    const s = await db.settlement.findUnique({
      where: { marketId: old.id },
      include: { evidence: true },
    });
    const m = newMarkets.find((m) => m.slug === old.slug)!;
    if (s)
      await settle(m.id, {
        provider: s.evidence.provider,
        externalEventId: s.evidence.externalEventId,
        sourceUrl: s.evidence.sourceUrl,
        observedAt: s.evidence.observedAt.toISOString(),
        receivedAt: s.evidence.receivedAt.toISOString(),
        isFinal: s.evidence.isFinal,
        normalizedData: s.evidence
          .normalizedData as ProviderEvidence["normalizedData"],
        rawPayload: s.evidence.rawPayload as Record<string, unknown>,
      });
  }
  const actual = await db.market.findMany({
    where: { environmentId: target.id },
    orderBy: { slug: "asc" },
  });
  return {
    target: target.id,
    actions: actions.length,
    equal: oldMarkets.every((old) => {
      const m = actual.find((m) => m.slug === old.slug)!;
      return (
        old.yesShares === m.yesShares &&
        old.noShares === m.noShares &&
        old.volumeMicros === m.volumeMicros
      );
    }),
    reconciliation: await reconcile(target.id),
  };
}
