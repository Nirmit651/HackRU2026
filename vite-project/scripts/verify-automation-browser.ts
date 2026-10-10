import { chromium } from "@playwright/test";
import { createServer } from "vite";
import assert from "node:assert/strict";
process.env.NODE_ENV = "test";
const { app } = await import("../server/api");
const { db } = await import("../server/db");
const { demoEnvironment } = await import("../server/automation/demo");
const { configure } = await import("../server/automation");
const { generateWeather } = await import("../server/automation/weather");
const env = await demoEnvironment();
await generateWeather(await configure(env.id, "temperature", true, {}), {
  mean: 65,
  raw: { synthetic: true },
});
const api = app.listen(3001, "127.0.0.1");
await new Promise<void>((r) => api.once("listening", r));
const vite = await createServer({
  server: { port: 5173, strictPort: true, host: "127.0.0.1" },
});
await vite.listen();
const browser = await chromium.launch({
  channel:
    process.env.PLAYWRIGHT_CHANNEL ??
    (process.platform === "win32" ? "msedge" : undefined),
  headless: true,
});
try {
  const page = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
    }),
    errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript(
    (id) => localStorage.setItem("environment", id),
    env.id,
  );
  await page.goto("http://localhost:5173");
  await page.getByRole("button", { name: "Join the market" }).click();
  await page
    .getByRole("textbox", { name: "Display name" })
    .fill("Automation browser tester");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.locator(".modal-backdrop").waitFor({ state: "hidden" });
  await page
    .getByRole("button", { name: /Will the average temperature at/ })
    .click();
  await page.getByRole("heading", { name: /Automatically created/ }).waitFor();
  await page.screenshot({
    path: "test-results/automation-detail.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Admin", exact: true }).click();
  await page
    .getByRole("heading", { name: "Market automation", exact: true })
    .waitFor();
  await page
    .getByRole("button", { name: "Sync now / retry failed jobs" })
    .click();
  await page.screenshot({
    path: "test-results/automation-admin.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: "test-results/automation-mobile.png",
    fullPage: true,
  });
  console.log(
    await page.evaluate(() =>
      Array.from(document.querySelectorAll("body *"))
        .filter((e) => e.getBoundingClientRect().right > innerWidth)
        .map((e) => ({
          tag: e.tagName,
          class: e.className,
          right: e.getBoundingClientRect().right,
        }))
        .slice(0, 10),
    ),
  );
  assert(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    "Mobile horizontal overflow",
  );
  assert.deepEqual(errors, []);
  console.log(
    "Automation browser verification passed: discovery, provenance, admin, sync and mobile width",
  );
} finally {
  await browser.close();
  await vite.close();
  await new Promise<void>((r) => api.close(() => r()));
  await db.$disconnect();
}
