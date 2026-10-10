import { newDemo, replay } from "../server/demo";
import { db } from "../server/db";
import { json } from "../shared/contracts";
try {
  console.log(
    json(
      process.argv[2] === "replay"
        ? await replay(process.argv[3])
        : await newDemo(),
    ),
  );
} finally {
  await db.$disconnect();
}
