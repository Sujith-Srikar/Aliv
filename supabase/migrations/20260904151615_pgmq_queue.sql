-- V1-Plan 3: Queue check work through pgmq instead of a serial SELECT loop.
--
-- Splits the previous single "find due + claim + check" job into:
--   1. A scheduler (every minute, cheap): enqueue due monitor ids into pgmq.
--   2. A consumer (check-monitors Edge Function, every minute): drain the
--      queue in concurrent batches, claim atomically, check, ack.
--
-- The scheduler intentionally does NOT claim/lease. A still-leased row that
-- gets re-enqueued is rejected as a no-op by claim_monitor (V1-Plan 4), so no
-- extra dedupe bookkeeping is needed here.

create extension if not exists pgmq;

-- Queue (guarded create; pgmq.create errors on an existing queue).
do $$ begin
  if to_regclass('pgmq.monitor_checks') is null then
    perform pgmq.create('monitor_checks');
  end if;
end $$;

-- Scheduler: find due monitors and enqueue their ids, nothing else.
create or replace function public.enqueue_due_monitors()
returns void
language sql
as $$
  select pgmq.send_batch(
    'monitor_checks',
    array(
      select jsonb_build_object('monitor_id', id)
      from monitors
      where is_paused = false
        and next_check_at <= now()
      order by next_check_at asc
      limit 500
    )
  );
$$;

-- Consumer RPC wrappers so the Edge Function can reach pgmq via PostgREST
-- (the pgmq schema is not exposed by default).
create or replace function public.read_monitor_checks(p_qty integer)
returns table (msg_id bigint, message jsonb)
language sql
as $$
  select r.msg_id, r.message
  from pgmq.read('monitor_checks', 90, p_qty) r;
$$;

create or replace function public.delete_monitor_check(p_msg_id bigint)
returns boolean
language sql
as $$
  select pgmq.delete('monitor_checks', p_msg_id);
$$;

-- Scheduler cron: enqueue due monitors every minute.
select
  cron.unschedule(jobid)
from cron.job
where jobname = 'enqueue-due-monitors';

select
  cron.schedule(
    'enqueue-due-monitors',
    '* * * * *',
    $$ select public.enqueue_due_monitors(); $$
  );

-- Consumer cron: invoke the check-monitors Edge Function every minute instead
-- of every 10 minutes (pg_cron granularity is per-minute; the consumer drains
-- the queue in bounded concurrent batches each tick). The previous migration
-- scheduled this job under the name 'check-monitors' at */10 -- retire it.
select
  cron.unschedule(jobid)
from cron.job
where jobname in ('check-monitors', 'check-monitors-consumer');

select
  cron.schedule(
    'check-monitors-consumer',
    '* * * * *',
    $$
    select
      net.http_post(
        url := 'https://ahqicxezwyenwksbigzh.supabase.co/functions/v1/check-monitors',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer ' || (
            select decrypted_secret
            from vault.decrypted_secrets
            where name = 'worker_secret'
          )
        ),
        body := '{}'::jsonb,
        timeout_milliseconds := 60000
      ) as request_id;
    $$
  );
