import EmbeddedPostgres from "embedded-postgres";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { Client } from "pg";
import { readFile } from "node:fs/promises";
const port = 55439,
  password = randomUUID();
const databaseDir = resolve(".local-db", randomUUID());
const pg = new EmbeddedPostgres({
  databaseDir,
  user: "postgres",
  password,
  port,
  persistent: true,
  postgresFlags: ["-h", "127.0.0.1"],
  onLog: () => {},
  onError: () => {},
});
process.env.DATABASE_URL = `postgresql://postgres:${password}@127.0.0.1:${port}/automation_test`;
process.env.DIRECT_DATABASE_URL = process.env.DATABASE_URL;
process.env.LOCAL_DEMO_AUTH = "true";
process.env.SUPABASE_URL = "";
process.env.APP_ORIGIN = "http://localhost:5173";
async function run(bin: string, args: string[]) {
  await new Promise<void>((ok, no) => {
    const p = spawn(process.execPath, [bin, ...args], {
      stdio: "inherit",
      env: process.env,
      windowsHide: true,
    });
    p.on("error", no);
    p.on("exit", (code) =>
      code === 0 ? ok() : no(new Error(`TEST_PROCESS_EXIT_${code}`)),
    );
  });
}
async function windowsControl(action: "start" | "stop") {
  const binary = resolve(
    "node_modules/@embedded-postgres/windows-x64/native/bin/pg_ctl.exe",
  );
  const args = [
    "-D",
    databaseDir,
    "-w",
    action,
    ...(action === "start"
      ? [
          "-l",
          resolve(databaseDir, "server.log"),
          "-o",
          `-p ${port} -h 127.0.0.1`,
        ]
      : ["-m", "fast"]),
  ];
  await new Promise<void>((ok, no) => {
    const p = spawn(binary, args, { stdio: "inherit", windowsHide: true });
    p.on("error", no);
    p.on("exit", (code) =>
      code === 0 ? ok() : no(new Error(`PG_CONTROL_${code}`)),
    );
  });
}
try {
  await pg.initialise();
  if (process.platform === "win32") await windowsControl("start");
  else await pg.start();
  const admin = new Client({
    host: "127.0.0.1",
    port,
    user: "postgres",
    password,
    database: "postgres",
  });
  await admin.connect();
  await admin.query("CREATE DATABASE automation_test");
  await admin.query(
    "CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN",
  );
  await admin.end();
  await run("node_modules/prisma/build/index.js", ["migrate", "deploy"]);
  const owner = new Client({ connectionString: process.env.DATABASE_URL });
  await owner.connect();
  await owner.query(await readFile("prisma/runtime-role.sql", "utf8"));
  await owner.end();
  if (process.argv.includes("--browser"))
    await run("node_modules/tsx/dist/cli.mjs", [
      "scripts/verify-automation-browser.ts",
    ]);
  else
    await run("node_modules/vitest/vitest.mjs", [
      "run",
      "tests/automation-db.test.ts",
      "tests/engine.test.ts",
      "tests/authorization.test.ts",
    ]);
} finally {
  if (process.platform === "win32") await windowsControl("stop");
  else await pg.stop();
}
