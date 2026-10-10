import { describe, expect, it } from "vitest";
import { presentationOutcome, timerYesSignal } from "../server/presentation";

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
  it("settles YES only for a server-recorded finish before 60 seconds", () => {
    expect(presentationOutcome(deadline, new Date("2026-10-10T12:00:59.999Z"))).toBe("YES");
    expect(presentationOutcome(deadline, new Date("2026-10-10T12:01:00.000Z"))).toBe("NO");
  });
  it("settles NO if no finish was recorded by the deadline", () => {
    expect(presentationOutcome(deadline)).toBe("NO");
  });
});
