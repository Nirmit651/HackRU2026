import { db } from "../server/db";
import {
  configure,
  reconcileAutomation,
  automationStatus,
} from "../server/automation";
import { types, nowFor } from "../server/automation/core";
import { runAutomationDemo } from "../server/automation/demo";
import { z } from "zod";
const [command, id, type] = process.argv.slice(2);
try {
  let result: unknown;
  if (command === "demo") result = await runAutomationDemo();
  else {
    const environmentId = z.uuid().parse(id);
    if (command === "enable")
      result = await configure(
        environmentId,
        z.enum(types).parse(type),
        true,
        JSON.parse(process.env.AUTOMATION_SETTINGS ?? "{}"),
      );
    else if (command === "sync") {
      const at = await nowFor(environmentId);
      await db.automationConfig.updateMany({
        where: { environmentId },
        data: { nextRunAt: at },
      });
      await db.automationJob.updateMany({
        where: { environmentId, status: { not: "PROCESSING" } },
        data: { status: "PENDING", attempts: 0, runAt: at, lastError: null },
      });
      await reconcileAutomation(environmentId);
      result = { scheduled: true };
    } else result = await automationStatus(environmentId);
  }
  console.log(
    JSON.stringify(
      result,
      (_k, v) => (typeof v === "bigint" ? String(v) : v),
      2,
    ),
  );
} finally {
  await db.$disconnect();
}
