/* eslint-disable @typescript-eslint/no-explicit-any -- protobuf bindings intentionally expose generated dynamic objects. */
/** Server-only Rutgers TripShot adapter.  Feed URLs are deliberately constants, never request input. */
import AdmZip from "adm-zip";
import GtfsRealtimeBindings from "gtfs-realtime-bindings";

const REGION = "CA558DDC-D7F2-4B48-9CAC-DEEA1134F820";
const STATIC_URL = `https://rutgers.tripshot.com/v1/gtfs.zip?regionId=${REGION}`;
const TRIPS_URL = `https://rutgers.tripshot.com/v1/gtfs/realtime/tripUpdate/${REGION}`;
const VEHICLES_URL = `https://rutgers.tripshot.com/v1/gtfs/realtime/vehiclePosition/${REGION}`;
const STATIC_TTL_MS = 24 * 60 * 60_000, REALTIME_TTL_MS = 15_000, STALE_MS = 45_000;

export type Stop = { id: string; name: string; latitude: number; longitude: number };
type Route = { id: string; shortName: string; longName: string; color?: string };
type Trip = { id: string; routeId: string; shapeId?: string };
export type LiveVehicle = { id: string; routeId: string; tripId?: string; latitude: number; longitude: number; heading?: number; updatedAt: string };
export type Arrival = { tripId: string; routeId: string; vehicleId?: string; arrivalAt: string; feedTimestamp: string; stopId: string };
type StaticGtfs = { stops: Stop[]; routes: Map<string, Route>; trips: Map<string, Trip>; stopTimes: Map<string, { stopId: string; sequence: number }[]>; shapes: Map<string, [number, number][]>; collegeStops: Stop[] };
export type LiveTransit = { vehicles: LiveVehicle[]; routes: Route[]; targetStops: Stop[]; nextArrival: Arrival | null; routeGeometry: [number, number][]; observedAt: string; tripFeedAt: string; vehicleFeedAt: string; stale: boolean };
export type FrozenTripSnapshot = Pick<LiveTransit, "observedAt" | "tripFeedAt" | "vehicleFeedAt" | "stale"> & { vehicle: LiveVehicle | null; routeGeometry: [number, number][] };

let staticCache: { value: StaticGtfs; at: number } | undefined;
let refreshStatic: Promise<StaticGtfs> | undefined;
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
async function fetchBytes(url: string) { const response = await fetch(url, { signal: AbortSignal.timeout(8_000), headers: { Accept: "application/octet-stream" } }); if (!response.ok) throw new Error(`TRIPSHOT_HTTP_${response.status}`); const body = Buffer.from(await response.arrayBuffer()); if (!body.length || body.length > 25_000_000) throw new Error("TRIPSHOT_INVALID_SIZE"); return body; }
async function staticGtfs() {
  if (staticCache && Date.now() - staticCache.at < STATIC_TTL_MS) return staticCache.value;
  if (!refreshStatic) refreshStatic = fetchBytes(STATIC_URL).then(parseGtfsZip).then((value) => { if (!value.collegeStops.length) throw new Error("COLLEGE_AVE_STOP_NOT_FOUND"); console.info("TripShot College Ave stops", value.collegeStops.map((s) => `${s.id}:${s.name}`).join(", ")); staticCache = { value, at: Date.now() }; return value; }).catch((error) => { if (staticCache) return staticCache.value; throw error; }).finally(() => { refreshStatic = undefined; });
  return refreshStatic;
}
const seconds = (v: unknown) => typeof v === "number" ? v : Number(v ?? 0);
export function selectNextArrival(entities: any[], targetIds: Set<string>, trips: Map<string, Trip>, now = Date.now(), feedAt = new Date().toISOString()): Arrival | null {
  const candidates: Arrival[] = [];
  for (const entity of entities) { const update = entity.tripUpdate; if (!update || update.trip?.scheduleRelationship === 3 || update.trip?.scheduleRelationship === 2) continue; const tripId = update.trip?.tripId; const trip = trips.get(tripId); if (!trip) continue;
    for (const stop of update.stopTimeUpdate ?? []) { if (!targetIds.has(stop.stopId) || stop.scheduleRelationship === 1) continue; const at = seconds(stop.arrival?.time ?? stop.departure?.time) * 1000; if (at > now && at - now < 4 * 60 * 60_000) candidates.push({ tripId, routeId: update.trip.routeId || trip.routeId, vehicleId: update.vehicle?.id || undefined, arrivalAt: new Date(at).toISOString(), feedTimestamp: feedAt, stopId: stop.stopId }); }
  }
  return candidates.sort((a, b) => +new Date(a.arrivalAt) - +new Date(b.arrivalAt))[0] ?? null;
}
async function live(): Promise<LiveTransit> {
  if (realtimeCache && Date.now() - realtimeCache.at < REALTIME_TTL_MS) return realtimeCache.value;
  if (!refreshRealtime) refreshRealtime = (async () => {
    // On a cold process the static ZIP can take several seconds. Start all
    // independent upstream requests together instead of serializing them.
    const [gtfs, tripsRaw, vehiclesRaw] = await Promise.all([staticGtfs(), fetchBytes(TRIPS_URL), fetchBytes(VEHICLES_URL)]);
    const tripFeed = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(tripsRaw), vehicleFeed = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(vehiclesRaw);
    const tripFeedAt = new Date(seconds((tripFeed.header as any)?.timestamp) * 1000 || Date.now()).toISOString(), vehicleFeedAt = new Date(seconds((vehicleFeed.header as any)?.timestamp) * 1000 || Date.now()).toISOString();
    const arrival = selectNextArrival((tripFeed as any).entity ?? [], new Set(gtfs.collegeStops.map((s) => s.id)), gtfs.trips, Date.now(), tripFeedAt);
    const vehicles: LiveVehicle[] = ((vehicleFeed as any).entity ?? []).flatMap((e: any) => { const v = e.vehicle, p = v?.position, trip = gtfs.trips.get(v?.trip?.tripId); if (!v?.vehicle?.id || !Number.isFinite(p?.latitude) || !Number.isFinite(p?.longitude)) return []; return [{ id: v.vehicle.id, routeId: v.trip?.routeId || trip?.routeId || "Unknown", tripId: v.trip?.tripId || undefined, latitude: p.latitude, longitude: p.longitude, heading: p.bearing || undefined, updatedAt: new Date(seconds(v.timestamp) * 1000 || Date.now()).toISOString() }]; });
    const tracked = arrival && vehicles.find((v) => (arrival.vehicleId && v.id === arrival.vehicleId) || v.tripId === arrival.tripId);
    if (arrival && tracked && !arrival.vehicleId) arrival.vehicleId = tracked.id;
    const selectedTrip = arrival ? gtfs.trips.get(arrival.tripId) : undefined, routeGeometry = selectedTrip?.shapeId ? gtfs.shapes.get(selectedTrip.shapeId) ?? [] : [];
    const observedAt = vehicleFeedAt, value = { vehicles, routes: [...gtfs.routes.values()], targetStops: gtfs.collegeStops, nextArrival: arrival, routeGeometry, observedAt, tripFeedAt, vehicleFeedAt, stale: Date.now() - Math.min(+new Date(tripFeedAt), +new Date(vehicleFeedAt)) > STALE_MS };
    realtimeCache = { value, at: Date.now() }; return value;
  })().finally(() => { refreshRealtime = undefined; });
  return refreshRealtime;
}
export const tripshotLive = live;

/** Reads the shared live cache but renders only the vehicle/trip frozen into a market. */
export async function tripshotFrozenTrip(tripId: string, vehicleId: string): Promise<FrozenTripSnapshot> {
  const [value, gtfs] = await Promise.all([live(), staticGtfs()]);
  const vehicle = value.vehicles.find((candidate) => candidate.id === vehicleId || candidate.tripId === tripId) ?? null;
  const trip = gtfs.trips.get(tripId);
  return {
    vehicle,
    routeGeometry: trip?.shapeId ? gtfs.shapes.get(trip.shapeId) ?? [] : [],
    observedAt: value.observedAt,
    tripFeedAt: value.tripFeedAt,
    vehicleFeedAt: value.vehicleFeedAt,
    stale: value.stale,
  };
}
