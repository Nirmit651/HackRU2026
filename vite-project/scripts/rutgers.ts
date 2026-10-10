import { z } from "zod";
import { db } from "../server/db";
import { configure } from "../server/automation";
import { generateSports } from "../server/automation/sports";

const environmentId = z.uuid().parse(process.argv[2]);
const settings = {
  provider: "ESPN",
  teamId: 164,
  maxGames: 1,
  marketTypes: ["win", "team-points", "total-points"],
};

try {
  const summaries = [];
  for (const type of ["football", "basketball"] as const) {
    const config = await configure(environmentId, type, true, settings);
    summaries.push({ type, ...(await generateSports(config)) });
  }
  console.log(JSON.stringify({ environmentId, summaries }, null, 2));
} finally {
  await db.$disconnect();
}
