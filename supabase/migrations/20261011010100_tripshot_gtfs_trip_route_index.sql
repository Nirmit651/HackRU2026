create index tripshot_gtfs_trips_route_idx
    on public.tripshot_gtfs_trips (feed_hash, route_id);
