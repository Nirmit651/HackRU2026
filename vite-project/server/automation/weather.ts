import { DateTime } from "luxon";
import { z } from "zod";
import type { Market, AutomationConfig } from "../../generated/prisma/client";
import { db, ensure } from "../db";
import { ruleSchema } from "../../shared/contracts";
import {
  dayInterval,
  zone,
  settingsSchema,
  nowFor,
  add,
  iso,
  rule,
  slug,
  createAutomatedMarket,
  finish,
} from "./core";
import { observations, providerJson } from "./providers";

export function observedAverage(
  start: Date,
  end: Date,
  rows: { observedAt: Date; temperatureF: number; sourceId: string }[],
) {
  const buckets = Array.from({ length: (+end - +start) / 3600000 }, (_, i) => ({
    start: iso(+start + i * 3600000),
    values: [] as number[],
  }));
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.sourceId) || !Number.isFinite(row.temperatureF)) continue;
    seen.add(row.sourceId);
    const i = Math.floor((+row.observedAt - +start) / 3600000);
    if (i >= 0 && i < buckets.length) buckets[i].values.push(row.temperatureF);
  }
  const hourly = buckets.map((b) => ({
    start: b.start,
    count: b.values.length,
    mean: b.values.length
      ? b.values.reduce((a, v) => a + v, 0) / b.values.length
      : null,
  }));
  return {
    hourly,
    complete: hourly.every((h) => h.count > 0),
    mean: hourly.every((h) => h.count > 0)
      ? hourly.reduce((a, h) => a + h.mean!, 0) / hourly.length
      : null,
  };
}
export const roundThreshold = (mean: number) => Math.floor(mean / 5 + 0.5) * 5;
export async function generateWeather(
  config: AutomationConfig,
  suppliedForecast?: { mean: number; raw: unknown },
) {
  const at = await nowFor(config.environmentId),
    local = DateTime.fromJSDate(at, { zone }),
    s = settingsSchema.parse(config.settings);
  if (local.hour < 12)
    return { created: 0, skipped: 1, reason: "BEFORE_LOCAL_NOON" };
  const date = local.plus({ days: 1 }).toISODate()!,
    { start, end } = dayInterval(date),
    key = `temperature:${s.station}:${date}`;
  if (
    await db.market.findUnique({
      where: {
        environmentId_generatorKey: {
          environmentId: config.environmentId,
          generatorKey: key,
        },
      },
    })
  )
    return { created: 0, skipped: 1, reason: "ALREADY_EXISTS" };
  const env = await db.environment.findUniqueOrThrow({
    where: { id: config.environmentId },
  });
  let forecast = suppliedForecast;
  if (forecast) ensure(env.kind === "DEMO", "SIMULATED_LIVE_FORECAST");
  else {
    // Verify recent station coverage before risking a funded market.
    await observations(env.id, s.station, add(at, -86400), at);
    const recent = await db.weatherObservation.count({
      where: {
        environmentId: env.id,
        station: s.station,
        observedAt: { gte: add(at, -7200) },
      },
    });
    ensure(recent > 0, "STATION_COVERAGE_UNAVAILABLE");
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${s.latitude}&longitude=${s.longitude}&hourly=temperature_2m&temperature_unit=fahrenheit&timeformat=unixtime&timezone=UTC&forecast_days=4`;
    const raw = z
      .object({
        hourly_units: z.object({
          time: z.literal("unixtime"),
          temperature_2m: z.literal("°F"),
        }),
        hourly: z.object({
          time: z.array(z.number()),
          temperature_2m: z.array(z.number().nullable()),
        }),
      })
      .passthrough()
      .parse(await providerJson(env.id, url, {}, 1800));
    const rows = raw.hourly.time.flatMap((time, i) =>
      raw.hourly.temperature_2m[i] === null
        ? []
        : [
            {
              sourceId: String(time),
              observedAt: new Date(time * 1000),
              temperatureF: raw.hourly.temperature_2m[i],
            },
          ],
    );
    const calc = observedAverage(start, end, rows);
    ensure(calc.complete && calc.mean !== null, "INCOMPLETE_FORECAST");
    forecast = { mean: calc.mean, raw };
  }
  const threshold = roundThreshold(forecast.mean),
    deadline = add(end, s.maxWaitHours * 3600),
    provider = env.kind === "DEMO" ? "demo-NWS" : "NWS";
  const condition = `Our defined observed daily average at ${s.stationName} (${s.station}) on ${date} exceeds ${threshold}°F. Equality is NO. Mean of each actual local-hour mean; every hour required. NWS verified temperatures only. Missing coverage becomes VOID after ${s.maxWaitHours} hours.`;
  const r = rule(
    "temperature",
    provider,
    `${s.station}:${date}`,
    start,
    start,
    deadline,
    deadline,
    {
      ...s,
      targetDate: date,
      intervalStart: iso(start),
      intervalEnd: iso(end),
      calculationVersion: "hourly-means-v1",
    },
    condition,
  );
  r.units = "degF";
  r.comparison = "GT";
  r.threshold = threshold;
  r.rounding =
    "Forecast threshold: nearest 5°F, halfway toward positive infinity. Observed comparison unrounded.";
  const created = await createAutomatedMarket({
    environmentId: env.id,
    generatorKey: key,
    templateVersion: 1,
    slug: slug(key),
    title: `Will the average temperature at ${s.stationName} exceed ${threshold}°F on ${date}?`,
    description: condition,
    category: "TEMPERATURE",
    opensAt: iso(at),
    closesAt: iso(start),
    expectedResolutionAt: iso(add(end, s.graceHours * 3600)),
    sourceUrl: `https://api.weather.gov/stations/${s.station}/observations`,
    resolutionRule: r,
    context: {
      station: s.station,
      targetDate: date,
      forecastSnapshot: forecast.raw,
      forecastFetchedAt: iso(at),
      forecastMean: forecast.mean,
      thresholdCalculation: "floor(meanF/5 + 0.5)*5",
    },
  });
  return {
    created: created.creationReplayed ? 0 : 1,
    skipped: created.creationReplayed ? 1 : 0,
  };
}
export async function monitorWeather(m: Market) {
  const at = await nowFor(m.environmentId),
    r = ruleSchema.parse(m.resolutionRule),
    s = settingsSchema.parse(r.automation!.settings),
    details = r.automation!.settings;
  const start = new Date(String(details.intervalStart)),
    end = new Date(String(details.intervalEnd));
  if (at < start) return start;
  const env = await db.environment.findUniqueOrThrow({
    where: { id: m.environmentId },
  });
  let fetchFailed = false;
  if (env.kind === "LIVE") {
    try {
      await observations(env.id, s.station, start, at < end ? at : end);
    } catch {
      fetchFailed = true;
    }
  }
  const rows = await db.weatherObservation.findMany({
    where: {
      environmentId: m.environmentId,
      station: s.station,
      observedAt: { gte: start, lt: end },
    },
    orderBy: { observedAt: "asc" },
  });
  const calc = observedAverage(start, end, rows);
  const audit = {
    station: s.station,
    timezone: zone,
    targetInterval: { start: iso(start), end: iso(end) },
    threshold: r.threshold,
    calculationVersion: "hourly-means-v1",
    ...calc,
    observations: rows.map((x) => ({
      sourceId: x.sourceId,
      observedAt: iso(x.observedAt),
      fetchedAt: iso(x.fetchedAt),
      temperatureF: x.temperatureF,
      quality: x.quality,
    })),
    fetchFailed,
  };
  if (at >= add(end, s.graceHours * 3600) && calc.complete) {
    await finish(m, { units: "degF", value: calc.mean! }, audit, end);
    return;
  }
  if (at >= new Date(r.voidAfter)) {
    await finish(m, { units: "degF", missing: true }, audit, at);
    return;
  }
  return add(at, at < end ? 1800 : 900);
}
