import { describe, expect, it } from "vitest";
import { findCollegeAveStops, selectNextArrival } from "../server/tripshot";

const stops = [
  { id: "a", name: "College Avenue Student Center", latitude: 40.5, longitude: -74.4 },
  { id: "b", name: "College Ave Student Center - northbound", latitude: 40.501, longitude: -74.401 },
  { id: "c", name: "Busch Student Center", latitude: 40.52, longitude: -74.46 },
];
describe("TripShot GTFS selection", () => {
  it("matches all College Ave platforms by normalized stop name", () => expect(findCollegeAveStops(stops).map((stop) => stop.id)).toEqual(["a", "b"]));
  it("chooses the earliest future valid prediction across platforms", () => {
    const now = 1_700_000_000_000, trips = new Map([["late", { id: "late", routeId: "B" }], ["early", { id: "early", routeId: "A" }]]);
    const result = selectNextArrival([{ tripUpdate: { trip: { tripId: "late" }, stopTimeUpdate: [{ stopId: "a", arrival: { time: now / 1000 + 180 } }] } }, { tripUpdate: { trip: { tripId: "early" }, stopTimeUpdate: [{ stopId: "b", arrival: { time: now / 1000 + 90 } }] } }], new Set(["a", "b"]), trips, now);
    expect(result?.tripId).toBe("early");
  });
  it("ignores cancelled and expired predictions", () => {
    const now = 1_700_000_000_000, trips = new Map([["x", { id: "x", routeId: "A" }]]);
    expect(selectNextArrival([{ tripUpdate: { trip: { tripId: "x", scheduleRelationship: 3 }, stopTimeUpdate: [{ stopId: "a", arrival: { time: now / 1000 + 60 } }] } }, { tripUpdate: { trip: { tripId: "x" }, stopTimeUpdate: [{ stopId: "a", arrival: { time: now / 1000 - 1 } }] } }], new Set(["a"]), trips, now)).toBeNull();
  });
});
