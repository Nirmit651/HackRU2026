import { describe, it, expect } from "vitest";
import { execution, price, hash } from "../server/math";
describe("LMSR", () => {
  it("has symmetric complementary prices and known costs", () => {
    expect(price(0n, 0n, 100000000n).toString()).toBe("0.5");
    expect(execution(0n, 0n, 100000000n, "YES", 10).costMicros).toBe(5124948n);
    expect(execution(0n, 0n, 100000000n, "NO", 10).costMicros).toBe(5124948n);
    expect(
      price(100n, 0n, 100000000n)
        .plus(price(0n, 100n, 100000000n))
        .toNumber(),
    ).toBe(1);
  });
  it("rounds upward, stays stable at extremes and covers reserves", () => {
    for (const [y, n] of [
      [0n, 0n],
      [1000000n, 0n],
      [0n, 1000000n],
    ]) {
      const q = execution(y, n, 100000000n, "YES", 1000);
      expect(q.costMicros > 0n && q.costMicros <= 1000000000n).toBe(true);
    }
    let y = 0n,
      n = 0n,
      reserve = 100000000n;
    for (let i = 0; i < 100; i++) {
      const q = execution(y, n, 100000000n, i % 3 ? "YES" : "NO", 1000);
      y = q.yesShares;
      n = q.noShares;
      reserve += q.costMicros;
      expect(reserve >= (y > n ? y : n) * 1000000n).toBe(true);
    }
  });
  it("canonicalizes key order and detects changes", () => {
    expect(hash({ a: 1, b: 2 })).toBe(hash({ b: 2, a: 1 }));
    expect(hash({ a: 1 })).not.toBe(hash({ a: 2 }));
  });
});
