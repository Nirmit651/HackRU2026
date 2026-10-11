import { randomUUID } from "node:crypto";
import { clock, db, ensure, lockMarket, lockWallets, transaction } from "./db";
import { appendEvent, buy, grantWallet, sell, settle, transfer } from "./engine";
import { hash } from "./math";
import { createLive } from "./markets";
import type { ProviderEvidence } from "../shared/contracts";

const BOT_NAMES = ["ScarletFox", "KnightWatcher", "RaritanWhale", "CampusPulse", "RUQuant", "KnightShift", "RaritanBull", "ScarletSignal", "CollegeAveTrader", "BuschBull", "LivingstonLine", "JerseyMomentum"];
const STRATEGIES = ["CASUAL", "CASUAL", "CASUAL", "CASUAL", "CASUAL", "CASUAL", "MOMENTUM", "MOMENTUM", "MOMENTUM", "CONTRARIAN", "CONTRARIAN", "WHALE"];

export function timerYesSignal(elapsedSeconds: number) {
  const t = Math.max(0, Math.min(60, elapsedSeconds));
  const lerp = (a: number, b: number, p: number) => a + (b - a) * p;
  if (t < 15) return lerp(.5, .55, t / 15);
  if (t < 35) return lerp(.55, .68, (t - 15) / 20);
  if (t < 50) return lerp(.68, .86, (t - 35) / 15);
  if (t < 57) return lerp(.86, .96, (t - 50) / 7);
  return lerp(.96, .995, (t - 57) / 3);
}
export function presentationOutcome(deadlineAt: Date, finishedAt?: Date | null) {
  return finishedAt && finishedAt < deadlineAt ? "NO" as const : "YES" as const;
}
export const presentationEventId = (runId: string) => `presentation-${runId}`;
export const presentationFundingKey = (runId: string) => `fund:presentation:${runId}`;

const now = () => new Date();
export const presentationRuleFor = (opensAt: Date, closesAt: Date, externalEventId = "presentation-demo") => ({
  canonicalizationVersion: "rutgers-v1" as const,
  yesCondition: "No valid Finish presentation action is recorded before the 60.000-second deadline.",
  provider: "presentation-timer-v1",
  externalEventId,
  windowStart: opensAt.toISOString(), windowEnd: closesAt.toISOString(), cutoff: closesAt.toISOString(),
  units: "boolean", rounding: "Server clock comparison at 60.000 seconds.", finality: "FINAL" as const,
  missingPolicy: "PENDING_THEN_VOID" as const, voidAfter: new Date(+closesAt + 86_400_000).toISOString(),
  cancellationPolicy: "VOID" as const, tiePolicy: "NO" as const, postponementPolicy: "VOID" as const,
  comparison: "TRUE" as const,
});

export async function createPresentationDemo() {
  const active = await db.presentationDemoRun.findFirst({
    where: { status: { in: ["READY", "RUNNING", "PAUSED"] } },
    include: { market: true }, orderBy: { createdAt: "desc" },
  });
  if (active) {
    // A not-yet-started demo is safe to refresh to the current wording before
    // any order or settlement commitment exists.
    if (active.status === "READY" && active.market.status === "DRAFT") {
      const externalEventId = presentationEventId(active.id);
      const rule = presentationRuleFor(active.market.opensAt, active.market.closesAt, externalEventId);
      const market = await db.market.update({
        where: { id: active.marketId },
        data: {
          title: "Will this presentation last more than 60 seconds?",
          description: "YES resolves when the timer reaches 60 seconds without an early Finish presentation action. NO resolves when Finish presentation is recorded before 60 seconds.",
          externalEventId,
          resolutionRule: rule,
          ruleHash: hash(rule),
        },
      });
      return { ...active, market, creationReplayed: true };
    }
    return { ...active, creationReplayed: true };
  }
  let env = await db.environment.findFirst({ where: { kind: "LIVE" }, orderBy: { createdAt: "desc" } });
  if (!env) env = await createLive(`presentation-${randomUUID().slice(0, 8)}`);
  const createdAt = now(), provisionalDeadline = new Date(+createdAt + 3_600_000), runId = randomUUID(), rule = presentationRuleFor(createdAt, provisionalDeadline, presentationEventId(runId));
  const market = await transaction(async (tx) => {
    const treasury = await tx.wallet.findFirstOrThrow({ where: { environmentId: env!.id, kind: "TREASURY" } });
    const maker = await tx.wallet.create({ data: { environmentId: env!.id, kind: "MARKET_MAKER" } });
    await lockWallets(tx, [treasury.id, maker.id]);
    await transfer(tx, env!.id, treasury.id, maker.id, 100_000_000n, "MARKET_FUNDING", presentationFundingKey(runId), maker.id, createdAt);
    return tx.market.create({ data: { environmentId: env!.id, slug: `presentation-demo-${runId.slice(0, 12)}`, title: "Will this presentation last more than 60 seconds?", description: "YES resolves when the timer reaches 60 seconds without an early Finish presentation action. NO resolves when Finish presentation is recorded before 60 seconds. Prices and volume come only from committed simulated and participant orders.", category: "PRESENTATION_DEMO", status: "DRAFT", opensAt: createdAt, closesAt: provisionalDeadline, expectedResolutionAt: provisionalDeadline, resolutionRule: rule, ruleHash: hash(rule), provider: rule.provider, sourceUrl: "https://scarlet.market/presentation-demo-timer", externalEventId: presentationEventId(runId), context: { presentationDemo: true, durationSeconds: 60, simulated: true }, marketMakerWalletId: maker.id, liquidityBMicros: 100_000_000n } });
  });
  const run = await db.presentationDemoRun.create({ data: { id: runId, marketId: market.id, environmentId: env.id, seed: Math.floor(Math.random() * 2_147_483_647) } });
  for (let i = 0; i < BOT_NAMES.length; i++) {
    const profile = await db.profile.upsert({ where: { handle: `presentation-${run.id}-${i}` }, create: { handle: `presentation-${run.id}-${i}`, displayName: BOT_NAMES[i], kind: "BOT", campus: "BUSCH" }, update: {} });
    await grantWallet(profile.id, env.id);
    await db.simulationBotState.create({ data: { runId: run.id, botProfileId: profile.id, marketId: market.id, strategy: STRATEGIES[i], stateJson: { name: BOT_NAMES[i] } } });
  }
  return { ...(await db.presentationDemoRun.findUniqueOrThrow({ where: { id: run.id }, include: { market: true } })), creationReplayed: false };
}

export async function presentationStatus(marketId: string) {
  return db.presentationDemoRun.findUniqueOrThrow({ where: { marketId }, include: { market: true } });
}

/** Archives a completed presentation market and removes its disposable bot
 * orchestration. Ledger and price-event rows remain immutable audit history. */
export async function cleanupPresentationDemo(marketId: string) {
  return transaction(async (tx) => {
    const run = await tx.presentationDemoRun.findUniqueOrThrow({ where: { marketId }, include: { market: true } });
    ensure(run.status === "COMPLETED" && !!run.outcome, "PRESENTATION_NOT_COMPLETE", 409);
    ensure(run.market.category === "PRESENTATION_DEMO" && ["RESOLVED", "VOIDED"].includes(run.market.status), "PRESENTATION_NOT_SETTLED", 409);

    await tx.simulationDecision.deleteMany({ where: { runId: run.id } });
    await tx.simulationBotState.deleteMany({ where: { runId: run.id } });
    await tx.presentationDemoRun.delete({ where: { id: run.id } });
    await tx.marketArchive.upsert({
      where: { marketId },
      create: { marketId, reason: "completed_presentation_demo" },
      update: {},
    });
    return { archived: true, marketId };
  });
}

export async function startPresentation(marketId: string) {
  const run = await transaction(async (tx) => {
    const run = await tx.presentationDemoRun.findUniqueOrThrow({ where: { marketId } });
    if (run.startedAt) return run;
    const market = await lockMarket(tx, marketId), startedAt = await clock(tx, market.environmentId), deadlineAt = new Date(+startedAt + 60_000), externalEventId = presentationEventId(run.id), rule = presentationRuleFor(startedAt, deadlineAt, externalEventId);
    ensure(market.status === "DRAFT", "INVALID_TRANSITION", 409);
    const updated = await tx.market.update({ where: { id: marketId }, data: { opensAt: startedAt, closesAt: deadlineAt, expectedResolutionAt: deadlineAt, resolutionRule: rule, ruleHash: hash(rule), externalEventId, status: "OPEN", version: { increment: 1 } } });
    await appendEvent(tx, updated, "OPENED", startedAt, { presentationDemo: true, startedAt: startedAt.toISOString(), deadlineAt: deadlineAt.toISOString() });
    return tx.presentationDemoRun.update({ where: { id: run.id }, data: { status: "RUNNING", startedAt, deadlineAt, workflowRunId: `db-runner:${run.id}` } });
  });
  return run;
}

function evidence(run: { id: string; marketId: string; startedAt: Date | null; deadlineAt: Date | null; finishedAt: Date | null }, outcome: "YES" | "NO", checkedAt: Date): ProviderEvidence {
  const elapsed = run.startedAt ? Math.max(0, checkedAt.getTime() - run.startedAt.getTime()) : 0;
  return { provider: "presentation-timer-v1", externalEventId: presentationEventId(run.id), observedAt: (outcome === "NO" ? run.finishedAt! : run.deadlineAt!).toISOString(), receivedAt: checkedAt.toISOString(), isFinal: true, sourceUrl: "https://scarlet.market/presentation-demo-timer", normalizedData: { units: "boolean", result: outcome === "YES", channelsChecked: ["Server-authoritative presentation timer"] }, rawPayload: { runId: run.id, startedAt: run.startedAt?.toISOString(), deadlineAt: run.deadlineAt?.toISOString(), finishedAt: run.finishedAt?.toISOString(), checkedAt: checkedAt.toISOString(), elapsedMilliseconds: elapsed, outcome } };
}

export async function finishPresentation(marketId: string) {
  const result = await transaction(async (tx) => {
    const r = await tx.presentationDemoRun.findUniqueOrThrow({ where: { marketId } });
    ensure(r.startedAt && r.deadlineAt, "TIMER_NOT_STARTED", 409);
    const checkedAt = await clock(tx, r.environmentId);
    if (r.outcome) return { run: r, checkedAt };
    ensure(checkedAt < r.deadlineAt, "PRESENTATION_DEADLINE_PASSED", 409);
    const outcome = presentationOutcome(r.deadlineAt, checkedAt);
    await lockMarket(tx, marketId);
    return { run: await tx.presentationDemoRun.update({ where: { id: r.id }, data: { finishedAt: r.finishedAt ?? checkedAt, outcome, status: "COMPLETED" } }), checkedAt };
  });
  const run = result.run;
  if (!run.outcome || !run.startedAt || !run.deadlineAt) return run;
  const at = result.checkedAt;
  await settle(marketId, evidence(run, run.outcome as "YES" | "NO", at), undefined, { allowEarly: true, resolverVersion: "presentation-timer-v1", receiptExtra: { presentationDemo: { runId: run.id, startedAt: run.startedAt.toISOString(), deadlineAt: run.deadlineAt.toISOString(), finishedAt: run.finishedAt?.toISOString() ?? null, resolutionMethod: "Presentation Demo Timer" } } }).catch(async (error) => {
    if ((error as { code?: string }).code !== "SETTLEMENT_CONFLICT") throw error;
  });
  return presentationStatus(marketId);
}

async function resolvePresentationDeadline(marketId: string) {
  const result = await transaction(async (tx) => {
    const r = await tx.presentationDemoRun.findUniqueOrThrow({ where: { marketId } });
    ensure(r.startedAt && r.deadlineAt, "TIMER_NOT_STARTED", 409);
    const checkedAt = await clock(tx, r.environmentId);
    if (r.outcome || checkedAt < r.deadlineAt) return { run: r, checkedAt };
    await lockMarket(tx, marketId);
    return { run: await tx.presentationDemoRun.update({ where: { id: r.id }, data: { outcome: presentationOutcome(r.deadlineAt), status: "COMPLETED" } }), checkedAt };
  });
  const run = result.run;
  if (!run.outcome || !run.startedAt || !run.deadlineAt) return run;
  await settle(marketId, evidence(run, run.outcome as "YES" | "NO", result.checkedAt), undefined, { allowEarly: true, resolverVersion: "presentation-timer-v1", receiptExtra: { presentationDemo: { runId: run.id, startedAt: run.startedAt.toISOString(), deadlineAt: run.deadlineAt.toISOString(), finishedAt: null, resolutionMethod: "Presentation Demo Timer" } } }).catch((error) => { if ((error as { code?: string }).code !== "SETTLEMENT_CONFLICT") throw error; });
  return presentationStatus(marketId);
}

function seeded(runId: string, tick: number, salt: number) {
  let n = salt; for (const c of runId) n = Math.imul(n ^ c.charCodeAt(0), 16777619); n = Math.imul(n ^ tick, 2246822519); return ((n >>> 0) % 10_000) / 10_000;
}

export async function tickPresentationRun(runId: string, forceWhale = false) {
  const run = await db.presentationDemoRun.findUniqueOrThrow({ where: { id: runId }, include: { market: true } });
  if (run.status !== "RUNNING" || !run.startedAt || !run.deadlineAt) return run;
  const at = now();
  if (at >= run.deadlineAt) return resolvePresentationDeadline(run.marketId);
  const elapsed = (+at - +run.startedAt) / 1000, signal = timerYesSignal(elapsed);
  const bots = await db.simulationBotState.findMany({ where: { runId }, include: { bot: true }, orderBy: { botProfileId: "asc" } });
  for (let index = 0; index < bots.length; index++) {
    const state = bots[index], chance = forceWhale && state.strategy === "WHALE" ? 1 : elapsed >= 57 ? .9 : state.strategy === "WHALE" ? (elapsed > 42 && elapsed < 55 ? .18 : .02) : .36;
    const tick = Math.floor(elapsed * 4);
    if (seeded(runId, tick, index + 1) > chance) continue;
    const market = await db.market.findUniqueOrThrow({ where: { id: run.marketId } });
    const position = await db.position.findFirst({ where: { marketId: run.marketId, wallet: { profileId: state.botProfileId } } });
    const heldSide = (position?.yesShares ?? 0n) > 0n ? "YES" : (position?.noShares ?? 0n) > 0n ? "NO" : null;
    const desired = elapsed >= 57 || seeded(runId, tick, index + 99) < signal ? "YES" : "NO";
    const quantity = state.strategy === "WHALE" ? 30 + Math.floor(seeded(runId, tick, 333) * 41) : state.strategy === "MOMENTUM" ? 8 + Math.floor(seeded(runId, tick, 444) * 13) : state.strategy === "CONTRARIAN" ? 3 + Math.floor(seeded(runId, tick, 555) * 8) : 2 + Math.floor(seeded(runId, tick, 666) * 7);
    const key = `presentation:${runId}:${state.botProfileId}:${tick}`;
    const priorDecision = await db.simulationDecision.findUnique({ where: { runId_botProfileId_sequence: { runId, botProfileId: state.botProfileId, sequence: tick } } });
    if (priorDecision) continue;
    let sellTradeId: string | undefined, buyTradeId: string | undefined, volume = 0n, action = "SKIP", skipReason: string | undefined;
    try {
      if (heldSide && heldSide !== desired) {
        const held = heldSide === "YES" ? position!.yesShares : position!.noShares;
        const sale = await sell({ profileId: state.botProfileId, role: "RUNNER", environmentId: run.environmentId }, { environmentId: run.environmentId, marketId: run.marketId, side: heldSide, quantity: Number(held), minProceedsMicros: "1", idempotencyKey: `${key}:sell` });
        sellTradeId = sale.trade.id; volume += sale.trade.costMicros; action = "SWITCH";
      }
      const refreshed = await db.position.findFirst({ where: { marketId: run.marketId, wallet: { profileId: state.botProfileId } } });
      const opposite = desired === "YES" ? refreshed?.noShares ?? 0n : refreshed?.yesShares ?? 0n;
      if (opposite === 0n) {
        const order = await buy({ profileId: state.botProfileId, role: "RUNNER", environmentId: run.environmentId }, { environmentId: run.environmentId, marketId: run.marketId, side: desired, quantity, maxCostMicros: "1000000000", idempotencyKey: `${key}:buy` });
        buyTradeId = order.trade.id; volume += order.trade.costMicros; action = action === "SWITCH" ? action : "BUY";
      }
    } catch (e) { skipReason = (e as { code?: string }).code ?? "REJECTED"; }
    await db.simulationDecision.upsert({ where: { runId_botProfileId_sequence: { runId, botProfileId: state.botProfileId, sequence: tick } }, create: { runId, botProfileId: state.botProfileId, sequence: tick, elapsedMilliseconds: Math.floor(elapsed * 1000), timerSignal: signal, priceBefore: market.yesPrice, heldSideBefore: heldSide, desiredSide: desired, action, quantity, sellTradeId, buyTradeId, skipReason, idempotencyKeys: { sell: `${key}:sell`, buy: `${key}:buy` }, completedAt: now() }, update: {} });
    if (buyTradeId || sellTradeId) await db.presentationDemoRun.update({ where: { id: runId }, data: { botTradeCount: { increment: (buyTradeId ? 1 : 0) + (sellTradeId ? 1 : 0) }, botVolumeMicros: { increment: volume }, lastBotActivityAt: now() } });
  }
  return presentationStatus(run.marketId);
}

export async function tickPresentationRuns() {
  const runs = await db.presentationDemoRun.findMany({ where: { status: "RUNNING" }, select: { id: true } });
  for (const run of runs) await tickPresentationRun(run.id);
}
