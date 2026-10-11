import { z } from "zod";
import { evidenceSchema, type ProviderEvidence } from "../shared/contracts";
import type { Market } from "../generated/prisma/client";
import { ensure } from "./db";
const gameBase = z.object({
  id: z.number().int(),
  homeTeam: z.string(),
  awayTeam: z.string(),
  homePoints: z.number().int().nonnegative().nullable(),
  awayPoints: z.number().int().nonnegative().nullable(),
  startDate: z.iso.datetime(),
});
export const footballGame = gameBase.extend({ completed: z.boolean() });
export const basketballGame = gameBase.extend({
  status: z.enum([
    "scheduled",
    "in_progress",
    "final",
    "postponed",
    "cancelled",
  ]),
});
export function normalizeSports(
  provider: "CFBD" | "CBBD",
  raw: unknown,
  market: Pick<
    Market,
    "externalEventId" | "sourceUrl" | "opensAt" | "closesAt"
  >,
  receivedAt: Date,
): ProviderEvidence | null {
  const game =
    provider === "CFBD" ? footballGame.parse(raw) : basketballGame.parse(raw);
  ensure(
    String(game.id) === market.externalEventId &&
      (game.homeTeam === "Rutgers" || game.awayTeam === "Rutgers"),
    "PROVIDER_EVENT_MISMATCH",
  );
  ensure(
    market.closesAt <= new Date(game.startDate),
    "SPORTS_CUTOFF_AFTER_START",
  );
  const cancelled =
    "status" in game && ["postponed", "cancelled"].includes(game.status);
  const final = "completed" in game ? game.completed : game.status === "final";
  if (!final && !cancelled) return null;
  if (!cancelled)
    ensure(
      game.homePoints !== null && game.awayPoints !== null,
      "PROVIDER_SCORE_MISSING",
    );
  const win =
    game.homeTeam === "Rutgers"
      ? game.homePoints! > game.awayPoints!
      : game.awayPoints! > game.homePoints!;
  // These APIs do not provide a verified finish timestamp. observedAt is explicitly
  // the time the adapter observed final status, never a fabricated game-end time.
  return evidenceSchema.parse({
    provider,
    externalEventId: String(game.id),
    observedAt: receivedAt.toISOString(),
    receivedAt: receivedAt.toISOString(),
    isFinal: true,
    sourceUrl: market.sourceUrl,
    normalizedData: {
      units: "boolean",
      ...(cancelled ? { cancelled: true } : { result: win }),
      finalScore: `${game.homeTeam} ${game.homePoints} — ${game.awayTeam} ${game.awayPoints}`,
    },
    rawPayload: {
      providerGame: raw,
      observationSemantics: "final status observed at fetch time",
    },
  });
}
export async function fetchEvidence(
  market: Market,
): Promise<ProviderEvidence | null> {
  if (market.provider === "CFBD" || market.provider === "CBBD") {
    const provider = market.provider,
      token =
        process.env[provider === "CFBD" ? "CFBD_API_KEY" : "CBBD_API_KEY"];
    if (!token) return null;
    const context = z
      .object({ season: z.number().int().min(2020).max(2100) })
      .parse(market.context);
    const url = new URL(
      provider === "CFBD"
        ? "https://api.collegefootballdata.com/games"
        : "https://api.collegebasketballdata.com/games",
    );
    url.searchParams.set(
      provider === "CFBD" ? "year" : "season",
      String(context.season),
    );
    url.searchParams.set("team", "Rutgers");
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return null;
    const data = z
      .array(z.unknown())
      .max(3000)
      .parse(await response.json());
    const raw = data.find(
      (g) =>
        typeof g === "object" &&
        g !== null &&
        String((g as { id: unknown }).id) === market.externalEventId,
    );
    return raw ? normalizeSports(provider, raw, market, new Date()) : null;
  }
  // Teammates can supply bus observations through this fixed, server-owned
  // endpoint. No user-supplied URL is fetched. Missing data remains pending.
  if (process.env.EVIDENCE_ADAPTER_URL) {
    const url = new URL(process.env.EVIDENCE_ADAPTER_URL);
    url.searchParams.set("marketId", market.id);
    const r = await fetch(url, {
      signal: AbortSignal.timeout(5000),
      headers: process.env.EVIDENCE_ADAPTER_TOKEN
        ? { Authorization: `Bearer ${process.env.EVIDENCE_ADAPTER_TOKEN}` }
        : {},
    });
    if (r.status === 204 || !r.ok) return null;
    return evidenceSchema.parse(await r.json());
  }
  return null;
}
