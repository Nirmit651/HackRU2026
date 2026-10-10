import fs from "node:fs/promises";
import { tiger } from "../server/tiger";
if (!tiger) throw new Error("TIGER_DATABASE_URL is not configured");
try {
  await tiger.query(await fs.readFile("tiger/001_history.sql", "utf8"));
  console.log("Tiger schema and continuous aggregate applied");
} finally {
  await tiger.end();
}
