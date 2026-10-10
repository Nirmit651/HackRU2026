import { it, expect } from "vitest";
import { EventBuffer, collapseEvents } from "../shared/recovery";
import type { PublicEvent } from "../shared/contracts";
const event = (version: number): PublicEvent => ({
  id: String(version),
  marketId: "market",
  version: String(version),
  kind: "PRICE_CHANGED",
  occurredAt: "2026-10-10T16:00:00Z",
  yesPrice: "0.6",
  tradeAmountMicros: "1000000",
  payload: {},
});
it("buffers before snapshot, discards duplicates and recovers gaps", () => {
  const b = new EventBuffer();
  b.push(event(2));
  b.push(event(4));
  b.snapshot("2");
  expect(b.gap).toBe(true);
  b.push(event(3));
  expect(b.drain().map((e) => e.version)).toEqual(["3", "4"]);
  b.push(event(3));
  expect(b.drain()).toEqual([]);
});
it("collapses display seconds while conserving all trade volume", () => {
  const points = collapseEvents([event(3), event(1), event(2)]);
  expect(points).toHaveLength(1);
  expect(points[0].volume).toBe(3000000n);
});
