import { randomUUID } from "node:crypto";
import { db, transaction } from "../db";
import { reconcile } from "../engine";
import { setDemoTime } from "../demo";
import { configure } from "./index";
import { generateWeather, monitorWeather } from "./weather";
import { generateSports, monitorSports } from "./sports";
import { consumeTelemetry, monitorBus } from "./bus";
import { dayInterval, add, iso } from "./core";
import type { Game } from "./providers";
export async function demoEnvironment() {
  const start = new Date("2026-10-10T16:00:00Z");
  return transaction(async (tx) => {
    const env = await tx.environment.create({
      data: {
        key: `automation-demo-${randomUUID()}`,
        kind: "DEMO",
        initialSupplyMicros: 1000000000000n,
        virtualNow: start,
        simulatedStartAt: start,
        scenarioVersion: "automation-v1",
      },
    });
    await tx.wallet.create({
      data: {
        environmentId: env.id,
        kind: "TREASURY",
        balanceMicros: env.initialSupplyMicros,
        openingBalanceMicros: env.initialSupplyMicros,
      },
    });
    return env;
  });
}
export async function demoTime(environmentId: string, at: Date) {
  const env = await db.environment.findUniqueOrThrow({
    where: { id: environmentId },
  });
  if (env.kind !== "DEMO") throw new Error("DEMO_ONLY");
  await setDemoTime(environmentId, at);
}
export const demoGame = (start: string): Game => ({
  id: "fixture-game-1",
  season: 2026,
  start,
  tbd: false,
  homeId: 1,
  awayId: 2,
  home: "Rutgers",
  away: "Synthetic Opponent",
  homePoints: null,
  awayPoints: null,
  status: "scheduled",
  raw: { fixture: "documented-CFBD-shape", isSimulated: true },
});
export async function runAutomationDemo() {
  const env = await demoEnvironment(),
    start = env.virtualNow!;
  const weather = await configure(env.id, "temperature", true, {});
  await generateWeather(weather, {
    mean: 64,
    raw: { synthetic: true, mean: 64 },
  });
  await generateWeather(weather, {
    mean: 100,
    raw: { synthetic: true, mean: 100 },
  });
  const sports = await configure(env.id, "football", true, {}),
    game = demoGame(iso(add(start, 3600)));
  await generateSports(sports, [game]);
  await generateSports(sports, [game]);
  const bus = await configure(env.id, "bus", true, {
    stops: [
      {
        id: "fixture",
        name: "Synthetic stop",
        latitude: 40.5,
        longitude: -74.4,
        sourceUrl: "https://example.invalid/stop",
      },
    ],
  });
  const feed = async (vehicleId: string, t: number, offset = 0) => {
    const at = add(start, t);
    await demoTime(env.id, at);
    await consumeTelemetry(
      bus,
      {
        provider: "fixture",
        vehicleId,
        sourceAt: iso(at),
        receivedAt: iso(at),
        latitude: 40.5 + offset,
        longitude: -74.4,
        routeId: "LX",
      },
      true,
    );
  };
  for (const vehicle of ["yes", "no", "return", "stale"])
    await feed(vehicle, 0, 0.001);
  for (let t = 10; t <= 630; t += 10) {
    await feed("yes", t);
    if (t <= 120) await feed("no", t, t >= 110 ? 0.0008 : 0);
    if (t <= 20) await feed("stale", t);
    await feed("return", t, t >= 110 && t <= 140 ? 0.0008 : 0);
  }
  await demoTime(env.id, add(start, 900));
  for (const m of await db.market.findMany({
    where: {
      environmentId: env.id,
      category: "BUS_ARRIVAL",
      status: { notIn: ["RESOLVED", "VOIDED"] },
    },
  }))
    await monitorBus(m);
  const sportsMarket = await db.market.findFirstOrThrow({
    where: { environmentId: env.id, category: "VARSITY_SPORTS" },
  });
  const final = {
    ...game,
    status: "final",
    homePoints: 70,
    awayPoints: 60,
    raw: { synthetic: true, completed: true, homePoints: 70, awayPoints: 60 },
  };
  await demoTime(env.id, add(start, 7200));
  await monitorSports(sportsMarket, final);
  await demoTime(env.id, add(start, 7261));
  await monitorSports(sportsMarket, final);
  const interval = dayInterval("2026-10-11");
  for (let t = +interval.start; t < +interval.end; t += 3600000)
    await db.weatherObservation.create({
      data: {
        environmentId: env.id,
        station: "KSMQ",
        sourceId: `demo:${t}`,
        observedAt: new Date(t),
        fetchedAt: new Date(t),
        temperatureF: 66,
        quality: "V",
      },
    });
  await demoTime(env.id, add(interval.end, 7200));
  await monitorWeather(
    await db.market.findFirstOrThrow({
      where: { environmentId: env.id, category: "TEMPERATURE" },
    }),
  );
  return {
    environmentId: env.id,
    markets: await db.market.findMany({
      where: { environmentId: env.id },
      select: {
        title: true,
        status: true,
        settlement: { select: { outcome: true } },
      },
    }),
    reconciliation: await reconcile(env.id),
  };
}
