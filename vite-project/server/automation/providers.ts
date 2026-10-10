import { z } from "zod";
import { db, ensure } from "../db";
import { hash } from "../math";
import { footballGame, basketballGame } from "../providers";
import { nowFor, add } from "./core";

// Persistent shared cache and provider-wide cooldown. Never cache an error as evidence.
export async function providerJson(
  environmentId: string,
  url: string,
  headers: Record<string, string> = {},
  ttl = 60,
): Promise<unknown> {
  const env = await db.environment.findUniqueOrThrow({
    where: { id: environmentId },
  });
  ensure(env.kind === "LIVE", "LIVE_PROVIDER_IN_DEMO");
  const at = await nowFor(environmentId),
    host = new URL(url).hostname;
  const key = `http:${hash(url)}`;
  const cached = await db.automationState.findUnique({
    where: { environmentId_key: { environmentId, key } },
  });
  if (cached && +cached.updatedAt + ttl * 1000 > +at)
    return (cached.data as { body: unknown }).body;
  const cooldown = await db.automationState.findUnique({
    where: { environmentId_key: { environmentId, key: `cooldown:${host}` } },
  });
  if (cooldown && +new Date((cooldown.data as { until: string }).until) > +at)
    throw new Error("PROVIDER_RATE_LIMITED");
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(10000) });
  if (r.status === 429 || r.status === 503) {
    const retry = r.headers.get("retry-after");
    const seconds =
      retry && /^\d+$/.test(retry)
        ? Number(retry)
        : retry
          ? (+new Date(retry) - +at) / 1000
          : 60;
    const data = {
      until: add(
        at,
        Math.max(60, Math.min(86400, seconds || 60)),
      ).toISOString(),
    };
    await db.automationState.upsert({
      where: { environmentId_key: { environmentId, key: `cooldown:${host}` } },
      create: {
        environmentId,
        key: `cooldown:${host}`,
        kind: "COOLDOWN",
        data,
      },
      update: { data },
    });
    throw new Error("PROVIDER_RATE_LIMITED");
  }
  ensure(r.ok, `PROVIDER_HTTP_${r.status}`);
  const body: unknown = await r.json();
  await db.automationState.upsert({
    where: { environmentId_key: { environmentId, key } },
    create: { environmentId, key, kind: "CACHE", data: { url, body } as never },
    update: { data: { url, body } as never },
  });
  return body;
}
export const nwsPage = z.object({
  features: z.array(
    z.object({
      id: z.string(),
      properties: z.object({
        timestamp: z.string().datetime({ offset: true }),
        temperature: z.object({
          value: z.number().nullable(),
          unitCode: z.string(),
          qualityControl: z.string().optional(),
        }),
      }),
    }),
  ),
  pagination: z.object({ next: z.url().optional() }).optional(),
});
export async function observations(
  environmentId: string,
  station: string,
  start: Date,
  end: Date,
) {
  ensure(process.env.NWS_USER_AGENT, "MISSING_NWS_USER_AGENT");
  let url: string | undefined =
    `https://api.weather.gov/stations/${station}/observations?start=${start.toISOString()}&end=${end.toISOString()}&limit=500`;
  for (let page = 0; url && page < 20; page++) {
    ensure(
      new URL(url).origin === "https://api.weather.gov",
      "INVALID_NWS_PAGINATION",
    );
    const body = nwsPage.parse(
      await providerJson(
        environmentId,
        url,
        {
          "User-Agent": process.env.NWS_USER_AGENT!,
          Accept: "application/geo+json",
        },
        300,
      ),
    );
    for (const f of body.features) {
      const t = f.properties.temperature,
        observedAt = new Date(f.properties.timestamp);
      // Conservative v1: accept only NWS verified (V) Celsius values.
      if (
        t.value === null ||
        t.qualityControl !== "V" ||
        t.unitCode !== "wmoUnit:degC" ||
        t.value < -90 ||
        t.value > 60 ||
        observedAt < start ||
        observedAt >= end
      )
        continue;
      await db.weatherObservation.upsert({
        where: {
          environmentId_station_sourceId: {
            environmentId,
            station,
            sourceId: f.id,
          },
        },
        create: {
          environmentId,
          station,
          sourceId: f.id,
          observedAt,
          temperatureF: (t.value * 9) / 5 + 32,
          quality: "V",
        },
        update: {},
      });
    }
    url = body.pagination?.next;
  }
  ensure(!url, "NWS_PAGINATION_LIMIT");
}
const football = footballGame.extend({
  season: z.number().int(),
  startTimeTBD: z.boolean(),
  homeId: z.number().int(),
  awayId: z.number().int(),
});
const basketball = basketballGame.extend({
  season: z.number().int(),
  startTimeTbd: z.boolean(),
  homeTeamId: z.number().int(),
  awayTeamId: z.number().int(),
});
export type Game = {
  id: string;
  season: number;
  start: string;
  tbd: boolean;
  homeId: number;
  awayId: number;
  home: string;
  away: string;
  homePoints: number | null;
  awayPoints: number | null;
  status: string;
  raw: unknown;
};

export type EspnSport = "football" | "basketball";
export const espnScheduleUrl = (sport: EspnSport) =>
  sport === "football"
    ? "https://site.api.espn.com/apis/site/v2/sports/football/college-football/teams/164/schedule"
    : "https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball/teams/164/schedule";
export const espnScoreboardUrl = (sport: EspnSport, date?: string) => {
  const base =
    sport === "football"
      ? "https://site.api.espn.com/apis/site/v2/sports/football/college-football/scoreboard?groups=80&limit=500"
      : "https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball/scoreboard?groups=50&limit=500";
  return date ? `${base}&dates=${date}` : base;
};
const espnSummaryUrl = (sport: EspnSport, eventId: string) =>
  `${sport === "football" ? "https://site.api.espn.com/apis/site/v2/sports/football/college-football" : "https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball"}/summary?event=${encodeURIComponent(eventId)}`;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}
function numberValue(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}
function espnScore(value: unknown) {
  const r = record(value);
  return numberValue(r?.value ?? r?.displayValue ?? value);
}
function espnEventSource(raw: unknown, eventId?: string) {
  const root = record(raw);
  if (!root) return null;
  const header = record(root.header);
  const event = header ?? root;
  if (Array.isArray(event.events)) {
    const found = event.events.find((candidate) => {
      const r = record(candidate);
      return !eventId || String(r?.id ?? "") === eventId;
    });
    if (found) return record(found);
  }
  if (eventId && event.id && String(event.id) !== eventId) return null;
  return event;
}
export function normalizeEspnGame(raw: unknown, eventId?: string): Game {
  const event = espnEventSource(raw, eventId),
    competition = record(
      Array.isArray(event?.competitions) ? event.competitions[0] : null,
    );
  ensure(event && competition, "ESPN_EVENT_SHAPE_INVALID");
  const competitors = Array.isArray(competition.competitors)
    ? competition.competitors.map(record).filter(Boolean)
    : [];
  ensure(competitors.length >= 2, "ESPN_COMPETITORS_MISSING");
  const home = competitors.find((c) => c?.homeAway === "home") ?? competitors[0],
    away = competitors.find((c) => c?.homeAway === "away") ?? competitors[1],
    homeTeam = record(home?.team),
    awayTeam = record(away?.team),
    homeId = numberValue(homeTeam?.id),
    awayId = numberValue(awayTeam?.id),
    start = String(event.date ?? competition.date ?? "");
  ensure(
    event.id !== undefined && homeId !== null && awayId !== null && start,
    "ESPN_EVENT_FIELDS_MISSING",
  );
  const status = record(competition.status),
    statusType = record(status?.type),
    statusText = `${statusType?.name ?? ""} ${statusType?.state ?? ""} ${statusType?.description ?? ""} ${status?.type ?? ""}`.toLowerCase(),
    cancelled = /cancel|postpon/.test(statusText),
    final = Boolean(statusType?.completed) || /final|post/.test(statusText),
    statusValue = cancelled
      ? /postpon/.test(statusText)
        ? "postponed"
        : "cancelled"
      : final
        ? "final"
        : /in_progress|in progress|live/.test(statusText)
          ? "in_progress"
          : "scheduled";
  return {
    id: String(event.id),
    season:
      numberValue(record(event.season)?.year) ?? new Date(start).getUTCFullYear(),
    start,
    tbd: !start || /tbd|time to be determined/i.test(statusText),
    homeId,
    awayId,
    home: String(homeTeam?.displayName ?? homeTeam?.shortDisplayName ?? "Home"),
    away: String(awayTeam?.displayName ?? awayTeam?.shortDisplayName ?? "Away"),
    homePoints: espnScore(home?.score),
    awayPoints: espnScore(away?.score),
    status: statusValue,
    raw,
  };
}
function espnEvents(raw: unknown) {
  const root = record(raw);
  return Array.isArray(root?.events) ? root.events : [];
}
export async function espnGames(
  environmentId: string,
  sport: EspnSport,
  ttl = 21600,
) {
  const schedule = await providerJson(
    environmentId,
    espnScheduleUrl(sport),
    { Accept: "application/json" },
    ttl,
  );
  const byId = new Map(
    espnEvents(schedule).map((raw) => {
      const game = normalizeEspnGame(raw);
      return [game.id, game] as const;
    }),
  );
  if (ttl <= 60) {
    const scoreboard = await providerJson(
      environmentId,
      espnScoreboardUrl(sport),
      { Accept: "application/json" },
      60,
    );
    for (const raw of espnEvents(scoreboard)) {
      const game = normalizeEspnGame(raw);
      if (byId.has(game.id)) byId.set(game.id, game);
    }
  }
  // ESPN sometimes leaves the team schedule empty during basketball
  // preseason even though dated scoreboard pages already contain the games.
  // Scan a bounded window only in that case, and keep Rutgers events only.
  if (sport === "basketball" && byId.size === 0) {
    const at = new Date();
    for (let offset = 0; offset < 45 && byId.size < 3; offset++) {
      const date = new Date(+at + offset * 86400000)
        .toISOString()
        .slice(0, 10)
        .replaceAll("-", "");
      const scoreboard = await providerJson(
        environmentId,
        espnScoreboardUrl(sport, date),
        { Accept: "application/json" },
        ttl,
      );
      for (const raw of espnEvents(scoreboard)) {
        const game = normalizeEspnGame(raw);
        if (game.homeId === 164 || game.awayId === 164)
          byId.set(game.id, game);
      }
    }
  }
  return [...byId.values()];
}
export async function espnGame(
  environmentId: string,
  sport: EspnSport,
  eventId: string,
  ttl = 60,
) {
  const raw = await providerJson(
    environmentId,
    espnSummaryUrl(sport, eventId),
    { Accept: "application/json" },
    ttl,
  );
  return normalizeEspnGame(raw, eventId);
}
export function normalizeGame(provider: "CFBD" | "CBBD", raw: unknown): Game {
  if (provider === "CFBD") {
    const g = football.parse(raw);
    return {
      id: String(g.id),
      season: g.season,
      start: g.startDate,
      tbd: g.startTimeTBD,
      homeId: g.homeId,
      awayId: g.awayId,
      home: g.homeTeam,
      away: g.awayTeam,
      homePoints: g.homePoints,
      awayPoints: g.awayPoints,
      status: g.completed ? "final" : "scheduled",
      raw,
    };
  }
  const g = basketball.parse(raw);
  return {
    id: String(g.id),
    season: g.season,
    start: g.startDate,
    tbd: g.startTimeTbd,
    homeId: g.homeTeamId,
    awayId: g.awayTeamId,
    home: g.homeTeam,
    away: g.awayTeam,
    homePoints: g.homePoints,
    awayPoints: g.awayPoints,
    status: g.status,
    raw,
  };
}
export async function games(
  environmentId: string,
  provider: "CFBD" | "CBBD",
  season: number,
  ttl = 60,
) {
  const token =
    process.env[provider === "CFBD" ? "CFBD_API_KEY" : "CBBD_API_KEY"];
  ensure(token, `MISSING_${provider}_API_KEY`);
  const base =
    provider === "CFBD"
      ? "https://api.collegefootballdata.com/games"
      : "https://api.collegebasketballdata.com/games";
  const url = `${base}?${provider === "CFBD" ? "year" : "season"}=${season}&team=Rutgers`;
  const raw = z
    .array(z.unknown())
    .max(3000)
    .parse(
      await providerJson(
        environmentId,
        url,
        { Authorization: `Bearer ${token}` },
        ttl,
      ),
    );
  ensure(raw.length < 3000, "SPORTS_RESPONSE_TRUNCATED");
  const normalized = raw.map((g) => normalizeGame(provider, g));
  // The football season endpoint has completed but no in-progress field.
  // Use the documented current scoreboard only to close trading early.
  if (provider === "CFBD" && ttl <= 60) {
    const scores = z
      .array(
        z.object({
          id: z.number(),
          status: z.enum(["scheduled", "in_progress", "completed"]),
        }),
      )
      .parse(
        await providerJson(
          environmentId,
          "https://api.collegefootballdata.com/scoreboard",
          { Authorization: `Bearer ${token}` },
          60,
        ),
      );
    for (const g of normalized)
      if (
        scores.some(
          (s) => String(s.id) === g.id && s.status === "in_progress",
        ) &&
        g.status !== "final"
      )
        g.status = "in_progress";
  }
  return normalized;
}
