import { randomUUID } from "node:crypto";
import { db } from "../db";
import type { AutomationJob } from "../../generated/prisma/client";

export async function enqueue(
  environmentId: string,
  key: string,
  kind: string,
  payload: Record<string, unknown>,
  runAt: Date,
) {
  return db.automationJob.upsert({
    where: { environmentId_key: { environmentId, key } },
    create: { environmentId, key, kind, payload: payload as never, runAt },
    update: {},
  });
}
export async function claim() {
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(730127)::text`;
    const active = await tx.automationJob.count({
      where: {
        status: "PROCESSING",
        leaseUntil: {
          gt: new Date(
            (
              await tx.$queryRaw<{ at: Date }[]>`SELECT clock_timestamp() AS at`
            )[0].at,
          ),
        },
      },
    });
    if (active >= 2) return undefined;
    const token = randomUUID();
    const rows = await tx.$queryRaw<AutomationJob[]>`
    WITH candidate AS (SELECT j.id FROM automation_jobs j JOIN environments e ON e.id=j."environmentId"
      WHERE ((j.status='PENDING' AND j."runAt" <= CASE WHEN e.kind='DEMO' THEN e."virtualNow" ELSE clock_timestamp() END)
        OR (j.status='PROCESSING' AND j."leaseUntil" < clock_timestamp())) AND j.attempts < 8
      -- Live frozen-bus monitoring is time-sensitive. Demo generator jobs may
      -- be due indefinitely while their virtual clocks are paused, so they
      -- must never starve a production bus observation.
      ORDER BY CASE
        WHEN j.kind='MONITOR' AND EXISTS (
          SELECT 1 FROM markets m
          WHERE m.id::text = j.payload->>'marketId'
            AND m.category='BUS_ARRIVAL'
            AND m.status IN ('OPEN','PAUSED','CLOSED')
            AND m."environmentId"=j."environmentId"
        ) THEN 0
        WHEN e.kind='LIVE' THEN 1
        ELSE 2
      END, j."runAt" FOR UPDATE OF j SKIP LOCKED LIMIT 1)
    UPDATE automation_jobs SET status='PROCESSING', "leaseToken"=${token}::uuid,
      "leaseUntil"=clock_timestamp()+interval '120 seconds', attempts=attempts+1, "updatedAt"=clock_timestamp()
      WHERE id IN (SELECT id FROM candidate) RETURNING *`;
    return rows[0];
  });
}
export async function executeOne(
  handler: (job: AutomationJob) => Promise<Date | void>,
) {
  await db.$executeRaw`UPDATE automation_jobs SET status='FAILED', "lastError"='RETRY_EXHAUSTED' WHERE status='PROCESSING' AND "leaseUntil"<clock_timestamp() AND attempts>=8`;
  const job = await claim();
  if (!job) return false;
  // Lease renewal is process housekeeping; scheduling remains entirely in PostgreSQL.
  const renewal = setInterval(() => {
    void db.$executeRaw`UPDATE automation_jobs SET "leaseUntil"=clock_timestamp()+interval '120 seconds' WHERE id=${job.id}::uuid AND "leaseToken"=${job.leaseToken}::uuid`.catch(
      () => {},
    );
  }, 30000);
  try {
    const next = await handler(job);
    await db.automationJob.updateMany({
      where: { id: job.id, leaseToken: job.leaseToken },
      data: {
        status: next ? "PENDING" : "DONE",
        ...(next ? { runAt: next } : {}),
        attempts: 0,
        leaseToken: null,
        leaseUntil: null,
        lastError: null,
      },
    });
  } catch (e) {
    const code =
      e instanceof Error && /^[A-Z_0-9: -]{1,100}$/.test(e.message)
        ? e.message
        : "PROVIDER_OR_HANDLER_FAILURE";
    await db.$executeRaw`UPDATE automation_jobs SET status=${job.attempts >= 8 ? "FAILED" : "PENDING"}, "lastError"=${code}, "leaseToken"=NULL, "leaseUntil"=NULL,
      "runAt"=clock_timestamp()+${Math.min(3600, 15 * 2 ** job.attempts)}*interval '1 second', "updatedAt"=clock_timestamp()
      WHERE id=${job.id}::uuid AND "leaseToken"=${job.leaseToken}::uuid`;
  } finally {
    clearInterval(renewal);
  }
  return true;
}
