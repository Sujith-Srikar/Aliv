create table public.users (
  id uuid primary key default gen_random_uuid(),
  username text not null unique check (username ~ '^[a-zA-Z0-9_-]{3,30}$'),
  created_at timestamptz not null default now()
);

create table public.monitors (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 80),
  url text not null check (url ~* '^https?://'),
  interval_minutes int not null default 10 check (interval_minutes in (10, 15, 20, 30, 45, 60)),
  timeout_seconds int not null default 10 check (timeout_seconds in (1, 5, 10, 15, 20, 30, 45, 60)),
  is_paused boolean not null default false,
  status text not null default 'DOWN' check (status in ('UP', 'DOWN')),
  response_time_ms int,
  last_checked_at timestamptz,
  last_error text,
  check_started_at timestamptz,
  check_lease_until timestamptz,
  next_check_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index monitors_user_id_idx on public.monitors (user_id);
create index monitors_due_idx on public.monitors (next_check_at) where is_paused = false;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger monitors_set_updated_at
before update on public.monitors
for each row execute function public.set_updated_at();
