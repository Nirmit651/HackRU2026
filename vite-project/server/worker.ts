import "dotenv/config";
import { db } from "./db";
import { exportBatch, tiger } from "./tiger";
import { demoStep } from "./demo";
import { lifecycle, settle } from "./engine";
import { fetchEvidence } from "./providers";
import { automationTick } from "./automation";
import { tickPresentationRuns } from "./presentation";
let providerNextAt = 0;
let running = true;
function workerError(stage: string, error: unknown) {
  const detail = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(`Worker stage failed: ${stage}`, detail);
}
async function runStage(stage: string, task: () => Promise<void>) {
  try {
    await task();
  } catch (error) {
    // A Tiger export or a stale demo must never prevent the live automation
    // coordinator from creating/monitoring the next bus market.
    workerError(stage, error);
  }
}
process.on("SIGINT", () => {
  running = false;
});
process.on("SIGTERM", () => {
  running = false;
});
console.log("Worker started: demo clock, cutoff enforcement, Tiger outbox");
while (running) {
  const before = Date.now();
  await runStage("demo-step", async () => {
    const envs = await db.environment.findMany({
      where: { kind: "DEMO", runState: "RUNNING" },
    });
    for (const e of envs) await demoStep(e.id);
  });
  await runStage("market-lifecycle", async () => {
    const due = await db.market.findMany({
      where: {
        environment: { kind: "LIVE" },
        status: { in: ["OPEN", "PAUSED"] },
        closesAt: { lte: new Date() },
      },
      take: 100,
    });
    for (const m of due) await lifecycle(m.id, "CLOSED");
  });
  await runStage("tiger-export", async () => {
    await exportBatch();
  });
  await runStage("automation", async () => {
    await automationTick();
  });
  await runStage("presentation", async () => {
    await tickPresentationRuns();
  });
  if (Date.now() >= providerNextAt) {
    providerNextAt = Date.now() + 30000;
    await runStage("evidence-settlement", async () => {
      const awaiting = await db.market.findMany({
        where: {
          environment: { kind: "LIVE" },
          status: "CLOSED",
          generatorKey: null,
        },
        take: 20,
      });
      for (const m of awaiting) {
        try {
          const e = await fetchEvidence(m);
          if (e) await settle(m.id, e);
        } catch {
          console.error(
            "Evidence unavailable or invalid; market remains pending",
          );
        }
      }
    });
  }
  await new Promise((r) =>
    setTimeout(r, Math.max(10, 1000 - (Date.now() - before))),
  );
}
await tiger?.end();
await db.$disconnect();
console.log("Worker stopped after current batch");
