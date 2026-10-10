import pg from "pg";
import { randomUUID } from "node:crypto";
import { db, transaction } from "./db";
export const tiger = process.env.TIGER_DATABASE_URL
  ? new pg.Pool({
      connectionString: process.env.TIGER_DATABASE_URL,
      max: 3,
      connectionTimeoutMillis: 3000,
      options: "-c timezone=UTC",
      statement_timeout: 5000,
    })
  : null;
// One ordered exporter. A session advisory lock prevents concurrent worker processes.
export async function exportBatch(environmentId?: string) {
  if (!tiger) return { configured: false, delivered: 0 };
  return db.$transaction(
    async (lock) => {
      const [row] = await lock.$queryRaw<
        { locked: boolean }[]
      >`SELECT pg_try_advisory_xact_lock(20261010) AS locked`;
      if (!row.locked) return { configured: true, delivered: 0 };
      const jobs = await db.outboxDelivery.findMany({
        where: {
          event: environmentId ? { environmentId } : undefined,
          status: { not: "DELIVERED" },
          nextAttemptAt: { lte: new Date() },
          OR: [{ leaseUntil: null }, { leaseUntil: { lt: new Date() } }],
        },
        include: { event: true },
        orderBy: [
          { event: { occurredAt: "asc" } },
          { event: { version: "asc" } },
        ],
        take: 50,
      });
      let delivered = 0;
      for (const job of jobs) {
        const earlier = await db.outboxDelivery.count({
          where: {
            destination: "TIGER",
            status: { not: "DELIVERED" },
            event: {
              marketId: job.event.marketId,
              version: { lt: job.event.version },
            },
          },
        });
        if (earlier) continue;
        const token = randomUUID();
        const claim = await db.outboxDelivery.updateMany({
          where: {
            id: job.id,
            status: { not: "DELIVERED" },
            OR: [{ leaseUntil: null }, { leaseUntil: { lt: new Date() } }],
          },
          data: {
            leaseToken: token,
            leaseUntil: new Date(Date.now() + 30000),
            status: "PROCESSING",
            attempts: { increment: 1 },
          },
        });
        if (!claim.count) continue;
        try {
          const e = job.event,
            p = e.payload as { side?: string; quantity?: number };
          await tiger.query(
            "INSERT INTO market_ticks (event_time,event_id,environment_id,market_id,market_version,event_kind,yes_price,trade_amount_micros,executed_side,share_quantity,payload) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(event_time,event_id) DO NOTHING",
            [
              e.occurredAt,
              e.id,
              e.environmentId,
              e.marketId,
              e.version.toString(),
              e.kind,
              e.yesPrice.toString(),
              e.tradeAmountMicros.toString(),
              p.side ?? null,
              p.quantity ?? null,
              JSON.stringify(e.payload),
            ],
          );
          await db.outboxDelivery.updateMany({
            where: { id: job.id, leaseToken: token },
            data: {
              status: "DELIVERED",
              deliveredAt: new Date(),
              leaseUntil: null,
              lastError: null,
            },
          });
          delivered++;
        } catch {
          await db.outboxDelivery.updateMany({
            where: { id: job.id, leaseToken: token },
            data: {
              status: "PENDING",
              leaseUntil: null,
              lastError: "TIGER_UNAVAILABLE",
              nextAttemptAt: new Date(
                Date.now() +
                  Math.min(60000, 1000 * 2 ** Math.min(job.attempts, 6)),
              ),
            },
          });
          break;
        }
      }
      return { configured: true, delivered };
    },
    { timeout: 300000, maxWait: 1000 },
  );
}
export async function history(marketId: string, range = "ALL") {
  return transaction(async (tx) => {
    const m = await tx.market.findUniqueOrThrow({ where: { id: marketId } }),
      env = await tx.environment.findUniqueOrThrow({
        where: { id: m.environmentId },
      }),
      to = env.kind === "DEMO" ? env.virtualNow! : new Date(),
      duration =
        (
          {
            "1H": 3600000,
            "1D": 86400000,
            "1W": 604800000,
            ALL: 2678400000,
          } as Record<string, number>
        )[range] ?? 3600000,
      from = new Date(+to - duration);
    const [watermark] = await tx.$queryRaw<
      { version: bigint }[]
    >`SELECT COALESCE(MIN(e.version)-1,${m.version}::bigint) AS version FROM market_events e JOIN outbox_deliveries d ON d."marketEventId"=e.id WHERE e."marketId"=${marketId}::uuid AND d.status<>'DELIVERED' AND e.version<=${m.version}`;
    let source = "SUPABASE_FALLBACK",
      events: unknown[] = [];
    if (tiger)
      try {
        const result = await tiger.query(
          'SELECT event_id AS id,market_id AS "marketId",market_version::text AS version,event_kind AS kind,event_time AS "occurredAt",yes_price::text AS "yesPrice",trade_amount_micros::text AS "tradeAmountMicros",payload FROM market_ticks WHERE environment_id=$1 AND market_id=$2 AND market_version<=$3 AND event_time BETWEEN $4 AND $5 ORDER BY market_version DESC LIMIT 10001',
          [m.environmentId, marketId, watermark.version.toString(), from, to],
        );
        events = result.rows;
        source = "TIGER_WITH_SUPABASE_TAIL";
      } catch {
        /* ledger fallback below */
      }
    const tail = await tx.marketEvent.findMany({
      where: {
        marketId,
        version: {
          gt: source === "SUPABASE_FALLBACK" ? 0n : watermark.version,
          lte: m.version,
        },
        occurredAt: { gte: from, lte: to },
      },
      orderBy: { version: "desc" },
      take: 10001,
    });
    events.push(...tail);
    events.sort((a, b) =>
      BigInt((a as { version: string }).version) <
      BigInt((b as { version: string }).version)
        ? -1
        : 1,
    );
    // The cap is explicit. Recovery starts from the snapshot version, not an invented max analytics version.
    return {
      events: events.slice(-10000),
      throughVersion: m.version,
      exportedThroughVersion: watermark.version,
      source,
      interval: "event",
      from,
      to,
      truncated: events.length > 10000,
    };
  });
}
export async function diagnostics() {
  const pending = await db.outboxDelivery.count({
      where: { status: { not: "DELIVERED" } },
    }),
    failed = await db.outboxDelivery.count({
      where: { lastError: { not: null } },
    }),
    first = await db.outboxDelivery.findFirst({
      where: { status: { not: "DELIVERED" } },
      orderBy: { event: { occurredAt: "asc" } },
      include: { event: true },
    });
  return {
    tigerConfigured: !!tiger,
    pending,
    failed,
    oldestPendingEventAt: first?.event.occurredAt ?? null,
  };
}
