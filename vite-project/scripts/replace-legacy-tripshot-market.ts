import { ensureNextCollegeAveBreakMarket } from "../server/bus-showcase";
import { selectNextEligibleArrival, tripshotLive } from "../server/tripshot";
import { db } from "../server/db";
import { settle } from "../server/engine";

const legacy = await db.market.findFirst({
  where: {
    category: "BUS_ARRIVAL",
    title: { contains: "remain stopped for at least 5 minutes" },
    status: { in: ["DRAFT", "OPEN", "PAUSED", "CLOSED"] },
  },
  orderBy: { createdAt: "desc" },
});

if (legacy) {
  const trades = await db.trade.count({ where: { marketId: legacy.id } });
  if (trades) throw new Error("LEGACY_TRIPSHOT_MARKET_HAS_TRADES");

  // Confirm that a new frozen candidate is available before retiring the legacy market.
  const live = await tripshotLive();
  if (live.stale || !selectNextEligibleArrival(live))
    throw new Error("NO_FRESH_ELIGIBLE_TRIPSHOT_CANDIDATE");

  const observedAt = new Date(Math.min(Date.now() - 1_000, +legacy.closesAt));
  await settle(
    legacy.id,
    {
      provider: legacy.provider,
      externalEventId: legacy.externalEventId!,
      sourceUrl: legacy.sourceUrl,
      observedAt: observedAt.toISOString(),
      receivedAt: observedAt.toISOString(),
      isFinal: true,
      normalizedData: { units: "boolean", cancelled: true },
      rawPayload: { reason: "replaced_before_trading", replacement: "tripshot-next-college-ave-break-v3" },
    },
    undefined,
    { allowEarly: true, resolverVersion: "legacy-tripshot-replacement-v1" },
  );
  await db.marketArchive.upsert({
    where: { marketId: legacy.id },
    create: { marketId: legacy.id, reason: "replaced_by_ten_minute_tripshot_take_a_break_market" },
    update: {},
  });
}

const environmentId = legacy?.environmentId ?? (await db.environment.findFirst({
  where: { kind: "LIVE" },
  orderBy: { createdAt: "desc" },
  select: { id: true },
}))?.id;
if (!environmentId) throw new Error("LIVE_ENVIRONMENT_NOT_FOUND");
const replacement = await ensureNextCollegeAveBreakMarket(environmentId);
if (!replacement) throw new Error("REPLACEMENT_MARKET_UNAVAILABLE");
console.log(JSON.stringify({ archivedMarketId: legacy?.id ?? null, replacementMarketId: replacement.id, title: replacement.title }));
