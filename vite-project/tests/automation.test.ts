import { describe, it, expect } from "vitest";
import { dayInterval, settingsSchema } from "../server/automation/core";
import { observedAverage, roundThreshold } from "../server/automation/weather";
import {
  advanceVisit,
  emptyVisit,
  type Telemetry,
} from "../server/automation/bus-state";
import { evaluateScheduledMarket } from "../server/automation/bus";
import { normalizeEspnGame, normalizeGame } from "../server/automation/providers";
import { sportsResult, seasons } from "../server/automation/sports";
const s = settingsSchema.parse({
  stops: [
    {
      id: "fixture",
      name: "Synthetic stop",
      latitude: 40.5,
      longitude: -74.4,
      sourceUrl: "https://example.invalid/stop",
    },
  ],
});
const base = Date.parse("2026-10-10T16:00:00Z");
const sample = (sec: number, offset = 0): Telemetry => ({
  provider: "fixture",
  vehicleId: "bus",
  sourceAt: new Date(base + sec * 1000).toISOString(),
  receivedAt: new Date(base + sec * 1000).toISOString(),
  latitude: 40.5 + offset,
  longitude: -74.4,
  routeId: "LX",
});
function visitUntil(seconds: number) {
  let v = advanceVisit(
    emptyVisit(),
    sample(-10, 0.001),
    s,
    new Date(base - 10000),
  );
  for (let t = 0; t <= seconds; t += 10)
    v = advanceVisit(v, sample(t), s, new Date(base + t * 1000));
  return v;
}
describe("weather calculation", () => {
  it.each([
    ["2026-03-08", 23],
    ["2026-11-01", 25],
    ["2026-10-11", 24],
  ])("uses actual hours on %s", (date, count) => {
    const { start, end } = dayInterval(String(date));
    expect((+end - +start) / 3600000).toBe(count);
    const rows = Array.from({ length: Number(count) }, (_, i) => ({
      sourceId: String(i),
      observedAt: new Date(+start + i * 3600000),
      temperatureF: 65,
    }));
    expect(observedAverage(start, end, rows).mean).toBe(65);
    expect(observedAverage(start, end, rows.slice(1)).mean).toBeNull();
  });
  it("deduplicates and excludes the end boundary", () => {
    const { start, end } = dayInterval("2026-10-11");
    const r = { sourceId: "a", observedAt: start, temperatureF: 60 };
    const a = observedAverage(start, end, [
      r,
      r,
      { ...r, sourceId: "end", observedAt: end },
    ]);
    expect(a.hourly[0].count).toBe(1);
    expect(a.complete).toBe(false);
  });
  it("rounds ties toward positive infinity", () => {
    expect(roundThreshold(62.5)).toBe(65);
    expect(roundThreshold(-2.5)).toBe(0);
  });
});
describe("continuous observed bus visits", () => {
  it("does not create a visit for an already parked startup bus", () => {
    expect(
      advanceVisit(emptyVisit(), sample(0), s, new Date(base)).visitId,
    ).toBeUndefined();
  });
  it("599 is not qualified; 600 is qualified", () => {
    let v = visitUntil(590);
    v = advanceVisit(v, sample(599), s, new Date(base + 599000));
    expect(v.state).toBe("DWELLING");
    v = advanceVisit(v, sample(600), s, new Date(base + 600000));
    expect(v.state).toBe("QUALIFIED");
  });
  it("duplicates and old observations do not advance dwell", () => {
    const v = visitUntil(100);
    expect(advanceVisit(v, sample(100), s, new Date(base + 110000))).toEqual(v);
    expect(advanceVisit(v, sample(50), s, new Date(base + 110000))).toEqual(v);
  });
  it("gaps are uncertain, never YES", () => {
    const v = advanceVisit(
      visitUntil(10),
      sample(600),
      s,
      new Date(base + 600000),
    );
    expect(v.state).toBe("UNCERTAIN");
  });
  it("jitter within fixed anchor keeps one visit", () => {
    let v = visitUntil(50);
    const id = v.visitId;
    for (let t = 60; t < 300; t += 10)
      v = advanceVisit(
        v,
        sample(t, t % 20 ? 0.00005 : -0.00005),
        s,
        new Date(base + t * 1000),
      );
    expect(v.visitId).toBe(id);
    expect(v.state).toBe("DWELLING");
  });
  it("departure before boundary wins over later confirmation", () => {
    let v = visitUntil(590);
    v = advanceVisit(v, sample(599, 0.0008), s, new Date(base + 599000));
    expect(v.state).toBe("DEPARTURE_CANDIDATE");
    v = advanceVisit(v, sample(605, 0.0008), s, new Date(base + 605000));
    expect(v.state).toBe("ENDED");
    expect(v.departureAt).toBe(sample(599).sourceAt);
  });
  it("a movement excursion is uncertain even if the next sample returns", () => {
    let v = visitUntil(100);
    v = advanceVisit(v, sample(110, 0.0003), s, new Date(base + 110000));
    v = advanceVisit(v, sample(120), s, new Date(base + 120000));
    expect(v.state).toBe("UNCERTAIN");
  });
});
describe("scheduled bus markets", () => {
  const opensAt = "2026-10-10T16:00:00.000Z";
  const deadline = "2026-10-10T16:02:00.000Z";
  const scheduled = { kind: "arrival_by_deadline" as const, routeId: "LX", stop: { latitude: 40.5, longitude: -74.4 }, opensAt, deadline };
  const settings = { enterMeters: 50, maxGapSeconds: 60, latenessSeconds: 10 };
  it("validates scheduled IDs, timing, and verified stop references", () => {
    expect(() => settingsSchema.parse({
      stops: [],
      scheduledMarkets: [{ id: "lx", kind: "arrival_by_deadline", vehicleId: "123", routeId: "LX", stopId: "missing", opensAt, closesAt: "2026-10-10T16:01:00.000Z", deadline, voidAfter: "2026-10-10T16:03:00.000Z" }],
    })).toThrow();
  });
  it("settles arrival YES only when the frozen vehicle enters before deadline", () => {
    const result = evaluateScheduledMarket(scheduled, [sample(30)], settings);
    expect(result).toMatchObject({ result: true });
  });
  it("settles arrival NO only with continuous source-time coverage", () => {
    const outside = (sec: number) => sample(sec, 0.001);
    const result = evaluateScheduledMarket(scheduled, [outside(0), outside(60), outside(120)], settings);
    expect(result).toMatchObject({ result: false });
    expect(evaluateScheduledMarket(scheduled, [outside(0), outside(120)], settings)).toBeNull();
  });
  it("keeps gaps, stale rows, route changes, and conflicts from proving NO", () => {
    const outside = (sec: number) => sample(sec, 0.001);
    expect(evaluateScheduledMarket(scheduled, [{ ...outside(0), receivedAt: sample(20).sourceAt }], settings)).toMatchObject({ void: "STALE_SOURCE_OBSERVATION" });
    expect(evaluateScheduledMarket(scheduled, [{ ...outside(0), routeId: "A" }], settings)).toMatchObject({ void: "ROUTE_IDENTITY_CHANGED" });
    expect(evaluateScheduledMarket(scheduled, [outside(0), { ...outside(0), latitude: 40.6 }], settings)).toMatchObject({ void: "CONFLICTING_SOURCE_OBSERVATION" });
  });
  it("uses the first qualifying post-target observation for presence", () => {
    const targetTime = deadline;
    const market = { ...scheduled, kind: "presence_at_time" as const, targetTime };
    const inside = sample(120), outside = sample(125, 0.001);
    expect(evaluateScheduledMarket(market, [inside, outside], settings)).toMatchObject({ result: true });
    expect(evaluateScheduledMarket(market, [outside], settings)).toMatchObject({ result: false });
    expect(evaluateScheduledMarket(market, [sample(151)], settings)).toBeNull();
  });
});
describe("documented sports schemas", () => {
  const raw = {
    id: 1,
    season: 2027,
    startDate: "2026-11-10T18:00:00Z",
    startTimeTbd: false,
    homeTeamId: 1,
    awayTeamId: 2,
    homeTeam: "Opponent",
    awayTeam: "Rutgers",
    homePoints: 50,
    awayPoints: 60,
    status: "final",
  };
  it("maps away winner and rejects scheduled/null scores", () => {
    const g = normalizeGame("CBBD", raw);
    expect(sportsResult(g, 2)).toBe(true);
    expect(sportsResult({ ...g, status: "scheduled" }, 2)).toBeNull();
    expect(sportsResult({ ...g, awayPoints: null }, 2)).toBeNull();
    expect(sportsResult({ ...g, awayPoints: 50 }, 2)).toBe("VOID");
    expect(sportsResult({ ...g, status: "postponed" }, 2)).toBeNull();
    expect(sportsResult({ ...g, status: "cancelled" }, 2)).toBe("VOID");
  });
  it("maps football home IDs", () => {
    const g = normalizeGame("CFBD", {
      ...raw,
      season: 2026,
      startTimeTBD: false,
      homeId: 2,
      awayId: 1,
      homeTeam: "Rutgers",
      awayTeam: "Opponent",
      completed: true,
    });
    expect(sportsResult(g, 2)).toBe(false);
  });
  it("uses ending-year basketball seasons", () => {
    expect(seasons("basketball", new Date("2026-12-01T12:00:00Z"))).toContain(
      2027,
    );
    expect(seasons("basketball", new Date("2027-02-01T12:00:00Z"))[1]).toBe(
      2027,
    );
  });
  it("normalizes the public ESPN event shape", () => {
    const g = normalizeEspnGame({
      id: "401000001",
      date: "2026-10-17T16:00:00Z",
      season: { year: 2026 },
      competitions: [
        {
          competitors: [
            {
              homeAway: "home",
              team: { id: "164", displayName: "Rutgers Scarlet Knights" },
              score: "31",
            },
            {
              homeAway: "away",
              team: { id: "1208", displayName: "Maryland Terrapins" },
              score: "24",
            },
          ],
          status: { type: { state: "post", completed: true, name: "STATUS_FINAL" } },
        },
      ],
    });
    expect(g.homeId).toBe(164);
    expect(g.awayPoints).toBe(24);
    expect(g.status).toBe("final");
    expect(sportsResult(g, 164, "team-points", 24.5)).toBe(true);
    expect(sportsResult(g, 164, "total-points", 55.5)).toBe(false);
  });
});
