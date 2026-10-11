-- The coordinator function was deployed in the preceding migration. Enable the
-- managed scheduler here and make the named job idempotent across re-deploys.
create extension if not exists pg_cron;

select cron.unschedule(jobid)
from cron.job
where jobname = 'college-ave-bus-coordinator';

select cron.schedule(
  'college-ave-bus-coordinator',
  '* * * * *',
  'select private.enqueue_college_ave_bus_coordinator()'
);
