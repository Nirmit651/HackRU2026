/* eslint-disable @typescript-eslint/no-explicit-any -- protobuf bindings intentionally expose generated dynamic objects. */
/** Server-only Rutgers TripShot adapter.  Feed URLs are deliberately constants, never request input. */
import AdmZip from "adm-zip";
import { createHash } from "node:crypto";
import GtfsRealtimeBindings from "gtfs-realtime-bindings";
import { db } from "./db";

const REGION = "CA558DDC-D7F2-4B48-9CAC-DEEA1134F820";
const STATIC_URL = `https://rutgers.tripshot.com/v1/gtfs.zip?regionId=${REGION}`;
const TRIPS_URL = `https://rutgers.tripshot.com/v1/gtfs/realtime/tripUpdate/${REGION}`;
const VEHICLES_URL = `https://rutgers.tripshot.com/v1/gtfs/realtime/vehiclePosition/${REGION}`;
const STATIC_TTL_MS = 24 * 60 * 60_000, REALTIME_TTL_MS = 5_000, STALE_MS = 45_000;
// The static archive is fetched once per day and is materially larger than the
// realtime protobufs. Give only that one-time cache fill a longer budget.
const STATIC_FETCH_TIMEOUT_MS = 30_000, REALTIME_FETCH_TIMEOUT_MS = 8_000;

export type Stop = { id: string; name: string; latitude: number; longitude: number };
type Route = { id: string; shortName: string; longName: string; color?: string };
type Trip = { id: string; routeId: string; shapeId?: string };
export type LiveVehicle = { id: string; routeId: string; tripId?: string; latitude: number; longitude: number; heading?: number; updatedAt: string };
export type Arrival = { tripId: string; routeId: string; vehicleId?: string; arrivalAt: string; feedTimestamp: string; stopId: string };
type StaticGtfs = { stops: Stop[]; routes: Map<string, Route>; trips: Map<string, Trip>; stopTimes: Map<string, { stopId: string; sequence: number }[]>; shapes: Map<string, [number, number][]>; collegeStops: Stop[] };
export type LiveTransit = { vehicles: LiveVehicle[]; routes: Route[]; targetStops: Stop[]; arrivals: Arrival[]; nextArrival: Arrival | null; routeGeometry: [number, number][]; observedAt: string; tripFeedAt: string; vehicleFeedAt: string; stale: boolean };
export type FrozenTripSnapshot = Pick<LiveTransit, "observedAt" | "tripFeedAt" | "vehicleFeedAt" | "stale"> & { vehicle: LiveVehicle | null; routeGeometry: [number, number][] };

let staticCache: { value: StaticGtfs; at: number } | undefined;
let refreshStatic: Promise<StaticGtfs> | undefined;
let refreshDatabaseStatic: Promise<StaticGtfs> | undefined;
let realtimeCache: { value: LiveTransit; at: number } | undefined;
let refreshRealtime: Promise<LiveTransit> | undefined;

const norm = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const csv = (text: string) => {
  const rows: string[][] = []; let row: string[] = [], cell = "", quote = false;
  for (let i = 0; i < text.length; i++) { const c = text[i];
    if (c === '"') { if (quote && text[i + 1] === '"') { cell += c; i++; } else quote = !quote; }
    else if (c === "," && !quote) { row.push(cell); cell = ""; }
    else if ((c === "\n" || c === "\r") && !quote) { if (c === "\r" && text[i + 1] === "\n") i++; row.push(cell); if (row.some(Boolean)) rows.push(row); row = []; cell = ""; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const [head = [], ...body] = rows; return body.map((r) => Object.fromEntries(head.map((key, i) => [key, r[i] ?? ""])));
};
export function findCollegeAveStops(stops: Stop[]) {
  return stops.filter((stop) => { const name = norm(stop.name); return name.includes("college avenue student center") || name.includes("college ave student center"); });
}
export function parseGtfsZip(raw: Buffer): StaticGtfs {
  const zip = new AdmZip(raw); const read = (name: string) => zip.getEntry(name)?.getData().toString("utf8") ?? "";
  const stops = csv(read("stops.txt")).map((r) => ({ id: r.stop_id, name: r.stop_name, latitude: Number(r.stop_lat), longitude: Number(r.stop_lon) })).filter((s) => s.id && s.name && Number.isFinite(s.latitude) && Number.isFinite(s.longitude));
  const routes = new Map(csv(read("routes.txt")).map((r) => [r.route_id, { id: r.route_id, shortName: r.route_short_name || r.route_id, longName: r.route_long_name || r.route_short_name || r.route_id, color: r.route_color ? `#${r.route_color.replace(/^#/, "")}` : undefined }]));
  const trips = new Map(csv(read("trips.txt")).map((r) => [r.trip_id, { id: r.trip_id, routeId: r.route_id, shapeId: r.shape_id || undefined }]));
  const stopTimes = new Map<string, { stopId: string; sequence: number }[]>();
  for (const r of csv(read("stop_times.txt"))) { const list = stopTimes.get(r.trip_id) ?? []; list.push({ stopId: r.stop_id, sequence: Number(r.stop_sequence) || 0 }); stopTimes.set(r.trip_id, list); }
  const shapeRows = new Map<string, { point: [number, number]; sequence: number }[]>();
  for (const r of csv(read("shapes.txt"))) {
    const list = shapeRows.get(r.shape_id) ?? [];
    const point: [number, number] = [Number(r.shape_pt_lon), Number(r.shape_pt_lat)];
    if (r.shape_id && Number.isFinite(point[0]) && Number.isFinite(point[1])) list.push({ point, sequence: Number(r.shape_pt_sequence) || 0 });
    shapeRows.set(r.shape_id, list);
  }
  const shapes = new Map([...shapeRows].map(([id, points]) => [id, points.sort((a, b) => a.sequence - b.sequence).map(({ point }) => point)]));
  return { stops, routes, trips, stopTimes, shapes, collegeStops: findCollegeAveStops(stops) };
}
async function fetchBytes(url: string, timeoutMs = REALTIME_FETCH_TIMEOUT_MS) { const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { Accept: "application/octet-stream" } }); if (!response.ok) throw new Error(`TRIPSHOT_HTTP_${response.status}`); const body = Buffer.from(await response.arrayBuffer()); if (!body.length || body.length > 25_000_000) throw new Error("TRIPSHOT_INVALID_SIZE"); return body; }
type CachedFeed = { feed_hash: string; fetched_at: Date };
type CachedRoute = { route_id: string; short_name: string; long_name: string; color: string | null };
type CachedStop = { stop_id: string; stop_name: string; latitude: number; longitude: number };
type CachedTrip = { trip_id: string; route_id: string; shape_id: string | null };
type CachedShape = { shape_id: string; points: unknown };
const routeShapeCache = new Map<string, [number, number][]>();

function parseShapePoints(points: unknown): [number, number][] {
  if (!Array.isArray(points)) return [];
  return points.flatMap((point): [number, number][] => Array.isArray(point) && Number.isFinite(Number(point[0])) && Number.isFinite(Number(point[1])) ? [[Number(point[0]), Number(point[1])]] : []);
}

async function routeShape(shapeId: string | undefined, staticData: StaticGtfs) {
  if (!shapeId) return [];
  const inMemory = staticData.shapes.get(shapeId) ?? routeShapeCache.get(shapeId);
  if (inMemory) return inMemory;
  const [shape] = await db.$queryRaw<CachedShape[]>`SELECT shape_id, points FROM public.tripshot_gtfs_shapes WHERE feed_hash=(SELECT feed_hash FROM public.tripshot_static_feeds WHERE is_active LIMIT 1) AND shape_id=${shapeId}`;
  const points = parseShapePoints(shape?.points);
  if (points.length) routeShapeCache.set(shapeId, points);
  return points;
}

/** The static GTFS cache is server-only. A cold API process reads this before it ever considers downloading the ZIP. */
async function cachedStaticGtfs(): Promise<{ value: StaticGtfs; fetchedAt: number } | undefined> {
  try {
    const [feed] = await db.$queryRaw<CachedFeed[]>`SELECT feed_hash, fetched_at FROM public.tripshot_static_feeds WHERE is_active ORDER BY fetched_at DESC LIMIT 1`;
    if (!feed) return undefined;
    const [routes, stops, trips] = await Promise.all([
      db.$queryRaw<CachedRoute[]>`SELECT route_id, short_name, long_name, color FROM public.tripshot_gtfs_routes WHERE feed_hash=${feed.feed_hash}`,
      db.$queryRaw<CachedStop[]>`SELECT stop_id, stop_name, latitude, longitude FROM public.tripshot_gtfs_stops WHERE feed_hash=${feed.feed_hash}`,
      db.$queryRaw<CachedTrip[]>`SELECT trip_id, route_id, shape_id FROM public.tripshot_gtfs_trips WHERE feed_hash=${feed.feed_hash}`,
    ]);
    if (!routes.length || !stops.length || !trips.length) return undefined;
    const parsedStops = stops.map((stop) => ({ id: stop.stop_id, name: stop.stop_name, latitude: Number(stop.latitude), longitude: Number(stop.longitude) }));
    const value: StaticGtfs = {
      stops: parsedStops,
      routes: new Map(routes.map((route) => [route.route_id, { id: route.route_id, shortName: route.short_name, longName: route.long_name, color: route.color ?? undefined }])),
      trips: new Map(trips.map((trip) => [trip.trip_id, { id: trip.trip_id, routeId: trip.route_id, shapeId: trip.shape_id ?? undefined }])),
      shapes: new Map(),
      stopTimes: new Map(),
      collegeStops: findCollegeAveStops(parsedStops),
    };
    return value.collegeStops.length ? { value, fetchedAt: +new Date(feed.fetched_at) } : undefined;
  } catch (error) {
    console.warn("TripShot static cache read failed", error instanceof Error ? error.message : error);
    return undefined;
  }
}

async function persistStaticGtfs(value: StaticGtfs, raw: Buffer) {
  const feedHash = createHash("sha256").update(raw).digest("hex");
  const routes = [...value.routes.values()].map((route) => ({ route_id: route.id, short_name: route.shortName, long_name: route.longName, color: route.color ?? null }));
  const stops = value.stops.map((stop) => ({ stop_id: stop.id, stop_name: stop.name, latitude: stop.latitude, longitude: stop.longitude }));
  const shapes = [...value.shapes].map(([shapeId, points]) => ({ shape_id: shapeId, points, point_count: points.length }));
  const trips = [...value.trips.values()].filter((trip) => value.routes.has(trip.routeId)).map((trip) => ({ trip_id: trip.id, route_id: trip.routeId, shape_id: trip.shapeId && value.shapes.has(trip.shapeId) ? trip.shapeId : null }));
  // Supabase's transaction-mode pooler does not support long interactive
  // transactions well. Stage an inactive version with idempotent inserts,
  // then make it visible only after every dependent row is present.
  await db.$executeRaw`INSERT INTO public.tripshot_static_feeds (feed_hash, source_url, is_active, route_count, stop_count, trip_count, shape_count)
      VALUES (${feedHash}, ${STATIC_URL}, false, ${routes.length}, ${stops.length}, ${trips.length}, ${shapes.length})
      ON CONFLICT (feed_hash) DO UPDATE SET fetched_at=now(), source_url=EXCLUDED.source_url`;
  await db.$executeRaw`INSERT INTO public.tripshot_gtfs_routes (feed_hash, route_id, short_name, long_name, color)
      SELECT ${feedHash}, item.route_id, item.short_name, item.long_name, item.color
      FROM jsonb_to_recordset(${JSON.stringify(routes)}::jsonb) AS item(route_id text, short_name text, long_name text, color text)
      ON CONFLICT (feed_hash, route_id) DO NOTHING`;
  await db.$executeRaw`INSERT INTO public.tripshot_gtfs_stops (feed_hash, stop_id, stop_name, latitude, longitude)
      SELECT ${feedHash}, item.stop_id, item.stop_name, item.latitude, item.longitude
      FROM jsonb_to_recordset(${JSON.stringify(stops)}::jsonb) AS item(stop_id text, stop_name text, latitude double precision, longitude double precision)
      ON CONFLICT (feed_hash, stop_id) DO NOTHING`;
  await db.$executeRaw`INSERT INTO public.tripshot_gtfs_shapes (feed_hash, shape_id, points, point_count)
      SELECT ${feedHash}, item.shape_id, item.points, item.point_count
      FROM jsonb_to_recordset(${JSON.stringify(shapes)}::jsonb) AS item(shape_id text, points jsonb, point_count integer)
      ON CONFLICT (feed_hash, shape_id) DO NOTHING`;
  await db.$executeRaw`INSERT INTO public.tripshot_gtfs_trips (feed_hash, trip_id, route_id, shape_id)
      SELECT ${feedHash}, item.trip_id, item.route_id, item.shape_id
      FROM jsonb_to_recordset(${JSON.stringify(trips)}::jsonb) AS item(trip_id text, route_id text, shape_id text)
      ON CONFLICT (feed_hash, trip_id) DO NOTHING`;
  await db.$executeRaw`UPDATE public.tripshot_static_feeds SET is_active=false WHERE is_active AND feed_hash<>${feedHash}`;
  await db.$executeRaw`UPDATE public.tripshot_static_feeds SET is_active=true, fetched_at=now() WHERE feed_hash=${feedHash}`;
}

async function refreshStaticFromTripShot() {
  if (!refreshDatabaseStatic) refreshDatabaseStatic = fetchBytes(STATIC_URL, STATIC_FETCH_TIMEOUT_MS).then(async (raw) => {
    return cacheTripshotStaticGtfs(raw);
  }).finally(() => { refreshDatabaseStatic = undefined; });
  return refreshDatabaseStatic;
}
async function staticGtfs() {
  if (staticCache && Date.now() - staticCache.at < STATIC_TTL_MS) return staticCache.value;
  if (!refreshStatic) refreshStatic = (async () => {
    const cached = await cachedStaticGtfs();
    if (cached) {
      staticCache = { value: cached.value, at: cached.fetchedAt };
      if (Date.now() - cached.fetchedAt >= STATIC_TTL_MS) void refreshStaticFromTripShot().catch((error) => console.warn("TripShot static cache refresh failed", error instanceof Error ? error.message : error));
      return cached.value;
    }
    return refreshStaticFromTripShot();
  })().catch((error) => { if (staticCache) return staticCache.value; throw error; }).finally(() => { refreshStatic = undefined; });
  return refreshStatic;
}
const seconds = (v: unknown) => typeof v === "number" ? v : Number(v ?? 0);
export function selectArrivalCandidates(entities: any[], targetIds: Set<string>, trips: Map<string, Trip>, now = Date.now(), feedAt = new Date().toISOString()): Arrival[] {
  const candidates: Arrival[] = [];
  for (const entity of entities) { const update = entity.tripUpdate; if (!update || update.trip?.scheduleRelationship === 3 || update.trip?.scheduleRelationship === 2) continue; const tripId = update.trip?.tripId; const trip = trips.get(tripId); if (!trip) continue;
    for (const stop of update.stopTimeUpdate ?? []) { if (!targetIds.has(stop.stopId) || stop.scheduleRelationship === 1) continue; const at = seconds(stop.arrival?.time ?? stop.departure?.time) * 1000; if (at > now && at - now < 4 * 60 * 60_000) candidates.push({ tripId, routeId: update.trip.routeId || trip.routeId, vehicleId: update.vehicle?.id || undefined, arrivalAt: new Date(at).toISOString(), feedTimestamp: feedAt, stopId: stop.stopId }); }
  }
  return candidates.sort((a, b) => +new Date(a.arrivalAt) - +new Date(b.arrivalAt));
}
export function selectNextArrival(entities: any[], targetIds: Set<string>, trips: Map<string, Trip>, now = Date.now(), feedAt = new Date().toISOString()): Arrival | null {
  return selectArrivalCandidates(entities, targetIds, trips, now, feedAt)[0] ?? null;
}
const meters = (a: Stop, b: LiveVehicle) => {
  const rad = Math.PI / 180, dlat = (b.latitude - a.latitude) * rad, dlon = (b.longitude - a.longitude) * rad;
  const x = Math.sin(dlat / 2) ** 2 + Math.cos(a.latitude * rad) * Math.cos(b.latitude * rad) * Math.sin(dlon / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
};
export function selectNextEligibleArrival(live: LiveTransit, enterMeters = 65) {
  for (const arrival of live.arrivals) {
    const stop = live.targetStops.find((candidate) => candidate.id === arrival.stopId);
    const vehicle = live.vehicles.find((candidate) => (arrival.vehicleId ? candidate.id === arrival.vehicleId : candidate.tripId === arrival.tripId));
    if (stop && vehicle && meters(stop, vehicle) > enterMeters) return { arrival, stop, vehicle };
  }
  return null;
}
async function live(): Promise<LiveTransit> {
  if (realtimeCache && Date.now() - realtimeCache.at < REALTIME_TTL_MS) return realtimeCache.value;
  if (!refreshRealtime) refreshRealtime = (async () => {
    // On a cold process the static ZIP can take several seconds. Start all
    // independent upstream requests together instead of serializing them.
    const [gtfs, tripsRaw, vehiclesRaw] = await Promise.all([staticGtfs(), fetchBytes(TRIPS_URL), fetchBytes(VEHICLES_URL)]);
    const tripFeed = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(tripsRaw), vehicleFeed = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(vehiclesRaw);
    const tripFeedAt = new Date(seconds((tripFeed.header as any)?.timestamp) * 1000 || Date.now()).toISOString(), vehicleFeedAt = new Date(seconds((vehicleFeed.header as any)?.timestamp) * 1000 || Date.now()).toISOString();
    const arrivals = selectArrivalCandidates((tripFeed as any).entity ?? [], new Set(gtfs.collegeStops.map((s) => s.id)), gtfs.trips, Date.now(), tripFeedAt);
    const arrival = arrivals[0] ?? null;
    const vehicles: LiveVehicle[] = ((vehicleFeed as any).entity ?? []).flatMap((e: any) => { const v = e.vehicle, p = v?.position, trip = gtfs.trips.get(v?.trip?.tripId); if (!v?.vehicle?.id || !Number.isFinite(p?.latitude) || !Number.isFinite(p?.longitude)) return []; return [{ id: v.vehicle.id, routeId: v.trip?.routeId || trip?.routeId || "Unknown", tripId: v.trip?.tripId || undefined, latitude: p.latitude, longitude: p.longitude, heading: p.bearing || undefined, updatedAt: new Date(seconds(v.timestamp) * 1000 || Date.now()).toISOString() }]; });
    const tracked = arrival && vehicles.find((v) => (arrival.vehicleId && v.id === arrival.vehicleId) || v.tripId === arrival.tripId);
    if (arrival && tracked && !arrival.vehicleId) arrival.vehicleId = tracked.id;
    const selectedTrip = arrival ? gtfs.trips.get(arrival.tripId) : undefined, routeGeometry = await routeShape(selectedTrip?.shapeId, gtfs);
    const observedAt = vehicleFeedAt, value = { vehicles, routes: [...gtfs.routes.values()], targetStops: gtfs.collegeStops, arrivals, nextArrival: arrival, routeGeometry, observedAt, tripFeedAt, vehicleFeedAt, stale: Date.now() - Math.min(+new Date(tripFeedAt), +new Date(vehicleFeedAt)) > STALE_MS };
    realtimeCache = { value, at: Date.now() }; return value;
  })().finally(() => { refreshRealtime = undefined; });
  return refreshRealtime;
}
export const tripshotLive = live;

/** Operational warm-up hook: refreshes the server-only static cache without fetching live vehicle data. */
export async function refreshTripshotStaticCache() {
  const value = await refreshStaticFromTripShot();
  return { routes: value.routes.size, stops: value.stops.length, trips: value.trips.size, shapes: value.shapes.size };
}

/** Imports an official TripShot static archive through the same parser and DB writer used by refreshes. */
export async function cacheTripshotStaticGtfs(raw: Buffer) {
  const value = parseGtfsZip(raw);
  if (!value.collegeStops.length) throw new Error("COLLEGE_AVE_STOP_NOT_FOUND");
  await persistStaticGtfs(value, raw);
  routeShapeCache.clear();
  staticCache = { value, at: Date.now() };
  return value;
}

/** Reads the shared live cache but renders only the vehicle/trip frozen into a market. */
export async function tripshotFrozenTrip(tripId: string, vehicleId: string): Promise<FrozenTripSnapshot> {
  const [value, gtfs] = await Promise.all([live(), staticGtfs()]);
  const vehicle = value.vehicles.find((candidate) => vehicleId.startsWith("trip:") ? candidate.tripId === tripId : candidate.id === vehicleId) ?? null;
  const trip = gtfs.trips.get(tripId);
  return {
    vehicle,
    routeGeometry: await routeShape(trip?.shapeId, gtfs),
    observedAt: value.observedAt,
    tripFeedAt: value.tripFeedAt,
    vehicleFeedAt: value.vehicleFeedAt,
    stale: value.stale,
  };
}
