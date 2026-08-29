-- Enable extensions required to schedule Edge Function invocations.
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Periodic sweep: claim and check due monitors every 10 minutes by invoking the
-- check-monitors Edge Function. The function authenticates via a WORKER_SECRET
-- bearer token stored in Supabase Vault (key: worker_secret), never in code.
select
  cron.schedule(
    'check-monitors',
    '*/10 * * * *',
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
