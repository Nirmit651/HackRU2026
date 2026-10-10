-- Remote migration version: 20261010171307 (create_bus_pipeline_foundation).
-- Bus data pipeline foundation for the verified RUBus HTTP/WebSocket sources.
-- All timestamps are timestamptz and are stored by PostgreSQL as UTC instants.

create table public.bus_routes (
    source_system text not null,
    route_id text not null,
    display_name text,
    campus_id text,
    is_currently_known boolean not null default true,
    first_seen_at timestamptz,
    last_verified_at timestamptz,
    evidence_ref text,
    source_metadata jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    primary key (source_system, route_id),
    constraint bus_routes_source_system_not_blank check (btrim(source_system) <> ''),
    constraint bus_routes_route_id_not_blank check (btrim(route_id) <> ''),
    constraint bus_routes_source_metadata_object check (jsonb_typeof(source_metadata) = 'object'),
    constraint bus_routes_seen_order check (
        first_seen_at is null or last_verified_at is null or first_seen_at <= last_verified_at
    )
);

create table public.bus_collection_runs (
    id uuid primary key default gen_random_uuid(),
    source_system text not null,
    transport text not null,
    source_endpoint text not null,
    status text not null default 'running',
    started_at timestamptz not null default now(),
    completed_at timestamptz,
    http_status integer,
    records_received integer,
    records_valid integer,
    records_invalid integer,
    response_bytes bigint,
    is_complete boolean,
    error_code text,
    error_message text,
    quality_summary jsonb not null default '{}'::jsonb,
    evidence_ref text,
    constraint bus_collection_runs_source_system_not_blank check (btrim(source_system) <> ''),
    constraint bus_collection_runs_transport check (transport in ('http_snapshot', 'websocket')),
    constraint bus_collection_runs_endpoint_not_blank check (btrim(source_endpoint) <> ''),
    constraint bus_collection_runs_status check (status in ('running', 'succeeded', 'partial', 'failed')),
    constraint bus_collection_runs_completion check (
        (status = 'running' and completed_at is null)
        or (status <> 'running' and completed_at is not null and completed_at >= started_at)
    ),
    constraint bus_collection_runs_http_status check (http_status is null or http_status between 100 and 599),
    constraint bus_collection_runs_counts check (
        (records_received is null or records_received >= 0)
        and (records_valid is null or records_valid >= 0)
        and (records_invalid is null or records_invalid >= 0)
        and (response_bytes is null or response_bytes >= 0)
        and (records_received is null or records_valid is null or records_valid <= records_received)
        and (records_received is null or records_invalid is null or records_invalid <= records_received)
    ),
    constraint bus_collection_runs_quality_object check (jsonb_typeof(quality_summary) = 'object')
);

create table public.bus_snapshots (
    id uuid primary key default gen_random_uuid(),
    collection_run_id uuid not null references public.bus_collection_runs(id),
    source_system text not null,
    transport text not null,
    message_kind text not null,
    retrieved_at timestamptz not null,
    source_measured_at timestamptz,
    source_time_status text not null,
    is_complete boolean not null,
    is_valid boolean not null,
    record_count integer,
    payload_sha256 text,
    payload jsonb not null,
    quality_flags jsonb not null default '[]'::jsonb,
    evidence_ref text,
    created_at timestamptz not null default now(),
    constraint bus_snapshots_source_system_not_blank check (btrim(source_system) <> ''),
    constraint bus_snapshots_transport check (transport in ('http_snapshot', 'websocket')),
    constraint bus_snapshots_message_kind check (
        message_kind in ('vehicle_snapshot', 'initial_state', 'stream_event')
    ),
    constraint bus_snapshots_source_time_status check (
        source_time_status in ('provided', 'missing', 'mixed', 'not_applicable')
    ),
    constraint bus_snapshots_source_time_consistent check (
        (source_time_status = 'provided' and source_measured_at is not null)
        or (source_time_status in ('missing', 'mixed', 'not_applicable') and source_measured_at is null)
    ),
    constraint bus_snapshots_record_count check (record_count is null or record_count >= 0),
    constraint bus_snapshots_payload_sha256 check (
        payload_sha256 is null or payload_sha256 ~ '^[0-9a-f]{64}$'
    ),
    constraint bus_snapshots_payload_container check (jsonb_typeof(payload) in ('object', 'array')),
    constraint bus_snapshots_quality_flags_array check (jsonb_typeof(quality_flags) = 'array')
);

create table public.bus_observations (
    id bigint generated always as identity primary key,
    collection_run_id uuid not null references public.bus_collection_runs(id),
    snapshot_id uuid not null references public.bus_snapshots(id),
    source_system text not null,
    source_observation_id text,
    observation_kind text not null,
    vehicle_id text not null,
    route_id text,
    source_measured_at timestamptz,
    retrieved_at timestamptz not null,
    measurement_time_basis text not null,
    effective_observed_at timestamptz generated always as (
        coalesce(source_measured_at, retrieved_at)
    ) stored,
    latitude double precision,
    longitude double precision,
    rotation_degrees double precision,
    occupancy_percent numeric(5,2),
    rider_count integer,
    vehicle_capacity integer,
    stopped boolean,
    stop_id text,
    arrived_at timestamptz,
    event_type text,
    is_valid boolean not null,
    quality_flags jsonb not null default '[]'::jsonb,
    evidence_ref text,
    created_at timestamptz not null default now(),
    constraint bus_observations_source_system_not_blank check (btrim(source_system) <> ''),
    constraint bus_observations_vehicle_id_not_blank check (btrim(vehicle_id) <> ''),
    constraint bus_observations_kind check (
        observation_kind in ('vehicle_position', 'vehicle_status')
    ),
    constraint bus_observations_time_basis check (measurement_time_basis in ('source', 'retrieval')),
    constraint bus_observations_source_time_consistent check (
        (measurement_time_basis = 'source' and source_measured_at is not null)
        or (measurement_time_basis = 'retrieval' and source_measured_at is null)
    ),
    constraint bus_observations_latitude check (latitude is null or latitude between -90 and 90),
    constraint bus_observations_longitude check (longitude is null or longitude between -180 and 180),
    constraint bus_observations_rotation check (
        rotation_degrees is null or (rotation_degrees >= 0 and rotation_degrees <= 360)
    ),
    constraint bus_observations_occupancy check (
        occupancy_percent is null or (occupancy_percent >= 0 and occupancy_percent <= 100)
    ),
    constraint bus_observations_rider_count check (rider_count is null or rider_count >= 0),
    constraint bus_observations_vehicle_capacity check (vehicle_capacity is null or vehicle_capacity >= 0),
    constraint bus_observations_quality_flags_array check (jsonb_typeof(quality_flags) = 'array'),
    constraint bus_observations_route_fk foreign key (source_system, route_id)
        references public.bus_routes(source_system, route_id)
);

create table public.bus_latest (
    source_system text not null,
    vehicle_id text not null,
    observation_id bigint not null unique references public.bus_observations(id),
    observation_kind text not null,
    route_id text,
    source_measured_at timestamptz,
    retrieved_at timestamptz not null,
    measurement_time_basis text not null,
    effective_observed_at timestamptz not null,
    latitude double precision,
    longitude double precision,
    rotation_degrees double precision,
    occupancy_percent numeric(5,2),
    rider_count integer,
    vehicle_capacity integer,
    stopped boolean,
    stop_id text,
    arrived_at timestamptz,
    event_type text,
    quality_flags jsonb not null default '[]'::jsonb,
    evidence_ref text,
    updated_at timestamptz not null default now(),
    primary key (source_system, vehicle_id),
    constraint bus_latest_route_fk foreign key (source_system, route_id)
        references public.bus_routes(source_system, route_id),
    constraint bus_latest_quality_flags_array check (jsonb_typeof(quality_flags) = 'array')
);

create unique index bus_observations_source_id_uq
    on public.bus_observations (source_system, source_observation_id)
    where source_observation_id is not null;

create unique index bus_observations_source_time_uq
    on public.bus_observations (source_system, vehicle_id, observation_kind, source_measured_at)
    where source_observation_id is null and source_measured_at is not null;

create unique index bus_observations_retrieval_time_uq
    on public.bus_observations (source_system, vehicle_id, observation_kind, retrieved_at)
    where source_observation_id is null and source_measured_at is null;

create index bus_collection_runs_started_at_idx
    on public.bus_collection_runs (started_at desc);

create index bus_collection_runs_failed_idx
    on public.bus_collection_runs (started_at desc)
    where status in ('partial', 'failed');

create index bus_snapshots_retrieved_at_idx
    on public.bus_snapshots (source_system, retrieved_at desc);

create index bus_snapshots_payload_sha256_idx
    on public.bus_snapshots (source_system, payload_sha256)
    where payload_sha256 is not null;

create index bus_observations_vehicle_history_idx
    on public.bus_observations (source_system, vehicle_id, effective_observed_at desc, retrieved_at desc);

create index bus_observations_route_history_idx
    on public.bus_observations (source_system, route_id, effective_observed_at desc)
    where route_id is not null;

create index bus_observations_retrieved_at_idx
    on public.bus_observations (retrieved_at desc);

create or replace function public.refresh_bus_latest()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
    if not new.is_valid then
        return new;
    end if;

    insert into public.bus_latest (
        source_system, vehicle_id, observation_id, observation_kind, route_id,
        source_measured_at, retrieved_at, measurement_time_basis, effective_observed_at,
        latitude, longitude, rotation_degrees, occupancy_percent, rider_count,
        vehicle_capacity, stopped, stop_id, arrived_at, event_type, quality_flags,
        evidence_ref, updated_at
    ) values (
        new.source_system, new.vehicle_id, new.id, new.observation_kind, new.route_id,
        new.source_measured_at, new.retrieved_at, new.measurement_time_basis,
        new.effective_observed_at, new.latitude, new.longitude, new.rotation_degrees,
        new.occupancy_percent, new.rider_count, new.vehicle_capacity, new.stopped,
        new.stop_id, new.arrived_at, new.event_type, new.quality_flags,
        new.evidence_ref, now()
    )
    on conflict (source_system, vehicle_id) do update set
        observation_id = excluded.observation_id,
        observation_kind = excluded.observation_kind,
        route_id = excluded.route_id,
        source_measured_at = excluded.source_measured_at,
        retrieved_at = excluded.retrieved_at,
        measurement_time_basis = excluded.measurement_time_basis,
        effective_observed_at = excluded.effective_observed_at,
        latitude = excluded.latitude,
        longitude = excluded.longitude,
        rotation_degrees = excluded.rotation_degrees,
        occupancy_percent = excluded.occupancy_percent,
        rider_count = excluded.rider_count,
        vehicle_capacity = excluded.vehicle_capacity,
        stopped = excluded.stopped,
        stop_id = excluded.stop_id,
        arrived_at = excluded.arrived_at,
        event_type = excluded.event_type,
        quality_flags = excluded.quality_flags,
        evidence_ref = excluded.evidence_ref,
        updated_at = now()
    where excluded.effective_observed_at > bus_latest.effective_observed_at
       or (
            excluded.effective_observed_at = bus_latest.effective_observed_at
            and excluded.retrieved_at > bus_latest.retrieved_at
       );

    return new;
end;
$$;

create trigger bus_observations_refresh_latest
after insert on public.bus_observations
for each row execute function public.refresh_bus_latest();

insert into public.bus_routes (
    source_system, route_id, display_name, campus_id, last_verified_at,
    evidence_ref, source_metadata
)
values
    ('rubus', 'a', 'A', 'nb', '2026-10-10T17:05:30Z', 'rubus-client@ede41e6:js/vars.js', '{"metadata_origin":"rubus_client"}'),
    ('rubus', 'b', 'B', 'nb', '2026-10-10T17:05:30Z', 'rubus-client@ede41e6:js/vars.js', '{"metadata_origin":"rubus_client"}'),
    ('rubus', 'bhe', 'Busch Health', 'nb', '2026-10-10T17:05:30Z', 'rubus-client@ede41e6:js/vars.js', '{"metadata_origin":"rubus_client"}'),
    ('rubus', 'ee', 'EE', 'nb', '2026-10-10T17:05:30Z', 'rubus-client@ede41e6:js/vars.js', '{"metadata_origin":"rubus_client"}'),
    ('rubus', 'f', 'F', 'nb', '2026-10-10T17:05:30Z', 'rubus-client@ede41e6:js/vars.js', '{"metadata_origin":"rubus_client"}'),
    ('rubus', 'h', 'H', 'nb', '2026-10-10T17:05:30Z', 'rubus-client@ede41e6:js/vars.js', '{"metadata_origin":"rubus_client"}'),
    ('rubus', 'lx', 'Livi Express', 'nb', '2026-10-10T17:05:30Z', 'rubus-client@ede41e6:js/vars.js', '{"metadata_origin":"rubus_client"}'),
    ('rubus', 'on1', 'Overnight 1', 'nb', '2026-10-10T17:05:30Z', 'rubus-client@ede41e6:js/vars.js', '{"metadata_origin":"rubus_client","feed_aliases":["ONWK1FS"]}'),
    ('rubus', 'on2', 'Overnight 2', 'nb', '2026-10-10T17:05:30Z', 'rubus-client@ede41e6:js/vars.js', '{"metadata_origin":"rubus_client","feed_aliases":["ONWK2FS"]}'),
    ('rubus', 'rexb', 'REXB', 'nb', '2026-10-10T17:05:30Z', 'rubus-client@ede41e6:js/vars.js', '{"metadata_origin":"rubus_client"}'),
    ('rubus', 'rexl', 'REXL', 'nb', '2026-10-10T17:05:30Z', 'rubus-client@ede41e6:js/vars.js', '{"metadata_origin":"rubus_client"}'),
    ('rubus', 'wknd1', 'Weekend 1', 'nb', '2026-10-10T17:05:30Z', 'rubus-client@ede41e6:js/vars.js', '{"metadata_origin":"rubus_client"}'),
    ('rubus', 'wknd2', 'Weekend 2', 'nb', '2026-10-10T17:05:30Z', 'rubus-client@ede41e6:js/vars.js', '{"metadata_origin":"rubus_client"}'),
    ('rubus', 'c', 'Busch Commuter', 'nb', '2026-10-10T17:05:30Z', 'rubus-client@ede41e6:js/vars.js', '{"metadata_origin":"rubus_client"}'),
    ('rubus', 'ftbl', 'Football', 'nb', '2026-10-10T17:05:30Z', 'rubus-client@ede41e6:js/vars.js', '{"metadata_origin":"rubus_client"}'),
    ('rubus', 'all', 'All', 'nb', '2026-10-10T17:05:30Z', 'rubus-client@ede41e6:js/vars.js', '{"metadata_origin":"rubus_client"}'),
    ('rubus', 'winter1', 'Winter 1', 'nb', '2026-10-10T17:05:30Z', 'rubus-client@ede41e6:js/vars.js', '{"metadata_origin":"rubus_client"}'),
    ('rubus', 'winter2', 'Winter 2', 'nb', '2026-10-10T17:05:30Z', 'rubus-client@ede41e6:js/vars.js', '{"metadata_origin":"rubus_client"}'),
    ('rubus', 'bl', 'Busch Loop', 'nb', '2026-10-10T17:05:30Z', 'rubus-client@ede41e6:js/vars.js', '{"metadata_origin":"rubus_client"}'),
    ('rubus', 'summer1', 'Summer 1', 'nb', '2026-10-10T17:05:30Z', 'rubus-client@ede41e6:js/vars.js', '{"metadata_origin":"rubus_client"}'),
    ('rubus', 'summer2', 'Summer 2', 'nb', '2026-10-10T17:05:30Z', 'rubus-client@ede41e6:js/vars.js', '{"metadata_origin":"rubus_client"}'),
    ('rubus', 'commencement', 'Commencement', 'nb', '2026-10-10T17:05:30Z', 'rubus-client@ede41e6:js/vars.js', '{"metadata_origin":"rubus_client"}'),
    ('rubus', 'helix', 'Helix', 'nb', '2026-10-10T17:05:30Z', 'rubus-client@ede41e6:js/vars.js', '{"metadata_origin":"rubus_client"}'),
    ('rubus', 'kbs', 'Knightsbridge', 'nb', '2026-10-10T17:05:30Z', 'rubus-client@ede41e6:js/vars.js', '{"metadata_origin":"rubus_client"}'),
    ('rubus', 'cam', 'Camden', 'camden', '2026-10-10T17:05:30Z', 'rubus-client@ede41e6:js/vars.js', '{"metadata_origin":"rubus_client"}'),
    ('rubus', 'cc', 'Campus Connect', 'newark', '2026-10-10T17:05:30Z', 'rubus-client@ede41e6:js/vars.js', '{"metadata_origin":"rubus_client"}'),
    ('rubus', 'ccx', 'Campus Connect Express', 'newark', '2026-10-10T17:05:30Z', 'rubus-client@ede41e6:js/vars.js', '{"metadata_origin":"rubus_client"}'),
    ('rubus', 'ps', 'Penn Station', 'newark', '2026-10-10T17:05:30Z', 'rubus-client@ede41e6:js/vars.js', '{"metadata_origin":"rubus_client"}'),
    ('rubus', 'psx', 'Penn Station Express', 'newark', '2026-10-10T17:05:30Z', 'rubus-client@ede41e6:js/vars.js', '{"metadata_origin":"rubus_client"}');

alter table public.bus_routes enable row level security;
alter table public.bus_collection_runs enable row level security;
alter table public.bus_snapshots enable row level security;
alter table public.bus_observations enable row level security;
alter table public.bus_latest enable row level security;

revoke all on table public.bus_routes from anon, authenticated;
revoke all on table public.bus_collection_runs from anon, authenticated;
revoke all on table public.bus_snapshots from anon, authenticated;
revoke all on table public.bus_observations from anon, authenticated;
revoke all on table public.bus_latest from anon, authenticated;
revoke all on sequence public.bus_observations_id_seq from anon, authenticated;
revoke all on function public.refresh_bus_latest() from public;

grant select, insert, update, delete on table public.bus_routes to service_role;
grant select, insert, update, delete on table public.bus_collection_runs to service_role;
grant select, insert, update, delete on table public.bus_snapshots to service_role;
grant select, insert, update, delete on table public.bus_observations to service_role;
-- bus_latest is trigger-owned; backend collectors write observations, not this table.
revoke insert, update, delete, truncate, references, trigger on table public.bus_latest from service_role;
grant select on table public.bus_latest to service_role;
grant usage, select on sequence public.bus_observations_id_seq to service_role;
grant execute on function public.refresh_bus_latest() to service_role;

comment on table public.bus_snapshots is
    'Raw RUBus HTTP snapshots or WebSocket messages retained as collection evidence.';
comment on column public.bus_snapshots.source_time_status is
    'provided: one source time exists; missing: expected but absent; mixed: per-record times differ; not_applicable: message has no measurement time.';
comment on column public.bus_observations.measurement_time_basis is
    'source when source_measured_at was supplied; retrieval only when no source measurement time exists. Retrieval time is never silently substituted.';
comment on column public.bus_observations.source_observation_id is
    'Stable upstream observation/event ID when supplied. Current verified RUBus payloads do not supply one.';
comment on column public.bus_observations.effective_observed_at is
    'Ordering time: source_measured_at when present, otherwise explicitly retrieval-based retrieved_at.';
comment on table public.bus_latest is
    'Latest valid observation per source vehicle, maintained by trigger; older effective observation times cannot replace newer state.';
