import { describe, it, expect } from "vitest";
import { dayInterval, settingsSchema } from "../server/automation/core";
import { observedAverage, roundThreshold } from "../server/automation/weather";
import {
  advanceVisit,
  emptyVisit,
  type Telemetry,
} from "../server/automation/bus-state";
import { normalizeGame } from "../server/automation/providers";
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
});
