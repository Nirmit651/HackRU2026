create table public.tripshot_static_feeds (
    feed_hash text primary key,
    fetched_at timestamptz not null default now(),
    source_url text not null,
    is_active boolean not null default true,
    route_count integer not null,
    stop_count integer not null,
    trip_count integer not null,
    shape_count integer not null,
    created_at timestamptz not null default now(),
    constraint tripshot_static_feeds_hash check (feed_hash ~ '^[0-9a-f]{64}$')
);

create unique index tripshot_static_feeds_one_active_idx
    on public.tripshot_static_feeds ((is_active)) where is_active;

create table public.tripshot_gtfs_routes (
    feed_hash text not null references public.tripshot_static_feeds(feed_hash) on delete cascade,
    route_id text not null,
    short_name text not null,
    long_name text not null,
    color text,
    primary key (feed_hash, route_id)
);

create table public.tripshot_gtfs_stops (
    feed_hash text not null references public.tripshot_static_feeds(feed_hash) on delete cascade,
    stop_id text not null,
    stop_name text not null,
    latitude double precision not null check (latitude between -90 and 90),
    longitude double precision not null check (longitude between -180 and 180),
    primary key (feed_hash, stop_id)
);

create table public.tripshot_gtfs_shapes (
    feed_hash text not null references public.tripshot_static_feeds(feed_hash) on delete cascade,
    shape_id text not null,
    points jsonb not null,
    point_count integer not null check (point_count > 0),
    primary key (feed_hash, shape_id),
    constraint tripshot_gtfs_shapes_points_array check (jsonb_typeof(points) = 'array')
);

create table public.tripshot_gtfs_trips (
    feed_hash text not null references public.tripshot_static_feeds(feed_hash) on delete cascade,
    trip_id text not null,
    route_id text not null,
    shape_id text,
    primary key (feed_hash, trip_id),
    foreign key (feed_hash, route_id) references public.tripshot_gtfs_routes(feed_hash, route_id),
    foreign key (feed_hash, shape_id) references public.tripshot_gtfs_shapes(feed_hash, shape_id)
);

create index tripshot_gtfs_trips_shape_idx
    on public.tripshot_gtfs_trips (feed_hash, shape_id) where shape_id is not null;

alter table public.tripshot_static_feeds enable row level security;
alter table public.tripshot_gtfs_routes enable row level security;
alter table public.tripshot_gtfs_stops enable row level security;
alter table public.tripshot_gtfs_shapes enable row level security;
alter table public.tripshot_gtfs_trips enable row level security;

revoke all on table public.tripshot_static_feeds, public.tripshot_gtfs_routes,
    public.tripshot_gtfs_stops, public.tripshot_gtfs_shapes, public.tripshot_gtfs_trips
    from anon, authenticated;

grant select, insert, update, delete on table public.tripshot_static_feeds,
    public.tripshot_gtfs_routes, public.tripshot_gtfs_stops, public.tripshot_gtfs_shapes,
    public.tripshot_gtfs_trips to service_role;

do $$
begin
    if exists (select 1 from pg_roles where rolname = 'scarlet_runtime') then
        grant select, insert, update, delete on table public.tripshot_static_feeds,
            public.tripshot_gtfs_routes, public.tripshot_gtfs_stops, public.tripshot_gtfs_shapes,
            public.tripshot_gtfs_trips to scarlet_runtime;
        create policy server_role on public.tripshot_static_feeds to scarlet_runtime using (true) with check (true);
        create policy server_role on public.tripshot_gtfs_routes to scarlet_runtime using (true) with check (true);
        create policy server_role on public.tripshot_gtfs_stops to scarlet_runtime using (true) with check (true);
        create policy server_role on public.tripshot_gtfs_shapes to scarlet_runtime using (true) with check (true);
        create policy server_role on public.tripshot_gtfs_trips to scarlet_runtime using (true) with check (true);
    end if;
end
$$;

comment on table public.tripshot_static_feeds is 'Server-only, versioned cache metadata for the TripShot static GTFS feed.';
comment on table public.tripshot_gtfs_shapes is 'Server-only cached GTFS route geometry. Browser clients never query this table directly.';
