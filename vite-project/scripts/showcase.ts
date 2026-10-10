import { newDemo, demoStep } from "../server/demo";
import { db } from "../server/db";
import { reconcile } from "../server/engine";
import { randomUUID } from "node:crypto";

// Prepare real executed demo history while retaining time for human purchases.
// Run with the independent worker stopped, then start it after this script.
try {
  const env = await newDemo(2026, `showcase-${randomUUID().slice(0, 8)}`);
  await db.environment.update({
    where: { id: env.id },
    data: { runState: "RUNNING" },
  });
  for (let i = 0; i < 35; i++) await demoStep(env.id);
  await db.environment.update({
    where: { id: env.id },
    data: { runState: "PAUSED" },
  });
  const result = await reconcile(env.id);
  if (!result.ok) throw new Error("Showcase ledger reconciliation failed");
  console.log({ environmentId: env.id, key: env.key, reconciliation: result });
} finally {
  await db.$disconnect();
}
