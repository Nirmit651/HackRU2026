-- Remote migration version: 20261010171435 (harden_bus_pipeline_access).
-- Keep the trigger helper out of PostgREST RPC access and cover pipeline FKs.

revoke execute on function public.refresh_bus_latest() from anon, authenticated;

revoke truncate, references, trigger on table public.bus_routes from service_role;
revoke truncate, references, trigger on table public.bus_collection_runs from service_role;
revoke truncate, references, trigger on table public.bus_snapshots from service_role;
revoke truncate, references, trigger on table public.bus_observations from service_role;

create index bus_snapshots_collection_run_id_idx
    on public.bus_snapshots (collection_run_id);

create index bus_observations_collection_run_id_idx
    on public.bus_observations (collection_run_id);

create index bus_observations_snapshot_id_idx
    on public.bus_observations (snapshot_id);

create index bus_latest_route_idx
    on public.bus_latest (source_system, route_id)
    where route_id is not null;
