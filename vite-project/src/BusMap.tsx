import { useEffect, useRef, useState } from "react";
import * as maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { request, date } from "./api";
import type { BusSnapshot } from "../shared/contracts";
export function BusMap({
  marketId,
  style,
  routeId,
  stopName,
  deadline,
}: {
  marketId: string;
  style: string | null;
  routeId: string;
  stopName: string;
  deadline: string;
}) {
  const host = useRef<HTMLDivElement>(null),
    [snapshot, setSnapshot] = useState<BusSnapshot | null>(null),
    [failed, setFailed] = useState(false);
  useEffect(() => {
    let stopped = false;
    const load = () =>
      request<{ snapshot: BusSnapshot | null }>(`/markets/${marketId}/bus`)
        .then((r) => {
          if (!stopped) {
            setSnapshot(r.snapshot);
            setFailed(!r.snapshot);
          }
        })
        .catch(() => {
          if (!stopped) setFailed(true);
        });
    void load();
    const timer = setInterval(load, 5000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [marketId]);
  useEffect(() => {
    if (!host.current || !snapshot || !style) return;
    const map = new maplibregl.Map({
      container: host.current,
      style,
      center: [
        snapshot.stops[0]?.longitude ?? -74.437,
        snapshot.stops[0]?.latitude ?? 40.5235,
      ],
      zoom: 14,
    });
    map.on("error", () => setFailed(true));
    for (const s of snapshot.stops)
      new maplibregl.Marker({ color: "#333" })
        .setLngLat([s.longitude, s.latitude])
        .setPopup(new maplibregl.Popup().setText(s.name))
        .addTo(map);
    for (const v of snapshot.vehicles)
      new maplibregl.Marker({ color: "#bf243d" })
        .setLngLat([v.longitude, v.latitude])
        .setPopup(
          new maplibregl.Popup().setText(
            `${v.routeId} · ${snapshot.isSimulated ? "simulated" : "live"}`,
          ),
        )
        .addTo(map);
    return () => map.remove();
  }, [snapshot, style]);
  return (
    <section className="bus-panel">
      <div className="section-label">
        Route {routeId} · {stopName}
      </div>
      <h3>At the next stop</h3>
      <p>Deadline {date(deadline)}</p>
      <p>
        {failed
          ? "Live feed unavailable"
          : snapshot?.isSimulated
            ? "SIMULATED · recorded scenario"
            : snapshot && Date.now() - Date.parse(snapshot.observedAt) > 30000
              ? "Stale vehicle data"
              : "Live vehicle data"}
      </p>
      {style ? (
        <div ref={host} className="map" />
      ) : (
        <div className="map-empty">
          Map tiles are not configured.
          <br />
          {snapshot?.stops.map((s) => (
            <span key={s.id}>
              {s.name} · {s.latitude}, {s.longitude}
            </span>
          ))}
        </div>
      )}
      <small>
        {snapshot
          ? `${snapshot.source} · ${date(snapshot.observedAt)}`
          : "Waiting for teammate adapter"}
      </small>
    </section>
  );
}
