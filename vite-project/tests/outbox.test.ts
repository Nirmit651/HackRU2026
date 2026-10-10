import { beforeAll, afterAll, it, expect } from "vitest";
import { db } from "../server/db";
import { newDemo } from "../server/demo";
import { exportBatch, tiger, history } from "../server/tiger";
let env: Awaited<ReturnType<typeof newDemo>>;
beforeAll(async () => {
  if (!tiger)
    throw new Error(
      "Set TIGER_DATABASE_URL to an isolated PostgreSQL analytics test database",
    );
  await tiger.query(
    `CREATE TABLE IF NOT EXISTS market_ticks(event_time timestamptz NOT NULL,event_id uuid NOT NULL,environment_id uuid NOT NULL,market_id uuid NOT NULL,market_version bigint NOT NULL,event_kind text NOT NULL,yes_price numeric NOT NULL,trade_amount_micros bigint NOT NULL,executed_side text,share_quantity bigint,payload jsonb NOT NULL DEFAULT '{}',PRIMARY KEY(event_time,event_id))`,
  );
  env = await newDemo();
}, 30000);
afterAll(async () => {
  await tiger?.end();
  await db.$disconnect();
});
it("replays a crash-after-Tiger-write without duplicating events or volume", async () => {
  const event = await db.marketEvent.findFirstOrThrow({
    where: { environmentId: env.id },
  });
  await tiger!.query(
    "INSERT INTO market_ticks(event_time,event_id,environment_id,market_id,market_version,event_kind,yes_price,trade_amount_micros) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
    [
      event.occurredAt,
      event.id,
      event.environmentId,
      event.marketId,
      event.version.toString(),
      event.kind,
      event.yesPrice.toString(),
      event.tradeAmountMicros.toString(),
    ],
  );
  await db.outboxDelivery.update({
    where: {
      marketEventId_destination: {
        marketEventId: event.id,
        destination: "TIGER",
      },
    },
    data: { status: "PROCESSING", leaseUntil: new Date(0) },
  });
  // Existing local test audit rows may precede this environment. Drain in bounded batches.
  for (let i = 0; i < 300; i++) {
    await exportBatch(env.id);
    if (
      (await db.outboxDelivery.count({
        where: {
          event: { environmentId: env.id },
          status: { not: "DELIVERED" },
        },
      })) === 0
    )
      break;
  }
  const result = await tiger!.query(
    "SELECT count(*)::int AS count FROM market_ticks WHERE event_id=$1",
    [event.id],
  );
  expect(result.rows[0].count).toBe(1);
  expect(
    await db.outboxDelivery.count({
      where: { event: { environmentId: env.id }, status: { not: "DELIVERED" } },
    }),
  ).toBe(0);
  const h = await history(event.marketId);
  expect(h.source).toBe("TIGER_WITH_SUPABASE_TAIL");
  expect(h.exportedThroughVersion).toBe(1n);
  expect(h.events).toHaveLength(1);
}, 120000);
it("an undelivered early event keeps the watermark behind a later acknowledgment", async () => {
  const m = await db.market.findFirstOrThrow({
    where: { environmentId: env.id },
  });
  await db.outboxDelivery.updateMany({
    where: { event: { marketId: m.id, version: 1n } },
    data: { status: "PENDING", nextAttemptAt: new Date(Date.now() + 60000) },
  });
  const h = await history(m.id);
  expect(h.exportedThroughVersion).toBe(0n);
  expect(h.events).toHaveLength(1);
});
