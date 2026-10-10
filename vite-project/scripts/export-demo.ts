import fs from "node:fs/promises";
import { db } from "../server/db";
import { reconcile } from "../server/engine";
import { json } from "../shared/contracts";
const environmentId = process.argv[2];
if (!environmentId)
  throw new Error("Usage: tsx scripts/export-demo.ts <environmentId>");
const env = await db.environment.findUniqueOrThrow({
  where: { id: environmentId },
});
if (env.kind !== "DEMO") throw new Error("DEMO only");
const [actions, markets] = await Promise.all([
  db.demoAction.findMany({
    where: { environmentId },
    orderBy: { sequence: "asc" },
  }),
  db.market.findMany({
    where: { environmentId },
    select: {
      slug: true,
      yesShares: true,
      noShares: true,
      volumeMicros: true,
      status: true,
    },
  }),
]);
await fs.writeFile(
  `docs/replay-${env.key}.json`,
  json({
    seed: env.seed,
    scenarioVersion: env.scenarioVersion,
    initialClock: env.simulatedStartAt,
    actions,
    expectedMarkets: markets,
    reconciliation: await reconcile(env.id),
  }),
);
await db.$disconnect();
