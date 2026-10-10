import type { PublicEvent } from "./contracts";
export class EventBuffer {
  version = 0n;
  pending = new Map<bigint, PublicEvent>();
  snapshot(version: string) {
    this.version = BigInt(version);
    for (const v of this.pending.keys())
      if (v <= this.version) this.pending.delete(v);
  }
  push(e: PublicEvent) {
    const v = BigInt(e.version);
    if (v > this.version) this.pending.set(v, e);
  }
  drain() {
    const out: PublicEvent[] = [];
    while (this.pending.has(this.version + 1n)) {
      this.version++;
      out.push(this.pending.get(this.version)!);
      this.pending.delete(this.version);
    }
    return out;
  }
  get gap() {
    return this.pending.size > 0 && !this.pending.has(this.version + 1n);
  }
}
export function collapseEvents(events: PublicEvent[]) {
  const buckets = new Map<
    number,
    { time: number; value: number; volume: bigint; settled?: string }
  >();
  for (const e of [...events].sort((a, b) =>
    BigInt(a.version) < BigInt(b.version) ? -1 : 1,
  )) {
    const time = Math.floor(Date.parse(e.occurredAt) / 1000),
      previous = buckets.get(time);
    buckets.set(time, {
      time,
      value: Number(e.yesPrice) * 100,
      volume: (previous?.volume ?? 0n) + BigInt(e.tradeAmountMicros),
      settled:
        e.kind === "SETTLED" ? String(e.payload.outcome) : previous?.settled,
    });
  }
  return [...buckets.values()].sort((a, b) => a.time - b.time);
}
