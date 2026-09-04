-- V1-Plan 8: enforce a hard per-user monitor cap at the DB layer so the
-- app-level count check in createMonitor cannot be raced by concurrent
-- inserts. Mirrors MAX_MONITORS_PER_USER in shared/monitor-limit.ts.

create or replace function public.monitors_check_user_cap()
returns trigger
language plpgsql
as $$
declare
  v_count integer;
begin
  select count(*) into v_count
  from monitors
  where user_id = new.user_id;

  if v_count >= 20 then
    raise exception 'user has reached the maximum number of monitors (20)'
      using errcode = 'P0001';
  end if;

  return new;
end;
$$;

create trigger monitors_check_user_cap
before insert on monitors
for each row
execute function public.monitors_check_user_cap();
