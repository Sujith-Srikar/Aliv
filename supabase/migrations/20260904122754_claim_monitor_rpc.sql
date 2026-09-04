-- §4 Atomic claim: replace the SELECT-then-conditional-UPDATE worker pattern with a
-- single atomic statement.
--
-- claim_monitor(p_id) atomically claims a monitor iff it is still claimable
-- (not paused, due, and not currently leased). If it returns a row, the caller
-- owns the lease and should run the check + persist. If it returns zero rows,
-- the monitor was already claimed, paused, no longer due, or deleted — the
-- caller treats it as a no-op.
--
-- Lease sizing deliberately mirrors the previous application logic
-- (timeout_seconds + 30s), computed in SQL from the row's own timeout so it
-- can never ask a stale value.
create or replace function public.claim_monitor(p_id uuid)
returns setof public.monitors
language sql
as $$
  update public.monitors
  set check_started_at = now(),
      check_lease_until = now() + (timeout_seconds + 30) * interval '1 second'
  where id = p_id
    and is_paused = false
    and next_check_at <= now()
    and (check_lease_until is null or check_lease_until < now())
  returning *;
$$;
