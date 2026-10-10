import Decimal from "decimal.js";
import { createHash } from "node:crypto";
Decimal.set({ precision: 60, rounding: Decimal.ROUND_HALF_UP });
export const UNIT = 1_000_000n;
const D = (v: bigint) => new Decimal(v.toString());
function cost(y: bigint, n: bigint, b: Decimal) {
  const a = D(y).div(b),
    c = D(n).div(b),
    m = Decimal.max(a, c);
  return b.mul(m.plus(a.minus(m).exp().plus(c.minus(m).exp()).ln()));
}
export function price(y: bigint, n: bigint, bMicros: bigint) {
  const b = D(bMicros).div(1e6);
  if (b.lte(0)) throw new Error("Invalid liquidity");
  return new Decimal(1).div(
    new Decimal(1).plus(
      D(n - y)
        .div(b)
        .exp(),
    ),
  );
}
export function execution(
  y: bigint,
  n: bigint,
  bMicros: bigint,
  side: "YES" | "NO",
  quantity: number,
) {
  if (
    !Number.isInteger(quantity) ||
    quantity < 1 ||
    quantity > 1000 ||
    y < 0n ||
    n < 0n ||
    y + n > 1_000_000_000n ||
    bMicros < 1_000_000n
  )
    throw new Error("Pricing bounds exceeded");
  const k = BigInt(quantity),
    b = D(bMicros).div(1e6),
    nextY = y + (side === "YES" ? k : 0n),
    nextN = n + (side === "NO" ? k : 0n);
  // Strictly positive costs below decimal precision are still charged one micro-R.
  const delta = cost(nextY, nextN, b).minus(cost(y, n, b));
  const costMicros = BigInt(Decimal.max(1, delta.mul(1e6).ceil()).toFixed(0));
  return {
    costMicros,
    yesPriceBefore: price(y, n, bMicros).toFixed(20),
    yesPriceAfter: price(nextY, nextN, bMicros).toFixed(20),
    yesShares: nextY,
    noShares: nextN,
  };
}
export function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
    .join(",")}}`;
}
export const hash = (value: unknown) =>
  createHash("sha256").update(canonical(value)).digest("hex");
