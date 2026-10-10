import { randomUUID } from "node:crypto";
import {
  Prisma,
  type Market,
  type TransferKind,
  type MarketEventKind,
} from "../generated/prisma/client";
import {
  buyInput,
  sellInput,
  ruleSchema,
  evidenceSchema,
  type BuyInput,
  type SellInput,
  type ProviderEvidence,
} from "../shared/contracts";
import {
  db,
  transaction,
  lockMarket,
  lockWallets,
  lockEnvironment,
  clock,
  ensure,
  type Tx,
} from "./db";
import { execution, saleExecution, hash, UNIT } from "./math";
export type Actor = {
  profileId: string;
  role: "HUMAN" | "RUNNER";
  environmentId?: string;
};
export async function authorizeActor(
  tx: Tx,
  actor: Actor,
  environmentId: string,
) {
  const profile = await tx.profile.findUniqueOrThrow({
    where: { id: actor.profileId },
  });
  if (actor.role === "RUNNER") {
    const env = await tx.environment.findUniqueOrThrow({
      where: { id: environmentId },
    });
    ensure(
      profile.kind === "BOT" &&
        env.kind === "DEMO" &&
        actor.environmentId === environmentId,
      "FORBIDDEN",
      403,
    );
  } else ensure(profile.kind === "HUMAN", "FORBIDDEN", 403);
  return profile;
}
export async function transfer(
  tx: Tx,
  environmentId: string,
  from: string,
  to: string,
  amount: bigint,
  kind: TransferKind,
  key: string,
  referenceId: string,
  at: Date,
) {
  ensure(amount > 0n && from !== to, "INVALID_TRANSFER");
  const result = await tx.wallet.updateMany({
    where: { id: from, environmentId, balanceMicros: { gte: amount } },
    data: { balanceMicros: { decrement: amount } },
  });
  ensure(result.count === 1, "INSUFFICIENT_FUNDS", 409);
  await tx.wallet.update({
    where: { id: to, environmentId },
    data: { balanceMicros: { increment: amount } },
  });
  return tx.transfer.create({
    data: {
      environmentId,
      fromWalletId: from,
      toWalletId: to,
      amountMicros: amount,
      kind,
      dedupeKey: key,
      referenceType: kind,
      referenceId,
      createdAt: at,
    },
  });
}
export async function appendEvent(
  tx: Tx,
  market: Market,
  kind: MarketEventKind,
  at: Date,
  payload: Prisma.InputJsonValue = {},
  amount = 0n,
  tradeId?: string,
) {
  const e = await tx.marketEvent.create({
    data: {
      environmentId: market.environmentId,
      marketId: market.id,
      version: market.version,
      kind,
      occurredAt: at,
      yesPrice: market.yesPrice,
      tradeAmountMicros: amount,
      tradeId,
      payload,
    },
  });
  await tx.outboxDelivery.create({ data: { marketEventId: e.id } });
  return e;
}
export async function grantWallet(profileId: string, environmentId: string) {
  return transaction(async (tx) => {
    // Environment lock serializes creation/grants and precedes all money locks.
    const env = await lockEnvironment(tx, environmentId);
    const prior = await tx.wallet.findUnique({
      where: { environmentId_profileId: { environmentId, profileId } },
    });
    if (prior) return prior;
    const treasury = await tx.wallet.findFirstOrThrow({
      where: { environmentId, kind: "TREASURY" },
    });
    const wallet = await tx.wallet.create({
      data: { environmentId, profileId, kind: "USER" },
    });
    await lockWallets(tx, [treasury.id, wallet.id]);
    await transfer(
      tx,
      environmentId,
      treasury.id,
      wallet.id,
      env.startingGrantMicros,
      "STARTING_GRANT",
      `grant:${environmentId}:${profileId}`,
      wallet.id,
      await clock(tx, environmentId),
    );
    return tx.wallet.findUniqueOrThrow({ where: { id: wallet.id } });
  });
}
export async function buy(actor: Actor, raw: BuyInput) {
  const input = buyInput.parse(raw),
    requestHash = hash({
      marketId: input.marketId,
      environmentId: input.environmentId,
      side: input.side,
      quantity: input.quantity,
      maxCostMicros: input.maxCostMicros,
    });
  return transaction(async (tx) => {
    await authorizeActor(tx, actor, input.environmentId);
    const wallet = await tx.wallet.findUnique({
      where: {
        environmentId_profileId: {
          environmentId: input.environmentId,
          profileId: actor.profileId,
        },
      },
    });
    ensure(wallet, "WALLET_REQUIRED", 409);
    const lookup = () =>
      tx.trade.findUnique({
        where: {
          walletId_idempotencyKey: {
            walletId: wallet.id,
            idempotencyKey: input.idempotencyKey,
          },
        },
      });
    const replay = async (
      trade: NonNullable<Awaited<ReturnType<typeof lookup>>>,
    ) => {
      ensure(trade.requestHash === requestHash, "IDEMPOTENCY_CONFLICT", 409);
      return {
        trade,
        wallet: await tx.wallet.findUniqueOrThrow({ where: { id: wallet.id } }),
        market: await tx.market.findUniqueOrThrow({
          where: { id: trade.marketId },
        }),
        replayed: true,
      };
    };
    const prior = await lookup();
    if (prior) return replay(prior);
    // DEMO clock changes take this same lock. LIVE markets do not share an environment lock.
    const env = await tx.environment.findUniqueOrThrow({
      where: { id: input.environmentId },
    });
    if (env.kind === "DEMO") await lockEnvironment(tx, env.id);
    const market = await lockMarket(tx, input.marketId);
    ensure(
      market.environmentId === input.environmentId,
      "ENVIRONMENT_MISMATCH",
      403,
    );
    await lockWallets(tx, [wallet.id, market.marketMakerWalletId]);
    const again = await lookup();
    if (again) return replay(again);
    const at = await clock(tx, input.environmentId);
    ensure(
      market.status === "OPEN" && at >= market.opensAt && at < market.closesAt,
      "MARKET_CLOSED",
      409,
    );
    const quote = execution(
      market.yesShares,
      market.noShares,
      market.liquidityBMicros,
      input.side,
      input.quantity,
    );
    ensure(
      quote.costMicros <= BigInt(input.maxCostMicros),
      "SLIPPAGE_EXCEEDED",
      409,
    );
    const id = randomUUID();
    const payment = await transfer(
      tx,
      input.environmentId,
      wallet.id,
      market.marketMakerWalletId,
      quote.costMicros,
      "TRADE",
      `trade:${wallet.id}:${input.idempotencyKey}`,
      id,
      at,
    );
    const updated = await tx.market.update({
      where: { id: market.id },
      data: {
        yesShares: quote.yesShares,
        noShares: quote.noShares,
        yesPrice: quote.yesPriceAfter,
        volumeMicros: { increment: quote.costMicros },
        version: { increment: 1 },
      },
    });
    const delta = {
      yesShares: input.side === "YES" ? BigInt(input.quantity) : 0n,
      noShares: input.side === "NO" ? BigInt(input.quantity) : 0n,
    };
    await tx.position.upsert({
      where: {
        marketId_walletId: { marketId: market.id, walletId: wallet.id },
      },
      create: {
        environmentId: input.environmentId,
        marketId: market.id,
        walletId: wallet.id,
        ...delta,
        totalCostMicros: quote.costMicros,
      },
      update: {
        yesShares: { increment: delta.yesShares },
        noShares: { increment: delta.noShares },
        totalCostMicros: { increment: quote.costMicros },
      },
    });
    const trade = await tx.trade.create({
      data: {
        id,
        environmentId: input.environmentId,
        marketId: market.id,
        walletId: wallet.id,
        side: input.side,
        quantity: BigInt(input.quantity),
        costMicros: quote.costMicros,
        yesPriceBefore: quote.yesPriceBefore,
        yesPriceAfter: quote.yesPriceAfter,
        marketVersion: updated.version,
        idempotencyKey: input.idempotencyKey,
        requestHash,
        paymentTransferId: payment.id,
        createdAt: at,
      },
    });
    await appendEvent(
      tx,
      updated,
      "PRICE_CHANGED",
      at,
      {
        side: input.side,
        quantity: input.quantity,
        isSimulated: env.kind === "DEMO",
      },
      quote.costMicros,
      id,
    );
    if (env.kind === "DEMO") {
      const last = await tx.demoAction.aggregate({
        where: { environmentId: env.id },
        _max: { sequence: true },
      });
      await tx.demoAction.create({
        data: {
          environmentId: env.id,
          sequence: (last._max.sequence ?? 0n) + 1n,
          virtualAt: at,
          actorProfileId: actor.profileId,
          actionType: "BUY",
          input: { ...input },
          resultReference: id,
        },
      });
    }
    return {
      trade,
      wallet: await tx.wallet.findUniqueOrThrow({ where: { id: wallet.id } }),
      market: updated,
      replayed: false,
    };
  });
}
export async function sell(actor: Actor, raw: SellInput) {
  const input = sellInput.parse(raw),
    requestHash = hash({ action: "SELL", marketId: input.marketId, environmentId: input.environmentId, side: input.side, quantity: input.quantity, minProceedsMicros: input.minProceedsMicros });
  return transaction(async (tx) => {
    await authorizeActor(tx, actor, input.environmentId);
    const wallet = await tx.wallet.findUnique({ where: { environmentId_profileId: { environmentId: input.environmentId, profileId: actor.profileId } } });
    ensure(wallet, "WALLET_REQUIRED", 409);
    const lookup = () => tx.trade.findUnique({ where: { walletId_idempotencyKey: { walletId: wallet.id, idempotencyKey: input.idempotencyKey } } });
    const replay = async (trade: NonNullable<Awaited<ReturnType<typeof lookup>>>) => {
      ensure(trade.requestHash === requestHash, "IDEMPOTENCY_CONFLICT", 409);
      return { trade, wallet: await tx.wallet.findUniqueOrThrow({ where: { id: wallet.id } }), market: await tx.market.findUniqueOrThrow({ where: { id: trade.marketId } }), replayed: true };
    };
    const prior = await lookup();
    if (prior) return replay(prior);
    const env = await tx.environment.findUniqueOrThrow({ where: { id: input.environmentId } });
    if (env.kind === "DEMO") await lockEnvironment(tx, env.id);
    const market = await lockMarket(tx, input.marketId);
    ensure(market.environmentId === input.environmentId, "ENVIRONMENT_MISMATCH", 403);
    await lockWallets(tx, [wallet.id, market.marketMakerWalletId]);
    const again = await lookup();
    if (again) return replay(again);
    const at = await clock(tx, input.environmentId);
    ensure(market.status === "OPEN" && at >= market.opensAt && at < market.closesAt, "MARKET_CLOSED", 409);
    const position = await tx.position.findUnique({ where: { marketId_walletId: { marketId: market.id, walletId: wallet.id } } });
    const held = input.side === "YES" ? position?.yesShares ?? 0n : position?.noShares ?? 0n;
    ensure(held >= BigInt(input.quantity), "INSUFFICIENT_SHARES", 409);
    const quote = saleExecution(market.yesShares, market.noShares, market.liquidityBMicros, input.side, input.quantity);
    ensure(quote.proceedsMicros > 0n && quote.proceedsMicros >= BigInt(input.minProceedsMicros), "SLIPPAGE_EXCEEDED", 409);
    const id = randomUUID();
    const payment = await transfer(tx, input.environmentId, market.marketMakerWalletId, wallet.id, quote.proceedsMicros, "SALE", `sale:${wallet.id}:${input.idempotencyKey}`, id, at);
    const updated = await tx.market.update({ where: { id: market.id }, data: { yesShares: quote.yesShares, noShares: quote.noShares, yesPrice: quote.yesPriceAfter, volumeMicros: { increment: quote.proceedsMicros }, version: { increment: 1 } } });
    const delta = { yesShares: input.side === "YES" ? BigInt(input.quantity) : 0n, noShares: input.side === "NO" ? BigInt(input.quantity) : 0n },
      basisToRemove = held === BigInt(input.quantity)
        ? position!.totalCostMicros
        : position!.totalCostMicros * BigInt(input.quantity) / held;
    await tx.position.update({ where: { marketId_walletId: { marketId: market.id, walletId: wallet.id } }, data: { yesShares: { decrement: delta.yesShares }, noShares: { decrement: delta.noShares }, totalCostMicros: { decrement: basisToRemove } } });
    const trade = await tx.trade.create({ data: { id, environmentId: input.environmentId, marketId: market.id, walletId: wallet.id, side: input.side, action: "SELL", quantity: BigInt(input.quantity), costMicros: quote.proceedsMicros, yesPriceBefore: quote.yesPriceBefore, yesPriceAfter: quote.yesPriceAfter, marketVersion: updated.version, idempotencyKey: input.idempotencyKey, requestHash, paymentTransferId: payment.id, createdAt: at } });
    await appendEvent(tx, updated, "PRICE_CHANGED", at, { action: "SELL", side: input.side, quantity: input.quantity, isSimulated: env.kind === "DEMO" }, quote.proceedsMicros, id);
    if (env.kind === "DEMO") {
      const last = await tx.demoAction.aggregate({ where: { environmentId: env.id }, _max: { sequence: true } });
      await tx.demoAction.create({ data: { environmentId: env.id, sequence: (last._max.sequence ?? 0n) + 1n, virtualAt: at, actorProfileId: actor.profileId, actionType: "SELL", input: { ...input }, resultReference: id } });
    }
    return { trade, wallet: await tx.wallet.findUniqueOrThrow({ where: { id: wallet.id } }), market: updated, replayed: false };
  });
}
export async function lifecycle(
  marketId: string,
  status: "OPEN" | "PAUSED" | "CLOSED",
) {
  return transaction(async (tx) => {
    const pre = await tx.market.findUniqueOrThrow({ where: { id: marketId } });
    const env = await tx.environment.findUniqueOrThrow({
      where: { id: pre.environmentId },
    });
    if (env.kind === "DEMO") await lockEnvironment(tx, env.id);
    const market = await lockMarket(tx, marketId),
      at = await clock(tx, market.environmentId);
    ensure(
      !["RESOLVED", "VOIDED", "CLOSED"].includes(market.status),
      "INVALID_TRANSITION",
      409,
    );
    if (status === "OPEN") {
      ensure(
        ["DRAFT", "PAUSED"].includes(market.status) &&
          at >= market.opensAt &&
          at < market.closesAt,
        "INVALID_TRANSITION",
        409,
      );
      const rule = ruleSchema.parse(market.resolutionRule);
      ensure(
        rule.provider === market.provider &&
          rule.externalEventId === market.externalEventId &&
          rule.cutoff === market.closesAt.toISOString() &&
          (rule.automation || new Date(rule.windowStart) > market.closesAt),
        "INVALID_FROZEN_RULE",
      );
      ensure(
        !rule.provider.includes("REPLACE") &&
          !rule.externalEventId.includes("REPLACE") &&
          !market.title.includes("REPLACE_WITH"),
        "UNFINISHED_TEMPLATE",
      );
      if (env.kind === "LIVE")
        ensure(
          !rule.provider.startsWith("demo") &&
            new URL(market.sourceUrl).hostname !== "example.invalid",
          "SIMULATED_LIVE_RULE",
        );
      ensure(
        hash(market.resolutionRule) === market.ruleHash,
        "RULE_HASH_MISMATCH",
      );
      const maker = await tx.wallet.findUniqueOrThrow({
        where: { id: market.marketMakerWalletId },
      });
      ensure(
        maker.balanceMicros >= market.liquidityBMicros,
        "INSUFFICIENT_RESERVE",
      );
    }
    if (status === "PAUSED")
      ensure(market.status === "OPEN", "INVALID_TRANSITION", 409);
    const updated = await tx.market.update({
      where: { id: marketId },
      data: { status, version: { increment: 1 } },
    });
    await appendEvent(
      tx,
      updated,
      market.status === "DRAFT" && status === "OPEN"
        ? "OPENED"
        : "STATUS_CHANGED",
      at,
      { status },
    );
    return updated;
  });
}
export function resolveOutcome(m: Market, raw: ProviderEvidence, at: Date) {
  const e = evidenceSchema.parse(raw),
    r = ruleSchema.parse(m.resolutionRule),
    d = e.normalizedData;
  ensure(
    e.isFinal &&
      e.provider === r.provider &&
      e.externalEventId === r.externalEventId &&
      e.sourceUrl === m.sourceUrl,
    "EVIDENCE_MISMATCH",
  );
  ensure(
    d.units === r.units &&
      new Date(e.observedAt) <= at &&
      new Date(e.receivedAt) <= at,
    "EVIDENCE_MISMATCH",
  );
  if (d.missing) {
    ensure(at >= new Date(r.voidAfter), "AWAITING_EVIDENCE", 409);
    return "VOID" as const;
  }
  if (d.cancelled) return "VOID" as const;
  ensure(
    new Date(e.observedAt) >= new Date(r.windowStart) &&
      new Date(e.observedAt) <= new Date(r.windowEnd),
    "EVIDENCE_WINDOW_MISMATCH",
  );
  if (["CONCERT", "STUDENT_ELECTION"].includes(m.category))
    ensure((d.channelsChecked?.length ?? 0) > 0, "OFFICIAL_CHANNELS_REQUIRED");
  if (r.comparison === "TRUE") {
    ensure(typeof d.result === "boolean", "INVALID_EVIDENCE");
    return d.result ? ("YES" as const) : ("NO" as const);
  }
  ensure(
    typeof d.value === "number" && typeof r.threshold === "number",
    "INVALID_EVIDENCE",
  );
  return (
    r.comparison === "GT"
      ? d.value > r.threshold
      : r.comparison === "GTE"
        ? d.value >= r.threshold
        : d.value <= r.threshold
  )
    ? ("YES" as const)
    : ("NO" as const);
}
export async function settle(
  marketId: string,
  raw: ProviderEvidence,
  resolverProfileId?: string,
) {
  return transaction(async (tx) => {
    const pre = await tx.market.findUniqueOrThrow({ where: { id: marketId } });
    const env = await tx.environment.findUniqueOrThrow({
      where: { id: pre.environmentId },
    });
    if (env.kind === "DEMO") await lockEnvironment(tx, env.id);
    const market = await lockMarket(tx, marketId),
      at = await clock(tx, market.environmentId),
      e = evidenceSchema.parse(raw),
      payloadHash = hash(e),
      outcome = resolveOutcome(market, e, at);
    const existing = await tx.settlement.findUnique({
      where: { marketId },
      include: { evidence: true },
    });
    if (existing) {
      ensure(
        existing.outcome === outcome &&
          existing.evidence.payloadHash === payloadHash,
        "SETTLEMENT_CONFLICT",
        409,
      );
      return existing;
    }
    ensure(
      market.status !== "DRAFT" &&
        (at >= market.closesAt ||
          (market.status === "CLOSED" &&
            !!ruleSchema.parse(market.resolutionRule).automation)),
      "MARKET_NOT_CLOSED",
      409,
    );
    const positions = await tx.position.findMany({
      where: { marketId },
      orderBy: { walletId: "asc" },
    });
    await lockWallets(tx, [
      market.marketMakerWalletId,
      ...positions.map((p) => p.walletId),
    ]);
    const evidence = await tx.evidence.create({
      data: {
        ...e,
        normalizedData: e.normalizedData,
        rawPayload: e.rawPayload as Prisma.InputJsonValue,
        environmentId: market.environmentId,
        marketId,
        payloadHash,
        submittedByProfileId: resolverProfileId,
      },
    });
    const payoutFor = (p: (typeof positions)[number]) =>
      outcome === "VOID"
        ? p.totalCostMicros
        : (outcome === "YES" ? p.yesShares : p.noShares) * UNIT;
    const totalPayoutMicros = positions.reduce((a, p) => a + payoutFor(p), 0n);
    const receipt = {
      canonicalizationVersion: "rutgers-v1",
      marketId,
      title: market.title,
      environmentKind: env.kind,
      ruleVersion: market.ruleVersion,
      ruleHash: market.ruleHash,
      outcome,
      provider: e.provider,
      externalEventId: e.externalEventId,
      sourceUrl: e.sourceUrl,
      observation: e.normalizedData,
      observedAt: e.observedAt,
      settledAt: at.toISOString(),
      evidenceHash: payloadHash,
      resolverVersion: "rules-v1",
      provenance:
        env.kind === "DEMO" ? "SYNTHETIC_FIXTURE" : "AUTHORIZED_EVIDENCE",
      totalPayoutMicros: totalPayoutMicros.toString(),
    };
    const settlement = await tx.settlement.create({
      data: {
        environmentId: market.environmentId,
        marketId,
        outcome,
        evidenceId: evidence.id,
        ruleVersion: market.ruleVersion,
        resolvedByProfileId: resolverProfileId,
        resolverVersion: "rules-v1",
        settledAt: at,
        receipt,
        receiptHash: hash(receipt),
        totalPayoutMicros,
      },
    });
    for (const p of positions) {
      const amount = payoutFor(p);
      const payment =
        amount > 0n
          ? await transfer(
              tx,
              market.environmentId,
              market.marketMakerWalletId,
              p.walletId,
              amount,
              outcome === "VOID" ? "VOID_REFUND" : "PAYOUT",
              `payout:${p.id}`,
              settlement.id,
              at,
            )
          : null;
      await tx.payout.create({
        data: {
          environmentId: market.environmentId,
          marketId,
          settlementId: settlement.id,
          positionId: p.id,
          walletId: p.walletId,
          amountMicros: amount,
          originalCostMicros: p.totalCostMicros,
          transferId: payment?.id,
        },
      });
    }
    const updated = await tx.market.update({
      where: { id: marketId },
      data: {
        status: outcome === "VOID" ? "VOIDED" : "RESOLVED",
        version: { increment: 1 },
      },
    });
    await appendEvent(tx, updated, "SETTLED", at, {
      outcome,
      receiptHash: settlement.receiptHash,
    });
    return settlement;
  });
}
export async function reconcile(environmentId: string) {
  const [env, wallets, transfers, markets, positions, payouts] =
    await db.$transaction(
      [
        db.environment.findUniqueOrThrow({ where: { id: environmentId } }),
        db.wallet.findMany({ where: { environmentId } }),
        db.transfer.findMany({ where: { environmentId } }),
        db.market.findMany({ where: { environmentId } }),
        db.position.findMany({ where: { environmentId } }),
        db.payout.findMany({
          where: { environmentId },
          include: { settlement: true, position: true, transfer: true },
        }),
      ],
      { isolationLevel: "RepeatableRead" },
    );
  const errors: string[] = [];
  for (const w of wallets) {
    const expected = transfers.reduce(
      (v, t) =>
        v +
        (t.toWalletId === w.id ? t.amountMicros : 0n) -
        (t.fromWalletId === w.id ? t.amountMicros : 0n),
      w.openingBalanceMicros,
    );
    if (expected !== w.balanceMicros) errors.push(`wallet:${w.id}`);
  }
  const supply = wallets.reduce((a, w) => a + w.balanceMicros, 0n);
  if (supply !== env.initialSupplyMicros) errors.push("supply");
  for (const m of markets) {
    const p = positions.filter((p) => p.marketId === m.id);
    if (
      p.reduce((a, p) => a + p.yesShares, 0n) !== m.yesShares ||
      p.reduce((a, p) => a + p.noShares, 0n) !== m.noShares
    )
      errors.push(`positions:${m.id}`);
  }
  for (const s of new Map(
    payouts.map((p) => [p.settlementId, p.settlement]),
  ).values()) {
    if (
      payouts
        .filter((p) => p.settlementId === s.id)
        .reduce((a, p) => a + p.amountMicros, 0n) !== s.totalPayoutMicros
    )
      errors.push(`settlement:${s.id}`);
  }
  for (const p of payouts) {
    const expected =
      p.settlement.outcome === "VOID"
        ? p.originalCostMicros
        : (p.settlement.outcome === "YES"
            ? p.position.yesShares
            : p.position.noShares) * UNIT;
    if (
      p.amountMicros !== expected ||
      (p.transfer?.amountMicros ?? 0n) !== expected
    )
      errors.push(`payout:${p.id}`);
  }
  return {
    ok: errors.length === 0,
    errors,
    supplyMicros: supply.toString(),
    wallets: wallets.length,
    markets: markets.length,
    transfers: transfers.length,
    payouts: payouts.length,
  };
}
