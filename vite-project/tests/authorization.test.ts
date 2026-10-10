import { it, expect, afterAll, beforeAll } from "vitest";
import { app } from "../server/api";
import { db } from "../server/db";
import type { Server } from "node:http";
let server: Server, url: string;
beforeAll(async () => {
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  const address = server.address() as { port: number };
  url = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => {
  server.close();
  await db.$disconnect();
});
it("rejects unauthenticated admin mutations and private wallet reads", async () => {
  expect(
    (
      await fetch(url + "/api/admin/demo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      })
    ).status,
  ).toBe(401);
  expect(
    (
      await fetch(
        url +
          "/api/me/wallet?environmentId=00000000-0000-4000-8000-000000000000",
      )
    ).status,
  ).toBe(401);
});
it("rejects cross-origin mutations before executing them", async () => {
  const r = await fetch(url + "/api/admin/demo", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "https://evil.invalid",
    },
    body: "{}",
  });
  expect(r.status).toBe(403);
});
it("does not expose private tables or browser-supplied wallet mutations", async () => {
  expect((await fetch(url + "/api/wallets")).status).toBe(404);
  expect(
    (
      await fetch(url + "/api/trades", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: '{"walletId":"other"}',
      })
    ).status,
  ).toBe(404);
});
