import { describe, expect, it } from "vitest";
import { timerYesSignal } from "../server/presentation";

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
