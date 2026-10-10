import "dotenv/config";
import { tiger } from "../server/tiger";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
if (!tiger)
  throw new Error(
    "TIGER_DATABASE_URL is required; no fabricated analytics measurements.",
  );
const environmentId = randomUUID(),
  marketId = randomUUID(),
  count = 100000;
// Analytical synthetic dataset only, isolated by fresh IDs; never financial data.
await tiger.query(
  `INSERT INTO market_ticks (event_time,event_id,environment_id,market_id,market_version,event_kind,yes_price,trade_amount_micros)
 SELECT '2026-10-01T00:00:00Z'::timestamptz+i*interval '1 second',gen_random_uuid(),$1,$2,i,'PRICE_CHANGED',0.5+0.1*sin(i/100.0),500000 FROM generate_series(1,$3) i`,
  [environmentId, marketId, count],
);
await tiger.query(
  "CALL refresh_continuous_aggregate('market_minutes','2026-10-01T00:00:00Z'::timestamptz,'2026-10-03T00:00:00Z'::timestamptz)",
);
const queries = {
    history:
      "SELECT * FROM market_ticks WHERE environment_id=$1 AND market_id=$2 ORDER BY event_time DESC LIMIT 1000",
    aggregate:
      "SELECT * FROM market_minutes WHERE environment_id=$1 AND market_id=$2 ORDER BY bucket DESC LIMIT 1440",
  },
  latency: Record<string, unknown> = {};
for (const [name, query] of Object.entries(queries)) {
  await tiger.query(query, [environmentId, marketId]);
  const runs = [];
  for (let i = 0; i < 20; i++) {
    const at = performance.now();
    await tiger.query(query, [environmentId, marketId]);
    runs.push(performance.now() - at);
  }
  runs.sort((a, b) => a - b);
  latency[name] = { p50: runs[10], p95: runs[19] };
}
const report = {
  at: new Date().toISOString(),
  environmentId,
  marketId,
  rows: count,
  synthetic: true,
  warmup: 1,
  runs: 20,
  latencyMs: latency,
  resources:
    "Provider-controlled; fill in Tiger service CPU/RAM from dashboard",
  networkIncluded: true,
  exporterLag:
    "Not measured by synthetic direct-insert workload; use admin diagnostics for real outbox lag",
};
await fs.writeFile(
  "docs/tiger-benchmark.json",
  JSON.stringify(report, null, 2),
);
console.log(report);
await tiger.end();
