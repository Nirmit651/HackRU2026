import "dotenv/config";
import { db } from "./db";
import { exportBatch, tiger } from "./tiger";
import { demoStep } from "./demo";
import { lifecycle, settle } from "./engine";
import { fetchEvidence } from "./providers";
let providerNextAt = 0;
let running = true;
process.on("SIGINT", () => {
  running = false;
});
process.on("SIGTERM", () => {
  running = false;
});
console.log("Worker started: demo clock, cutoff enforcement, Tiger outbox");
while (running) {
  const before = Date.now();
  try {
    const envs = await db.environment.findMany({
      where: { kind: "DEMO", runState: "RUNNING" },
    });
    for (const e of envs) await demoStep(e.id);
    const due = await db.market.findMany({
      where: {
        environment: { kind: "LIVE" },
        status: { in: ["OPEN", "PAUSED"] },
        closesAt: { lte: new Date() },
      },
      take: 100,
    });
    for (const m of due) await lifecycle(m.id, "CLOSED");
    await exportBatch();
    if (Date.now() >= providerNextAt) {
      providerNextAt = Date.now() + 30000;
      const awaiting = await db.market.findMany({
        where: { environment: { kind: "LIVE" }, status: "CLOSED" },
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
    }
  } catch {
    console.error("Worker cycle failed; retrying on next cycle");
  }
  await new Promise((r) =>
    setTimeout(r, Math.max(10, 1000 - (Date.now() - before))),
  );
}
await tiger?.end();
await db.$disconnect();
console.log("Worker stopped after current batch");
