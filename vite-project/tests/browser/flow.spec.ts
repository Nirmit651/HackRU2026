import { test, expect } from "@playwright/test";
import { db } from "../../server/db";
import { newDemo, setDemoTime, fixture } from "../../server/demo";
import { settle, reconcile } from "../../server/engine";
test("two clients: entry, buy, chart recovery, settlement, receipt and cash leaderboard", async ({
  browser,
}) => {
  const env = await newDemo(42),
    context = await browser.newContext(),
    page = await context.newPage(),
    second = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  for (const p of [page, second]) {
    await p.addInitScript(
      (id) => localStorage.setItem("environment", id),
      env.id,
    );
    await p.goto("/");
  }
  await page.getByRole("button", { name: "Join the market" }).click();
  await page
    .getByRole("textbox", { name: "Display name" })
    .fill("Browser trader");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.locator(".cash")).toHaveText("$R 1,000.00");
  await page.locator(".market-row", { hasText: "Will the demo station reach 75" }).click();
  await second.locator(".market-row", { hasText: "Will the demo station reach 75" }).click();
  await expect(
    page.getByRole("button", { name: "Buy 10 YES shares" }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Buy 10 YES shares" }).click();
  await expect(page.getByRole("status")).toContainText("Purchase confirmed");
  await expect(second.locator(".quote-head>strong")).toContainText("52.5");
  await expect(page.locator(".holding")).toContainText("10 YES");
  await page.screenshot({
    path: "docs/browser-detail.png",
    fullPage: true,
    animations: "disabled",
  });
  const m = await db.market.findFirstOrThrow({
    where: { environmentId: env.id, category: "TEMPERATURE" },
  });
  await setDemoTime(env.id, new Date(+m.opensAt + 180000));
  await settle(m.id, fixture(m, new Date(+m.opensAt + 180000)));
  await expect(page.getByRole("heading", { name: "Resolved YES" })).toBeVisible(
    { timeout: 15000 },
  );
  await expect(page.locator(".cash")).toHaveText("$R 1,004.87");
  await expect(
    page.getByRole("button", { name: "Download receipt JSON" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Leaderboard", exact: true }).click();
  await expect(page.locator(".leaderboard-row")).toContainText(
    "Browser trader",
  );
  await page.screenshot({
    path: "docs/browser-leaderboard.png",
    fullPage: true,
    animations: "disabled",
  });
  await page.getByRole("button", { name: "Markets", exact: true }).click();
  await page.screenshot({
    path: "docs/browser-desktop.png",
    fullPage: true,
    animations: "disabled",
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: "docs/browser-mobile.png",
    fullPage: true,
    animations: "disabled",
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  expect(errors).toEqual([]);
  expect((await reconcile(env.id)).ok).toBe(true);
  await context.close();
});
test.afterAll(async () => {
  await db.$disconnect();
});
