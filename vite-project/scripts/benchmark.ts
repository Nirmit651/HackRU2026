import os from "node:os";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { db } from "../server/db";
import { newDemo } from "../server/demo";
import { buy, reconcile } from "../server/engine";
const clients = 20,
  attempts = 1000,
  env = await newDemo(2026, `benchmark-${randomUUID().slice(0, 8)}`),
  markets = await db.market.findMany({
    where: { environmentId: env.id },
    orderBy: { slug: "asc" },
  }),
  bots = await db.profile.findMany({
    where: { kind: "BOT", wallets: { some: { environmentId: env.id } } },
    orderBy: { handle: "asc" },
  });
const execute = (i: number) =>
  buy(
    { profileId: bots[i % clients].id, role: "RUNNER", environmentId: env.id },
    {
      environmentId: env.id,
      marketId: markets[i % markets.length].id,
      side: i % 2 ? "YES" : "NO",
      quantity: 1,
      maxCostMicros: "1000000",
      idempotencyKey: `benchmark:${i}`,
    },
  );
for (let i = -20; i < 0; i++) await execute(i + 100000); // warm-up excluded
const latencies: number[] = [],
  reasons: Record<string, number> = {};
let cursor = 0,
  accepted = 0;
const started = performance.now();
await Promise.all(
  Array.from({ length: clients }, async () => {
    while (cursor < attempts) {
      const i = cursor++,
        at = performance.now();
      try {
        await execute(i);
        accepted++;
      } catch (e) {
        const code = (e as { code?: string }).code ?? (e as Error).name;
        if (!reasons[code])
          console.error(
            "Benchmark rejection",
            String((e as Error).message).slice(-500),
          );
        reasons[code] = (reasons[code] ?? 0) + 1;
      }
      latencies.push(performance.now() - at);
    }
  }),
);
const durationMs = performance.now() - started;
latencies.sort((a, b) => a - b);
const postgres =
  await db.$queryRaw`SELECT version(),current_setting('shared_buffers') AS shared_buffers,current_setting('max_connections') AS max_connections`;
const report = {
  recordedAt: new Date().toISOString(),
  workload:
    "20 clients, 1000 one-share buys across six markets; 20 warmup buys; same production trading service; no provider/network calls",
  clock:
    "DEMO frozen 2026-10-10T16:00:00Z; environment lock serializes virtual-clock safety",
  clients,
  attempts,
  accepted,
  rejected: attempts - accepted,
  reasons,
  durationMs,
  tradesPerSecond: accepted / (durationMs / 1000),
  latencyMs: {
    p50: latencies[Math.floor(latencies.length * 0.5)],
    p95: latencies[Math.floor(latencies.length * 0.95)],
  },
  node: process.version,
  cpu: os.cpus()[0].model,
  logicalCpus: os.cpus().length,
  ramBytes: os.totalmem(),
  limits:
    "Local host shared resources; no CPU/RAM container limit. PostgreSQL shared_buffers=128MB; max_connections=60.",
  postgres,
  environmentId: env.id,
  reconciliation: await reconcile(env.id),
};
await fs.mkdir("docs", { recursive: true });
await fs.writeFile("docs/benchmark.json", JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
await db.$disconnect();
