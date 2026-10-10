import { createLive } from "../server/markets";
import { db } from "../server/db";
import { json } from "../shared/contracts";
if (!process.argv[2])
  throw new Error("Usage: tsx scripts/live.ts <unique-environment-key>");
try {
  console.log(json(await createLive(process.argv[2])));
} finally {
  await db.$disconnect();
}
