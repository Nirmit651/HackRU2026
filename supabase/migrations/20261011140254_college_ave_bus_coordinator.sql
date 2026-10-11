-- Minute-scale coordinator only.  It does not poll TripShot or run an HTTP
-- loop: the deployed worker claims the leased job and performs that work.
create schema if not exists private;

create or replace function private.enqueue_college_ave_bus_coordinator()
returns void
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  insert into public.automation_jobs (
    id, "environmentId", key, kind, payload, "runAt", status, attempts,
    "createdAt", "updatedAt"
  )
  select gen_random_uuid(), e.id, 'college-ave-coordinator', 'COORDINATE_BUS',
    jsonb_build_object('source', 'supabase-cron'), clock_timestamp(), 'PENDING', 0,
    clock_timestamp(), clock_timestamp()
  from public.environments e
  where e.kind = 'LIVE'
  on conflict ("environmentId", key) do update
    set status = 'PENDING', "runAt" = clock_timestamp(), attempts = 0,
        "leaseToken" = null, "leaseUntil" = null, "lastError" = null,
        "updatedAt" = clock_timestamp()
    where automation_jobs.status <> 'PROCESSING'
       or automation_jobs."leaseUntil" < clock_timestamp();
end;
$$;

revoke all on function private.enqueue_college_ave_bus_coordinator() from public, anon, authenticated;
grant execute on function private.enqueue_college_ave_bus_coordinator() to postgres, service_role;

-- Enable pg_cron in the Supabase Dashboard before applying this migration.
-- The conditional form keeps local/test databases usable without the extension.
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    execute $cron$select cron.unschedule(jobid) from cron.job
      where jobname = 'college-ave-bus-coordinator'$cron$;
    execute $cron$select cron.schedule(
      'college-ave-bus-coordinator', '* * * * *',
      'select private.enqueue_college_ave_bus_coordinator()'
    )$cron$;
  end if;
end
$$;

comment on function private.enqueue_college_ave_bus_coordinator() is
  'Supabase Cron minute coordinator. Enqueues at most one leased College Avenue bus job per live environment; a separately deployed worker performs all TripShot I/O.';
