import "dotenv/config";
import { processCommitments, chainEnabled } from "../server/chain";
import { db } from "../server/db";
if (!chainEnabled())
  throw new Error(
    "Devnet verification is unconfigured. Set SOLANA_ENABLED and a server-only development signer.",
  );
let running = true;
process.on("SIGINT", () => {
  running = false;
});
process.on("SIGTERM", () => {
  running = false;
});
while (running) {
  try {
    await processCommitments();
  } catch {
    console.error("Devnet unavailable; jobs remain pending");
  }
  await new Promise((r) => setTimeout(r, 5000));
}
await db.$disconnect();
