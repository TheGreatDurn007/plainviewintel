-- Abuse-proof rate limiting for the public X-Ray API (/api/xray).
-- Per-IP, hourly bucket. The route fails OPEN until this table exists, so running this
-- turns the cap ON; until then the API still works (just uncapped). Run once in Supabase.

create table if not exists public.xray_rate_limits (
  key        text primary key,          -- "<ip>|<yyyy-mm-ddTHH>"
  count      integer not null default 0,
  updated_at timestamptz not null default now()
);

-- Lock it down: only the service role (the server) may read/write. With RLS enabled and
-- no policies, anon and authenticated clients are denied — the counter can't be tampered with.
alter table public.xray_rate_limits enable row level security;

-- Optional housekeeping: drop rows older than a day so the table stays tiny.
-- (Safe to skip; rows are tiny. Run manually or schedule if desired.)
-- delete from public.xray_rate_limits where updated_at < now() - interval '1 day';
