import "dotenv/config";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";

// `npm run demo` is always an offline development run, even if the shell has
// production-oriented environment variables set.
process.env.NODE_ENV = "development";
process.env.LOCAL_DEMO_AUTH = "true";

const appDir = process.cwd();
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const children: ChildProcess[] = [];

function run(command: string, args: string[]) {
  execFileSync(command, args, {
    cwd: appDir,
    env: process.env,
    stdio: "inherit",
  });
}

function start(name: string, args: string[]) {
  const child = spawn(npm, args, {
    cwd: appDir,
    env: process.env,
    stdio: "inherit",
  });
  child.on("exit", (code, signal) => {
    if (code && code !== 0) console.error(`${name} exited with code ${code}`);
    else if (signal) console.error(`${name} stopped with ${signal}`);
  });
  children.push(child);
}

console.log("Preparing the local database...");
run(npm, ["run", "db:generate"]);
run(npm, ["run", "db:migrate"]);

const { db } = await import("../server/db");
const { newDemo } = await import("../server/demo");
const environment = await newDemo();
await db.$disconnect();
console.log(`Created ${environment.key} (${environment.id})`);
console.log("Starting API, frontend, and worker. Press Ctrl+C to stop all three.");

start("API", ["run", "api"]);
start("Frontend", ["run", "dev"]);
start("Worker", ["run", "worker"]);

function stop() {
  for (const child of children) child.kill("SIGTERM");
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
