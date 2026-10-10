import { DateTime } from "luxon";
import { db, ensure } from "../db";
import { hash } from "../math";
import { ruleSchema } from "../../shared/contracts";
import type { AutomationConfig, Market } from "../../generated/prisma/client";
import {
  settingsSchema,
  nowFor,
  zone,
  add,
  iso,
  rule,
  slug,
  createAutomatedMarket,
  finish,
  close,
} from "./core";
import { games, type Game } from "./providers";
import { enqueue } from "./queue";

export function seasons(type: string, at: Date) {
  const local = DateTime.fromJSDate(at, { zone });
  const season =
    type === "basketball"
      ? local.year + (local.month >= 7 ? 1 : 0)
      : local.year;
  return [season - 1, season, season + 1];
}
export function sportsResult(g: Game, teamId: number): boolean | "VOID" | null {
  ensure(g.homeId === teamId || g.awayId === teamId, "SPORTS_TEAM_MISMATCH");
  if (g.status === "cancelled") return "VOID";
  if (g.status !== "final" || g.homePoints === null || g.awayPoints === null)
    return null;
  if (g.homePoints === g.awayPoints) return "VOID";
  return g.homeId === teamId
    ? g.homePoints > g.awayPoints
    : g.awayPoints > g.homePoints;
}
export async function generateSports(
  config: AutomationConfig,
  supplied?: Game[],
) {
  const at = await nowFor(config.environmentId),
    s = settingsSchema.parse(config.settings),
    provider = config.type === "football" ? "CFBD" : "CBBD";
  const env = await db.environment.findUniqueOrThrow({
    where: { id: config.environmentId },
  });
  if (supplied) ensure(env.kind === "DEMO", "SIMULATED_LIVE_SCHEDULE");
  const schedule =
    supplied ??
    (
      await Promise.all(
        seasons(config.type, at).map((season) =>
          games(env.id, provider, season, 21600),
        ),
      )
    ).flat();
  const candidates = schedule
    .filter(
      (g) =>
        !g.tbd &&
        g.status === "scheduled" &&
        +new Date(g.start) > +add(at, 300) &&
        +new Date(g.start) <= +add(at, s.horizonDays * 86400),
    )
    .sort((a, b) => +new Date(a.start) - +new Date(b.start))
    .slice(0, 5);
  let created = 0;
  for (const g of candidates) {
    const teamId =
      s.teamId ??
      (g.home === "Rutgers"
        ? g.homeId
        : g.away === "Rutgers"
          ? g.awayId
          : undefined);
    ensure(
      teamId !== undefined && (g.homeId === teamId || g.awayId === teamId),
      "RUTGERS_NOT_IDENTIFIED",
    );
    const competition =
        config.type === "football" ? "NCAA football" : "NCAA men's basketball",
      opponent = g.homeId === teamId ? g.away : g.home;
    const key = `sports:${provider}:${config.type}:${g.id}:rutgers-win`;
    if (
      await db.market.findUnique({
        where: {
          environmentId_generatorKey: {
            environmentId: env.id,
            generatorKey: key,
          },
        },
      })
    )
      continue;
    const start = new Date(g.start),
      cutoff = add(start, -300),
      deadline = add(start, 48 * 3600);
    const condition = `YES: Rutgers wins; NO: ${opponent} wins. Two matching explicit final results at least 60 seconds apart required. Ties and cancellations VOID. A schedule change closes trading without reopening. Await postponed completion until 48 hours after the original start, then VOID.`;
    const r = rule(
      config.type as "football" | "basketball",
      env.kind === "DEMO" ? `demo-${provider}` : provider,
      g.id,
      cutoff,
      at,
      deadline,
      deadline,
      {
        competition,
        season: g.season,
        teamId,
        opponentId: g.homeId === teamId ? g.awayId : g.homeId,
        opponent,
        originalStart: g.start,
        homeId: g.homeId,
        awayId: g.awayId,
        confirmationSeconds: 60,
      },
      condition,
    );
    r.tiePolicy = "VOID";
    r.postponementPolicy = "WAIT_48H_THEN_VOID";
    const market = await createAutomatedMarket({
      environmentId: env.id,
      generatorKey: key,
      templateVersion: 1,
      slug: slug(key),
      title: `Will Rutgers beat ${opponent} on ${DateTime.fromISO(g.start).setZone(zone).toISODate()}?`,
      description: `${competition}. ${condition}`,
      category: "VARSITY_SPORTS",
      opensAt: iso(at),
      closesAt: iso(cutoff),
      expectedResolutionAt: iso(add(start, 4 * 3600)),
      resolutionRule: r,
      sourceUrl:
        provider === "CFBD"
          ? "https://api.collegefootballdata.com/games"
          : "https://api.collegebasketballdata.com/games",
      context: {
        competition,
        season: g.season,
        teamId,
        opponent,
        homeAway: g.homeId === teamId ? "home" : "away",
        scheduledStart: g.start,
        sourceSnapshot: g.raw,
      },
    });
    if (!market.creationReplayed) created++;
  }
  return {
    created,
    skipped: schedule.length - created,
    reason: candidates.length ? "SYNCED" : "NO_ELIGIBLE_GAMES_OR_START_TBD",
  };
}
export async function monitorSports(m: Market, supplied?: Game) {
  const at = await nowFor(m.environmentId),
    r = ruleSchema.parse(m.resolutionRule),
    s = r.automation!.settings,
    provider = m.provider.endsWith("CFBD") ? "CFBD" : "CBBD";
  const env = await db.environment.findUniqueOrThrow({
    where: { id: m.environmentId },
  });
  if (supplied) ensure(env.kind === "DEMO", "SIMULATED_LIVE_RESULT");
  let game = supplied;
  if (!game && env.kind === "LIVE") {
    try {
      game = (await games(env.id, provider, Number(s.season))).find(
        (g) => g.id === m.externalEventId,
      );
    } catch {
      /* timeout policy still runs on outages */
    }
  }
  const original = new Date(String(s.originalStart));
  if (
    at >= m.closesAt ||
    (game &&
      (game.status !== "scheduled" ||
        game.tbd ||
        game.start !== s.originalStart ||
        at >= new Date(game.start)))
  )
    await close(m);
  if (
    game &&
    (game.id !== m.externalEventId ||
      game.homeId !== s.homeId ||
      game.awayId !== s.awayId)
  ) {
    await close(m);
    const key = `identity-review:${m.id}`;
    await db.automationState.upsert({
      where: { environmentId_key: { environmentId: env.id, key } },
      create: {
        environmentId: env.id,
        key,
        kind: "REVIEW",
        data: {
          marketId: m.id,
          requiresReview: true,
          reason: "SPORTS_EVENT_IDENTITY_CHANGED",
        },
      },
      update: {},
    });
    game = undefined;
  }
  if (game) {
    const result = sportsResult(game, Number(s.teamId)),
      key = `sports-result:${m.id}`;
    const current = hash({
      status: game.status,
      home: game.homePoints,
      away: game.awayPoints,
    });
    const previous = await db.automationState.findUnique({
      where: { environmentId_key: { environmentId: env.id, key } },
    });
    const data = previous?.data as
      { hash: string; firstAt: string; raw: unknown } | undefined;
    if (
      result !== null &&
      data?.hash === current &&
      +at - +new Date(data.firstAt) >= 60000 &&
      at <= new Date(r.voidAfter)
    ) {
      await finish(
        m,
        {
          units: "boolean",
          ...(result === "VOID" ? { cancelled: true } : { result }),
        },
        {
          firstPoll: data,
          confirmedAt: iso(at),
          finalResponse: game.raw,
          teamId: s.teamId,
        },
        at,
      );
      if (env.kind === "LIVE")
        await enqueue(
          env.id,
          `review:${m.id}`,
          "REVIEW",
          { marketId: m.id },
          add(at, 86400),
        );
      return;
    }
    if (data?.hash !== current)
      await db.automationState.upsert({
        where: { environmentId_key: { environmentId: env.id, key } },
        create: {
          environmentId: env.id,
          key,
          kind: "SPORTS_RESULT",
          data: { hash: current, firstAt: iso(at), raw: game.raw } as never,
        },
        update: {
          data: { hash: current, firstAt: iso(at), raw: game.raw } as never,
        },
      });
  }
  if (at >= new Date(r.voidAfter)) {
    await finish(
      m,
      { units: "boolean", missing: true },
      {
        reason: "NO_CONFIRMED_FINAL_BY_FROZEN_DEADLINE",
        lastResponse: game?.raw ?? null,
      },
      at,
    );
    return;
  }
  return add(
    at,
    +original - +at > 6 * 3600000
      ? 3600
      : +original - +at > 30 * 60000
        ? 300
        : 60,
  );
}
export async function reviewSports(m: Market) {
  const s = ruleSchema.parse(m.resolutionRule).automation!.settings;
  const game = (
    await games(
      m.environmentId,
      m.provider === "CFBD" ? "CFBD" : "CBBD",
      Number(s.season),
    )
  ).find((g) => g.id === m.externalEventId);
  if (!game) return;
  const result = sportsResult(game, Number(s.teamId));
  const settled = await db.settlement.findUniqueOrThrow({
    where: { marketId: m.id },
  });
  const changed =
    result !== null &&
    (result === "VOID" ? "VOID" : result ? "YES" : "NO") !== settled.outcome;
  const key = `review:${m.id}`,
    data = {
      marketId: m.id,
      requiresReview: changed,
      settledOutcome: settled.outcome,
      providerResult: result,
      response: game.raw,
    };
  await db.automationState.upsert({
    where: { environmentId_key: { environmentId: m.environmentId, key } },
    create: {
      environmentId: m.environmentId,
      key,
      kind: "REVIEW",
      data: data as never,
    },
    update: { data: data as never },
  });
}
