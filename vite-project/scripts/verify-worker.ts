import { newDemo, replay } from "../server/demo";
import { db } from "../server/db";
import { reconcile } from "../server/engine";
import fs from "node:fs/promises";
const env = await newDemo(2026);
await db.environment.update({
  where: { id: env.id },
  data: { runState: "RUNNING", speed: 10 },
});
console.log(`Verifying independent worker for DEMO ${env.id}`);
const deadline = Date.now() + 45000;
let resolved = 0;
while (Date.now() < deadline) {
  resolved = await db.settlement.count({ where: { environmentId: env.id } });
  if (resolved === 6) break;
  await new Promise((r) => setTimeout(r, 1000));
}
if (resolved !== 6)
  throw new Error(`Worker settled ${resolved}/6 markets within 45 seconds`);
const report = {
  environmentId: env.id,
  settledMarkets: resolved,
  actions: await db.demoAction.count({ where: { environmentId: env.id } }),
  reconciliation: await reconcile(env.id),
  replay: await replay(env.id),
};
if (
  !report.reconciliation.ok ||
  !report.replay.equal ||
  !report.replay.reconciliation.ok
)
  throw new Error("Worker scenario failed reconciliation/replay");
await fs.writeFile(
  "docs/worker-verification.json",
  JSON.stringify(report, null, 2),
);
console.log(report);
await db.$disconnect();
