# Bus ingestion boundary

Automated stop-duration markets now consume the teammate's persisted `bus_observations` directly, without another upstream poller. Their map endpoint uses persisted visit evidence. See [automation integration and frozen coverage rules](AUTOMATION.md#bus-integration-and-evidence-limits). The HTTP adapter described below remains available for existing manual bus-arrival markets.

The teammate owns ingestion. Scarlet makes server-side GET requests to `BUS_ADAPTER_URL?marketId=<uuid>` using optional `BUS_ADAPTER_TOKEN`. `server/bus.ts` validates every result; `shared/contracts.ts` contains `BusSnapshot`. There is no dependency on undocumented rubus-client endpoints, and this repo does not replace the teammate's work.

Return `source`, `isSimulated`, `observedAt`, `receivedAt`, `vehicles` (ID, route ID, WGS84 latitude/longitude, timestamp; optional heading), and `stops` (ID, name, WGS84 coordinates). Optional route geometry is `[longitude, latitude][]`; ETA is seconds. Times are ISO UTC. Unknown locations must be omitted. HTTP failure or no configuration shows “Live feed unavailable.” Live environments reject simulated feeds. The map marks observations older than 30 seconds stale. Map state is not settlement evidence.

For settlement, return the normalized `ProviderEvidence` contract through `EVIDENCE_ADAPTER_URL?marketId=...`, or submit it for authorized manual review. Match the frozen provider, external event/route/trip/stop identifier, units, window and source URL. A route marker passing near a stop is insufficient evidence. Only persist the required final observation and private raw payload; high-frequency telemetry stays with ingestion.

DEMO uses explicit static synthetic Livingston Plaza coordinates. This fixture is not an assertion of a real stop survey or vehicle location. Configure the public `MAPBOX_KEY` (`pk.` prefix) for the Mapbox basemap. Without it, the UI displays an honest unavailable state and coordinates.

Reference for teammate coordination: https://github.com/JoyousJohn/rubus-client . Verify any upstream API/version with its owner before connecting.
