import { describe, expect, it } from "vitest";
import { presentationBotSide, presentationEventId, presentationFundingKey, presentationOutcome, presentationRuleFor, timerYesSignal } from "../server/presentation";

describe("presentation timer signal", () => {
  it("starts neutral and approaches certainty without forcing 100%", () => {
    expect(timerYesSignal(0)).toBe(.5);
    expect(timerYesSignal(15)).toBe(.55);
    expect(timerYesSignal(35)).toBe(.68);
    expect(timerYesSignal(50)).toBe(.86);
    expect(timerYesSignal(57)).toBe(.96);
    expect(timerYesSignal(60)).toBe(.995);
  });

  it("clamps timer values to the authoritative one-minute window", () => {
    expect(timerYesSignal(-1)).toBe(.5);
    expect(timerYesSignal(999)).toBe(.995);
  });
});

describe("presentation settlement rule", () => {
  const deadline = new Date("2026-10-10T12:01:00.000Z");
  it("settles NO for a server-recorded finish before 60 seconds", () => {
    expect(presentationOutcome(deadline, new Date("2026-10-10T12:00:59.999Z"))).toBe("NO");
    expect(presentationOutcome(deadline, new Date("2026-10-10T12:01:00.000Z"))).toBe("YES");
  });
  it("settles YES if no finish was recorded by the deadline", () => {
    expect(presentationOutcome(deadline)).toBe("YES");
  });
  it("uses one run-specific ID for both the market rule and its evidence", () => {
    const runId = "f6fd29b3-6df6-4e90-a3c2-61d5d6c23401";
    const eventId = presentationEventId(runId);
    expect(eventId).toBe("presentation-f6fd29b3-6df6-4e90-a3c2-61d5d6c23401");
    expect(presentationRuleFor(deadline, deadline, eventId).externalEventId).toBe(eventId);
  });
  it("uses a unique immutable funding key for every presentation run", () => {
    expect(presentationFundingKey("run-a")).toBe("fund:presentation:run-a");
    expect(presentationFundingKey("run-a")).not.toBe(presentationFundingKey("run-b"));
  });
});

describe("forced whale trades", () => {
  it("honors the admin-selected side instead of the timer signal", () => {
    expect(presentationBotSide(.99, 58, .01, true, "WHALE", "NO")).toBe("NO");
    expect(presentationBotSide(.01, 2, .99, true, "WHALE", "YES")).toBe("YES");
  });
});
