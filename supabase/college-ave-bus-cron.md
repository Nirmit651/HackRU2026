# College Avenue bus coordinator

Enable the `pg_cron` extension in the Supabase Dashboard before applying migration
`20261011140254_college_ave_bus_coordinator.sql`. The migration schedules
`college-ave-bus-coordinator` once per minute. Inspect it with:

```sql
select jobid, jobname, schedule, command from cron.job
where jobname = 'college-ave-bus-coordinator';
```

The cron job only writes one idempotent `COORDINATE_BUS` job per live
environment. It intentionally does **not** call TripShot or run a sub-minute
loop from Postgres.

Run the durable worker as a separate always-on process:

```sh
cd vite-project
npm run worker
```

The worker uses PostgreSQL advisory locks plus `FOR UPDATE SKIP LOCKED` job
leases. It selects one eligible TripShot arrival, then reschedules monitoring
according to persisted state: 60 seconds while far away, 15 seconds within
about three minutes, and 5 seconds while arriving/dwelling. This process must
run on a persistent worker host; a Vercel request or browser tab is not a
reliable worker runtime.

To remove the schedule:

```sql
select cron.unschedule(jobid) from cron.job
where jobname = 'college-ave-bus-coordinator';
```

Expected TripShot request volume is roughly 2 feed reads/minute while far away,
8/minute when approaching, and 24/minute while dwelling. The in-process
TripShot cache deduplicates concurrent worker work; browser map reads use the
persisted `BUS_MARKET_SNAPSHOT` state and never request TripShot.
