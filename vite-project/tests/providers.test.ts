import { it, expect } from "vitest";
import { normalizeSports } from "../server/providers";
const m = {
    externalEventId: "4",
    sourceUrl: "https://example.com/official",
    opensAt: new Date("2026-10-10T12:00:00Z"),
    closesAt: new Date("2026-10-10T15:00:00Z"),
  },
  game = {
    id: 4,
    homeTeam: "Rutgers",
    awayTeam: "Fixture opponent",
    homePoints: 21,
    awayPoints: 14,
    startDate: "2026-10-10T16:00:00Z",
  };
it("never turns in-progress results into settlement evidence", () => {
  expect(
    normalizeSports("CFBD", { ...game, completed: false }, m, new Date()),
  ).toBeNull();
  expect(
    normalizeSports("CBBD", { ...game, status: "in_progress" }, m, new Date()),
  ).toBeNull();
});
it("uses final scores and rejects the wrong event", () => {
  expect(
    normalizeSports("CFBD", { ...game, completed: true }, m, new Date())
      ?.normalizedData.result,
  ).toBe(true);
  expect(() =>
    normalizeSports("CFBD", { ...game, id: 5, completed: true }, m, new Date()),
  ).toThrow("PROVIDER_EVENT_MISMATCH");
});
it("voids postponed/cancelled basketball rather than resolving NO", () => {
  expect(
    normalizeSports("CBBD", { ...game, status: "postponed" }, m, new Date())
      ?.normalizedData.cancelled,
  ).toBe(true);
});
