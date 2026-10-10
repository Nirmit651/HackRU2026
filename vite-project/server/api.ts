import "dotenv/config";
import express from "express";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { z, ZodError } from "zod";
import { db, AppError, ensure } from "./db";
import {
  categories,
  campuses,
  buyInput,
  evidenceSchema,
} from "../shared/contracts";
import { buy, grantWallet, lifecycle, settle, reconcile } from "./engine";
import { execution } from "./math";
import { identity, scopedIdentity, admin, demoToken, localDemo } from "./auth";
import { history, diagnostics } from "./tiger";
import { newDemo } from "./demo";
import { busSnapshot } from "./bus";
import { createMarket, createMarketInput } from "./markets";
import { verifyCommitment } from "./chain";
export const app = express();
app.disable("x-powered-by");
app.set("json replacer", (_key: string, v: unknown) =>
  typeof v === "bigint" ? v.toString() : v,
);
app.use(express.json({ limit: "32kb" }));
const rates = new Map<string, { start: number; count: number }>();
app.use((req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) {
    const origin = req.headers.origin;
    if (origin && origin !== process.env.APP_ORIGIN) {
      next(new AppError("ORIGIN_REJECTED", 403));
      return;
    }
    const key = req.ip ?? "unknown",
      now = Date.now(),
      entry = rates.get(key);
    if (rates.size > 10000)
      for (const [k, v] of rates) if (now - v.start > 60000) rates.delete(k);
    if (!entry || now - entry.start > 60000)
      rates.set(key, { start: now, count: 1 });
    else if (++entry.count > 180) {
      next(new AppError("RATE_LIMITED", 429));
      return;
    }
  }
  next();
});
const id = (v: unknown) => z.uuid().parse(v),
  envId = (req: express.Request) => id(req.query.environmentId);
app.get("/api/health", async (_req, res) => {
  await db.$queryRaw`SELECT 1`;
  res.json({ ok: true });
});
app.get("/api/config", (_req, res) =>
  res.json({
    localDemoAuth: localDemo,
    supabaseUrl: process.env.SUPABASE_URL ?? null,
    supabasePublishableKey: process.env.SUPABASE_PUBLISHABLE_KEY ?? null,
    mapStyle: process.env.MAP_STYLE_URL ?? null,
  }),
);
app.get("/api/environments", async (_req, res) =>
  res.json(
    await db.environment.findMany({
      select: {
        id: true,
        key: true,
        kind: true,
        virtualNow: true,
        runState: true,
        speed: true,
      },
      orderBy: { createdAt: "desc" },
      take: 50,
    }),
  ),
);
app.post("/api/demo/session", async (req, res) => {
  ensure(localDemo, "NOT_FOUND", 404);
  const input = z
      .object({ displayName: z.string().trim().min(1).max(40) })
      .parse(req.body),
    authUserId = randomUUID();
  const profile = await db.profile.create({
    data: {
      authUserId,
      handle: `local-${authUserId}`,
      displayName: input.displayName,
      kind: "HUMAN",
      campus: "BUSCH",
    },
  });
  res.json({ token: demoToken(profile.id) });
});
app.get("/api/me", async (req, res) => {
  const user = await identity(req);
  res.json({
    displayName: user.profile.displayName,
    admin: user.admin,
    campus: user.profile.campus,
  });
});
app.patch("/api/me", async (req, res) => {
  const user = await identity(req),
    input = z
      .object({
        displayName: z.string().trim().min(1).max(40),
        campus: z.enum(campuses),
      })
      .parse(req.body);
  await db.profile.update({ where: { id: user.profile.id }, data: input });
  res.json(input);
});
app.get("/api/markets", async (req, res) => {
  const input = z
    .object({
      environmentId: z.uuid(),
      category: z.enum(categories).optional(),
      status: z
        .enum(["DRAFT", "OPEN", "PAUSED", "CLOSED", "RESOLVED", "VOIDED"])
        .optional(),
      search: z.string().max(100).optional(),
      cursor: z.uuid().optional(),
      limit: z.coerce.number().int().min(1).max(50).default(30),
    })
    .parse(req.query);
  const rows = await db.market.findMany({
    where: {
      environmentId: input.environmentId,
      category: input.category,
      status: input.status,
      title: input.search
        ? { contains: input.search, mode: "insensitive" }
        : undefined,
      id: input.cursor ? { gt: input.cursor } : undefined,
    },
    orderBy: { id: "asc" },
    take: input.limit + 1,
  });
  res.json({
    items: rows.slice(0, input.limit),
    nextCursor: rows.length > input.limit ? rows[input.limit - 1].id : null,
  });
});
app.get("/api/markets/:id", async (req, res) => {
  const market = await db.market.findUnique({
    where: { id: id(req.params.id) },
  });
  ensure(market, "NOT_FOUND", 404);
  res.json({ ...market, asOf: new Date() });
});
app.get("/api/markets/:id/history", async (req, res) =>
  res.json(
    await history(
      id(req.params.id),
      z.enum(["1H", "1D", "1W", "ALL"]).default("ALL").parse(req.query.range),
    ),
  ),
);
app.get("/api/markets/:id/events", async (req, res) => {
  const after = BigInt(
      z
        .string()
        .regex(/^\d{1,16}$/)
        .default("0")
        .parse(req.query.afterVersion),
    ),
    marketId = id(req.params.id);
  const events = await db.marketEvent.findMany({
    where: { marketId, version: { gt: after } },
    orderBy: { version: "asc" },
    take: 501,
  });
  res.json({ events: events.slice(0, 500), hasMore: events.length > 500 });
});
app.post("/api/markets/:id/quote", async (req, res) => {
  const input = z
      .object({
        environmentId: z.uuid(),
        side: z.enum(["YES", "NO"]),
        quantity: z.number().int().min(1).max(1000),
      })
      .parse(req.body),
    m = await db.market.findUniqueOrThrow({ where: { id: id(req.params.id) } });
  ensure(m.environmentId === input.environmentId, "ENVIRONMENT_MISMATCH");
  const env = await db.environment.findUniqueOrThrow({
      where: { id: input.environmentId },
    }),
    now = env.kind === "DEMO" ? env.virtualNow! : new Date();
  ensure(
    m.status === "OPEN" && now >= m.opensAt && now < m.closesAt,
    "MARKET_CLOSED",
    409,
  );
  const q = execution(
    m.yesShares,
    m.noShares,
    m.liquidityBMicros,
    input.side,
    input.quantity,
  );
  res.json({
    ...q,
    version: m.version,
    winningPayoutMicros: BigInt(input.quantity) * 1000000n,
    netProfitMicros: BigInt(input.quantity) * 1000000n - q.costMicros,
  });
});
app.post("/api/markets/:id/trades", async (req, res) => {
  const input = buyInput.parse({ ...req.body, marketId: id(req.params.id) }),
    user = await scopedIdentity(req, input.environmentId);
  res.json(await buy({ profileId: user.profile.id, role: "HUMAN" }, input));
});
app.post("/api/runner/trades", async (req, res) => {
  const token = req.headers.authorization?.replace(/^Bearer /, ""),
    expected = process.env.DEMO_WORKER_TOKEN;
  ensure(
    token &&
      expected &&
      expected.length >= 32 &&
      token.length === expected.length &&
      timingSafeEqual(Buffer.from(token), Buffer.from(expected)),
    "UNAUTHORIZED",
    401,
  );
  const { profileId, ...raw } = z
      .object({ profileId: z.uuid() })
      .passthrough()
      .parse(req.body),
    input = buyInput.parse(raw);
  ensure(
    input.environmentId === process.env.DEMO_WORKER_ENVIRONMENT_ID,
    "FORBIDDEN",
    403,
  );
  res.json(
    await buy(
      { profileId, role: "RUNNER", environmentId: input.environmentId },
      input,
    ),
  );
});
app.get("/api/me/wallet", async (req, res) => {
  const environmentId = envId(req),
    user = await scopedIdentity(req, environmentId);
  res.json(await grantWallet(user.profile.id, environmentId));
});
app.get("/api/me/positions", async (req, res) => {
  const environmentId = envId(req),
    user = await scopedIdentity(req, environmentId),
    wallet = await grantWallet(user.profile.id, environmentId);
  const [positions, trades] = await Promise.all([
    db.position.findMany({
      where: { walletId: wallet.id },
      include: { market: true, payout: true },
      take: 100,
    }),
    db.trade.findMany({
      where: { walletId: wallet.id },
      orderBy: { createdAt: "desc" },
      take: 100,
    }),
  ]);
  res.json({ positions, trades });
});
app.get("/api/leaderboard", async (req, res) => {
  const environmentId = envId(req),
    campus = z.enum(campuses).optional().parse(req.query.campus);
  const wallets = await db.wallet.findMany({
    where: { environmentId, kind: "USER", profile: { kind: "HUMAN", campus } },
    orderBy: [{ balanceMicros: "desc" }, { profileId: "asc" }],
    include: { profile: true },
    take: 50,
  });
  res.json(
    wallets.map((w, i) => ({
      rank: i + 1,
      displayName: w.profile!.displayName,
      campus: w.profile!.campus,
      balanceMicros: w.balanceMicros,
    })),
  );
});
app.get("/api/markets/:id/receipt", async (req, res) => {
  const marketId = id(req.params.id),
    s = await db.settlement.findUnique({ where: { marketId } });
  ensure(s, "AWAITING_SETTLEMENT", 404);
  let personal = null;
  if (req.headers.authorization) {
    const user = await scopedIdentity(req, s.environmentId),
      wallet = await db.wallet.findUnique({
        where: {
          environmentId_profileId: {
            environmentId: s.environmentId,
            profileId: user.profile.id,
          },
        },
      });
    if (wallet) {
      const payout = await db.payout.findFirst({
        where: { settlementId: s.id, walletId: wallet.id },
        include: { position: true },
      });
      if (payout)
        personal = {
          yesShares: payout.position.yesShares,
          noShares: payout.position.noShares,
          originalCostMicros: payout.originalCostMicros,
          payoutMicros: payout.amountMicros,
          netProfitMicros: payout.amountMicros - payout.originalCostMicros,
        };
    }
  }
  res.json({
    receipt: s.receipt,
    receiptHash: s.receiptHash,
    personal,
    verification: (await db.chainCommitment.findUnique({
      where: { marketId_kind: { marketId, kind: "SETTLEMENT" } },
      select: { status: true, transactionSignature: true },
    })) ?? { status: "UNAVAILABLE" },
  });
});
app.get("/api/markets/:id/verify", async (req, res) =>
  res.json(
    await verifyCommitment(
      id(req.params.id),
      z
        .enum(["RULES", "SETTLEMENT"])
        .default("SETTLEMENT")
        .parse(req.query.kind),
    ),
  ),
);
app.get("/api/markets/:id/bus", async (req, res) =>
  res.json({ snapshot: await busSnapshot(id(req.params.id)) }),
);
app.get("/api/admin/health", async (req, res) => {
  await admin(req);
  res.json(await diagnostics());
});
app.get("/api/admin/reconcile", async (req, res) => {
  await admin(req);
  res.json(await reconcile(envId(req)));
});
app.post("/api/admin/markets", async (req, res) => {
  await admin(req);
  const input = createMarketInput.parse(req.body);
  await scopedIdentity(req, input.environmentId);
  res.json(await createMarket(input));
});
app.post("/api/admin/markets/:id/status", async (req, res) => {
  await admin(req);
  const marketId = id(req.params.id),
    m = await db.market.findUniqueOrThrow({ where: { id: marketId } });
  await scopedIdentity(req, m.environmentId);
  res.json(
    await lifecycle(
      marketId,
      z.enum(["OPEN", "PAUSED", "CLOSED"]).parse(req.body.status),
    ),
  );
});
app.post("/api/admin/markets/:id/settle", async (req, res) => {
  const user = await admin(req),
    marketId = id(req.params.id),
    m = await db.market.findUniqueOrThrow({ where: { id: marketId } });
  await scopedIdentity(req, m.environmentId);
  res.json(
    await settle(marketId, evidenceSchema.parse(req.body), user.profile.id),
  );
});
app.post("/api/admin/demo", async (req, res) => {
  await admin(req);
  res.json(
    await newDemo(
      z
        .number()
        .int()
        .min(0)
        .max(2147483647)
        .default(2026)
        .parse(req.body.seed),
    ),
  );
});
app.post("/api/admin/demo/:id", async (req, res) => {
  await admin(req);
  const environmentId = id(req.params.id),
    env = await db.environment.findUniqueOrThrow({
      where: { id: environmentId },
    });
  ensure(env.kind === "DEMO", "FORBIDDEN", 403);
  const input = z
    .object({
      runState: z.enum(["RUNNING", "PAUSED"]),
      speed: z.number().int().min(1).max(10),
    })
    .parse(req.body);
  res.json(
    await db.environment.update({ where: { id: environmentId }, data: input }),
  );
});
app.use(
  (
    error: unknown,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    const e = error as { code?: string; status?: number; type?: string };
    if (e.type === "entity.parse.failed" || e.type === "entity.too.large") {
      res.status(e.status ?? 400).json({ error: { code: "INVALID_INPUT" } });
      return;
    }
    if (error instanceof ZodError) {
      res
        .status(400)
        .json({ error: { code: "INVALID_INPUT", details: error.issues } });
      return;
    }
    if (error instanceof AppError) {
      res.status(error.status).json({ error: { code: error.code } });
      return;
    }
    if (e.code === "P2025") {
      res.status(404).json({ error: { code: "NOT_FOUND" } });
      return;
    }
    console.error("Request failed", e.code ?? "INTERNAL");
    res.status(503).json({ error: { code: "TEMPORARILY_UNAVAILABLE" } });
  },
);
if (process.env.NODE_ENV !== "test") {
  const server = app.listen(
    Number(process.env.PORT ?? 3001),
    localDemo ? "127.0.0.1" : "0.0.0.0",
    () => console.log("HackRU API ready"),
  );
  const stop = () =>
    server.close(() => {
      void db.$disconnect().then(() => process.exit(0));
    });
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
