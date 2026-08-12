create extension if not exists "pgcrypto";

create table if not exists public.portfolios (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null default 'Plainview',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.positions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  portfolio_id uuid references public.portfolios(id) on delete cascade,
  asset_type text not null default 'stock' check (asset_type in ('stock','crypto')),
  ticker text not null,
  name text,
  exchange text,
  currency text not null default 'USD',
  coin_gecko_id text,
  shares numeric not null default 0,
  average_cost numeric not null default 0,
  current_price numeric not null default 0,
  status text,
  catalyst text,
  thesis text,
  exit_rule text,
  why_over_btc text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.watchlist (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  asset_type text not null default 'stock' check (asset_type in ('stock','crypto')),
  ticker text not null,
  name text,
  currency text not null default 'USD',
  coin_gecko_id text,
  current_price numeric not null default 0,
  entry_target numeric,
  analyst_target numeric,
  bull_target numeric,
  catalyst text,
  thesis text,
  why_not_bought text,
  why_over_btc text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.catalysts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  ticker text,
  title text not null,
  description text,
  event_date date,
  source text not null default 'manual',
  severity text not null default 'watch' check (severity in ('good','watch','bad')),
  dismissed boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists public.rules (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  body text not null,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.intel_briefs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  ticker text not null,
  input_hash text not null,
  brief text not null,
  created_at timestamptz not null default now()
);

alter table public.portfolios enable row level security;
alter table public.positions enable row level security;
alter table public.watchlist enable row level security;
alter table public.catalysts enable row level security;
alter table public.rules enable row level security;
alter table public.intel_briefs enable row level security;

create policy "portfolios own rows" on public.portfolios for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "positions own rows" on public.positions for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "watchlist own rows" on public.watchlist for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "catalysts own rows" on public.catalysts for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "rules own rows" on public.rules for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "intel own rows" on public.intel_briefs for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Shared SEC fundamentals cache — server-side only, no RLS needed
create table if not exists public.xray_cache (
  symbol text primary key,
  data jsonb not null,
  fetched_at timestamptz not null default now()
);

-- Curated radar universes — server-side only (service role), no RLS needed. Optional: the radar
-- ships with in-code defaults and only uses this table when it exists AND has rows. Seed/edit here
-- to override or extend the scanned universes without a redeploy.
create table if not exists public.radar_universes (
  slug text primary key,
  label text not null,
  tickers text[] not null default '{}',
  updated_at timestamptz not null default now()
);

-- Seed (matches the in-code defaults; edit freely):
insert into public.radar_universes (slug, label, tickers) values
  ('junior-miners',    'Junior gold/silver',          array['NG','THM','GORO','MUX','USAS','GATO','MAG','SVM','EXK','AG']),
  ('clinical-biotech', 'Clinical-stage biotech',      array['VKTX','CRVS','RXRX','ANAB','CRNX','RVMD','KYMR','NUVL','ARWR','SAVA']),
  ('quantum-ai',       'Quantum / AI small-caps',     array['IONQ','RGTI','QBTS','QUBT','ARQQ','LAES','QSI','BBAI','SOUN','AEVA']),
  ('uranium-critical', 'Uranium / critical minerals', array['UEC','DNN','UUUU','NXE','URG','LEU','MP','TMC','UROY','EU'])
on conflict (slug) do nothing;
