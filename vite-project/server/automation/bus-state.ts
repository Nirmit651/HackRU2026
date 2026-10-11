import { z } from "zod";
import type { Settings } from "./core";
export const telemetrySchema = z.object({
  provider: z.string(),
  vehicleId: z.string(),
  sourceAt: z.string().datetime({ offset: true }),
  receivedAt: z.string().datetime({ offset: true }),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  routeId: z.string().nullable().optional(),
  tripId: z.string().optional(),
  sequenceId: z.string().optional(),
  speed: z.number().nonnegative().optional(),
  accuracy: z.number().nonnegative().optional(),
});
export type Telemetry = z.infer<typeof telemetrySchema>;
export type Visit = {
  state:
    | "OUTSIDE"
    | "ARRIVAL_CANDIDATE"
    | "DWELLING"
    | "DEPARTURE_CANDIDATE"
    | "QUALIFIED"
    | "ENDED"
    | "UNCERTAIN";
  visitId?: string;
  stop?: Settings["stops"][number];
  t0?: string;
  anchor?: Telemetry;
  last?: Telemetry;
  arrivalSamples: number;
  departureSamples: number;
  departureAt?: string;
  reason?: string;
  trace: Telemetry[];
  settings?: Settings;
  qualifiedAt?: string;
  confirmedAt?: string;
  version: number;
};
export const emptyVisit = (): Visit => ({
  state: "UNCERTAIN",
  reason: "STARTUP_REQUIRES_OBSERVED_OUTSIDE",
  arrivalSamples: 0,
  departureSamples: 0,
  trace: [],
  version: 0,
});
export function meters(
  a: { latitude: number; longitude: number },
  b: { latitude: number; longitude: number },
) {
  const rad = Math.PI / 180,
    dlat = (b.latitude - a.latitude) * rad,
    dlon = (b.longitude - a.longitude) * rad;
  const x =
    Math.sin(dlat / 2) ** 2 +
    Math.cos(a.latitude * rad) *
      Math.cos(b.latitude * rad) *
      Math.sin(dlon / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}
export function advanceVisit(
  previous: Visit,
  raw: Telemetry,
  settings: Settings,
  now: Date,
): Visit {
  const o = telemetrySchema.parse(raw),
    v = structuredClone(previous),
    s = v.settings ?? settings,
    t = +new Date(o.sourceAt),
    received = +new Date(o.receivedAt);
  if (v.last && t <= +new Date(v.last.sourceAt)) {
    const known = [v.last, ...v.trace].find((x) => x.sourceAt === o.sourceAt);
    if (
      known &&
      known.latitude === o.latitude &&
      known.longitude === o.longitude
    )
      return v;
    if (v.t0 && t >= +new Date(v.t0) && v.visitId) {
      v.state = "UNCERTAIN";
      v.reason = "LATE_OR_CONFLICTING_OBSERVATION";
      v.version++;
    }
    return v;
  }
  const gap = v.last ? (t - +new Date(v.last.sourceAt)) / 1000 : 0;
  const invalid =
    t > +now + 5000 ||
    received < t - 5000 ||
    received - t > s.latenessSeconds * 1000 ||
    +now - t > (s.maxGapSeconds + s.latenessSeconds) * 1000 ||
    // Continuous coverage is only evidence-critical once a potential arrival
    // has begun.  The approaching phase may intentionally use a 60-second
    // cadence, so treating that as a dwell-data gap would make every distant
    // bus uncertain before it can arrive.
    (v.state !== "OUTSIDE" && gap > s.maxGapSeconds) ||
    (o.accuracy !== undefined && o.accuracy > s.enterMeters) ||
    (v.last && gap > 0 && meters(v.last, o) / gap > 45) ||
    (v.last &&
      ((v.last.routeId ?? null) !== (o.routeId ?? null) ||
        (v.last.tripId ?? null) !== (o.tripId ?? null)));
  if (invalid) {
    v.state = "UNCERTAIN";
    v.reason = "STALE_GAP_IDENTITY_OR_IMPLAUSIBLE_POSITION";
    v.last = o;
    v.version++;
    return v;
  }
  if (["QUALIFIED", "ENDED"].includes(v.state)) return v;
  const stop = s.stops.find((stop) => meters(stop, o) <= s.enterMeters);
  if (v.state === "UNCERTAIN") {
    if (v.visitId) return v; // Existing question cannot be restarted after lost coverage.
    if (!stop) {
      v.state = "OUTSIDE";
      v.reason = undefined;
    }
  } else if (v.state === "OUTSIDE") {
    if (stop && (o.speed ?? 0) <= 1) {
      v.state = "ARRIVAL_CANDIDATE";
      v.stop = stop;
      v.t0 = o.sourceAt;
      v.anchor = o;
      v.arrivalSamples = 1;
      v.trace = [o];
      v.settings = s;
    }
  } else {
    const stationary =
      meters(v.stop!, o) <= s.exitMeters &&
      meters(v.anchor!, o) <= s.anchorMeters &&
      (o.speed ?? 0) <= 1;
    v.trace.push(o); // Bounded by terminal 10-minute visit / uncertainty deadline.
    if (v.trace.length > 1000) {
      v.state = "UNCERTAIN";
      v.reason = "TRACE_LIMIT";
    } else if (v.state === "ARRIVAL_CANDIDATE") {
      if (stationary) {
        v.arrivalSamples++;
        if (v.arrivalSamples >= 2) {
          v.state = "DWELLING";
          v.visitId = `${o.provider}:${o.vehicleId}:${v.t0}`;
          v.confirmedAt = o.sourceAt;
        }
      } else {
        v.state = "OUTSIDE";
        v.t0 = undefined;
        v.anchor = undefined;
        v.trace = [];
        v.settings = undefined;
      }
    } else if (!stationary) {
      v.departureSamples++;
      v.departureAt ??= o.sourceAt;
      v.state = "DEPARTURE_CANDIDATE";
      // A fresh, exact-trip fix beyond the outer hysteresis boundary proves
      // departure. Two samples remain required for mere movement within it.
      if (meters(v.stop!, o) > s.exitMeters || v.departureSamples >= 2) {
        v.state = "ENDED";
        v.reason = meters(v.stop!, o) > s.exitMeters ? "CONFIRMED_GEOFENCE_EXIT" : "CONFIRMED_MOVEMENT";
      }
    } else if (v.state === "DEPARTURE_CANDIDATE") {
      // A single excursion cannot prove continuous stationary duration either.
      v.state = "UNCERTAIN";
      v.reason = "AMBIGUOUS_MOVEMENT";
    } else if (t - +new Date(v.t0!) >= s.durationSeconds * 1000) {
      v.state = "QUALIFIED";
      v.qualifiedAt = o.sourceAt;
    }
  }
  v.last = o;
  v.version++;
  return v;
}
