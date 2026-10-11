import { useEffect, useRef, useState } from "react";
import mapboxgl from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";
import type { Feature, FeatureCollection } from "geojson";
import { request, date } from "./api";
import type { BusSnapshot } from "../shared/contracts";

type LngLat = [number, number];
const rutgersCenter: LngLat = [-74.437, 40.5235];

export const interpolatePosition = (from: LngLat, to: LngLat, progress: number): LngLat => [
  from[0] + (to[0] - from[0]) * progress,
  from[1] + (to[1] - from[1]) * progress,
];

export const routePoints = (snapshot: BusSnapshot): LngLat[] => {
  const supplied = snapshot.routeGeometry?.filter(
    ([longitude, latitude]) => Number.isFinite(longitude) && Number.isFinite(latitude),
  );
  if (supplied && supplied.length > 1) return supplied;
  return []; // GTFS shape only: never imply a route with a straight line to the stop.
};

const featureCollection = (features: Feature[]): FeatureCollection => ({ type: "FeatureCollection", features });
const vehicleData = (snapshot: BusSnapshot, selectedRoute?: string, trackedPosition?: LngLat) => featureCollection(snapshot.vehicles.filter((vehicle) => !selectedRoute || vehicle.routeId === selectedRoute).map((vehicle) => ({ type: "Feature", properties: { routeId: vehicle.routeId, tracked: vehicle.id === snapshot.trackedVehicleId ? "yes" : "no" }, geometry: { type: "Point", coordinates: vehicle.id === snapshot.trackedVehicleId && trackedPosition ? trackedPosition : [vehicle.longitude, vehicle.latitude] } })));
const stopData = (snapshot: BusSnapshot) => featureCollection(snapshot.stops.map((stop) => ({ type: "Feature", properties: { name: stop.name }, geometry: { type: "Point", coordinates: [stop.longitude, stop.latitude] } })));
const routeData = (snapshot: BusSnapshot) => {
  const coordinates = routePoints(snapshot);
  return featureCollection(coordinates.length > 1 ? [{ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates } }] : []);
};
function setSource(map: mapboxgl.Map, id: string, data: FeatureCollection) {
  (map.getSource(id) as mapboxgl.GeoJSONSource | undefined)?.setData(data);
}

export function BusMap({ marketId, accessToken, routeId, stopName, deadline }: { marketId: string; accessToken: string | null; routeId: string; stopName: string; deadline: string }) {
  const host = useRef<HTMLDivElement>(null), mapRef = useRef<mapboxgl.Map | null>(null), positionRef = useRef<LngLat | null>(null), animationRef = useRef<number | null>(null), fittedRef = useRef(false), [snapshot, setSnapshot] = useState<BusSnapshot | null>(null), [ready, setReady] = useState(false), [failed, setFailed] = useState(false), [selectedRoute, setSelectedRoute] = useState<string | undefined>();

  useEffect(() => {
    let stopped = false;
    const load = () => request<{ snapshot: BusSnapshot | null }>(`/markets/${marketId}/bus`).then((result) => {
      if (!stopped) { setSnapshot(result.snapshot); setFailed(!result.snapshot); }
    }).catch(() => { if (!stopped) setFailed(true); });
    void load();
    const timer = setInterval(load, 5000);
    return () => { stopped = true; clearInterval(timer); };
  }, [marketId]);

  useEffect(() => {
    if (!host.current || !accessToken) return;
    mapboxgl.accessToken = accessToken;
    const map = new mapboxgl.Map({ container: host.current, style: "mapbox://styles/mapbox/streets-v12", center: rutgersCenter, zoom: 13, attributionControl: true });
    mapRef.current = map;
    map.on("error", () => setFailed(true));
    map.on("load", () => {
      map.addSource("bus-route", { type: "geojson", data: featureCollection([]) });
      map.addSource("bus-stops", { type: "geojson", data: featureCollection([]) });
      map.addSource("bus-vehicle", { type: "geojson", data: featureCollection([]) });
      map.addLayer({ id: "bus-route-outline", type: "line", source: "bus-route", paint: { "line-color": "#ffffff", "line-width": 7, "line-opacity": 0.9 } });
      map.addLayer({ id: "bus-route-line", type: "line", source: "bus-route", paint: { "line-color": "#c8102e", "line-width": 4, "line-opacity": 0.92 } });
      map.addLayer({ id: "bus-stop-dot", type: "circle", source: "bus-stops", paint: { "circle-radius": 6, "circle-color": "#27242a", "circle-stroke-width": 2, "circle-stroke-color": "#ffffff" } });
      map.addLayer({ id: "bus-vehicle-dot", type: "circle", source: "bus-vehicle", paint: { "circle-radius": ["case", ["==", ["get", "tracked"], "yes"], 10, 5], "circle-color": ["case", ["==", ["get", "tracked"], "yes"], "#c8102e", "#706b70"], "circle-opacity": ["case", ["==", ["get", "tracked"], "yes"], 1, 0.55], "circle-stroke-width": 2, "circle-stroke-color": "#ffffff" } });
      map.addLayer({ id: "bus-vehicle-label", type: "symbol", source: "bus-vehicle", layout: { "text-field": ["get", "routeId"], "text-size": 11, "text-offset": [0, -1.7], "text-anchor": "bottom" }, paint: { "text-color": "#34242a", "text-halo-color": "#ffffff", "text-halo-width": 1.5 } });
      setReady(true);
    });
    return () => { if (animationRef.current) cancelAnimationFrame(animationRef.current); map.remove(); mapRef.current = null; setReady(false); };
  }, [accessToken]);

  useEffect(() => {
    const map = mapRef.current, vehicle = snapshot?.vehicles.find((v) => v.id === snapshot.trackedVehicleId) ?? snapshot?.vehicles[0];
    if (!map || !ready || !snapshot) return;
    setSource(map, "bus-route", routeData(snapshot));
    setSource(map, "bus-stops", stopData(snapshot));
    if (!vehicle) { setSource(map, "bus-vehicle", vehicleData(snapshot, selectedRoute)); return; }
    const target: LngLat = [vehicle.longitude, vehicle.latitude];
    if (!fittedRef.current) {
      const bounds = new mapboxgl.LngLatBounds();
      for (const point of [...routePoints(snapshot), ...snapshot.stops.map((stop) => [stop.longitude, stop.latitude] as LngLat)]) bounds.extend(point);
      if (!bounds.isEmpty()) map.fitBounds(bounds, { padding: 52, maxZoom: 15, duration: 0 });
      fittedRef.current = true;
    }
    const from = positionRef.current ?? target;
    positionRef.current = target;
    if (animationRef.current) cancelAnimationFrame(animationRef.current);
    const startedAt = performance.now(), duration = 4400;
    const tick = (now: number) => {
      const progress = Math.min(1, (now - startedAt) / duration), eased = progress * (2 - progress);
      setSource(map, "bus-vehicle", vehicleData(snapshot, selectedRoute, interpolatePosition(from, target, eased)));
      if (progress < 1) animationRef.current = requestAnimationFrame(tick);
    };
    tick(startedAt);
  }, [ready, snapshot, selectedRoute]);

  return <section className="bus-panel" aria-label={`Route ${routeId} map`}>
    <div className="bus-panel-heading"><div><span className="section-label">Route {routeId} · {stopName}</span><h2>Bus route</h2></div><div className="bus-status">{failed ? "Live feed unavailable" : snapshot?.isSimulated ? "SIMULATED · recorded scenario" : snapshot && snapshot.vehicles.length === 0 ? "Selected vehicle unavailable" : snapshot && Date.now() - Date.parse(snapshot.observedAt) > 30000 ? "Stale vehicle data" : "Live vehicle data"}</div></div>
    <p className="bus-panel-copy">{snapshot?.predictedArrival ? `Predicted arrival ${date(snapshot.predictedArrival)} · ` : ""}Follow the actual GTFS route shape to the target stop. Deadline {date(deadline)}.</p>
    {!!snapshot?.activeRoutes?.length && <div className="route-chips" aria-label="Active routes">{snapshot.activeRoutes.map((active) => <button key={active} className={selectedRoute === active ? "active" : ""} onClick={() => setSelectedRoute(selectedRoute === active ? undefined : active)}>{active}</button>)}</div>}
    {accessToken ? <div ref={host} className="map" /> : <div className="map-empty">Mapbox is not configured.</div>}
    <small>{snapshot ? snapshot.vehicles.length ? `${snapshot.source} · vehicles ${date(snapshot.vehicleFeedAt ?? snapshot.observedAt)} · predictions ${date(snapshot.tripFeedAt ?? snapshot.observedAt)}` : "The frozen vehicle is not currently present in the live feed; no replacement bus is shown." : "No live arrival prediction is available."}</small>
  </section>;
}
