-- Allow the 14-minute check interval.
-- The original create_monitors_tables.sql omitted 14 from the interval_minutes
-- CHECK, while shared/schemas.ts ALLOWED_INTERVALS includes it. Add a new
-- migration (rather than editing the already-applied one) that replaces the
-- constraint.
--
-- Strategy (idempotent / safe to re-run):
--  1. Drop the existing interval_minutes CHECK only if it does not already
--     allow 14 (i.e. it is the old inline constraint that would reject 14).
--  2. Add monitors_interval_minutes_check (fixed name) with 14 included,
--     unless it already exists.

do $$
declare
  c record;
begin
  -- Drop any interval_minutes CHECK that rejects 14 (allow 14 to be added).
  for c in
    select conname, pg_get_constraintdef(oid) as def
    from pg_constraint
    where conrelid = 'public.monitors'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%interval_minutes%'
  loop
    if lower(c.def) not like '%14%' then
      execute 'alter table public.monitors drop constraint ' || quote_ident(c.conname);
    end if;
  end loop;
end;
$$;

-- Add the fixed-named constraint with 14 enabled (skip if it already exists).
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.monitors'::regclass
      and conname = 'monitors_interval_minutes_check'
  ) then
    alter table public.monitors
      add constraint monitors_interval_minutes_check
      check (interval_minutes in (10, 14, 15, 20, 30, 45, 60));
  end if;
end;
$$;
