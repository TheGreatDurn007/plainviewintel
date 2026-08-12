-- ════════════════════════════════════════════════════════════════════════════════════════════
-- NEXUS Memory v1 — immutable, sourced, trust-tiered ledger  (v3 — nexus_ namespaced)
-- ════════════════════════════════════════════════════════════════════════════════════════════
-- All tables are prefixed `nexus_` so they can NEVER collide with existing app tables (the v2
-- attempt collided with an existing `catalysts` table). New + additive; touches nothing existing.
-- Idempotent (IF NOT EXISTS / re-runnable). Apply: Supabase → SQL Editor → paste → Run (and enable RLS).
--
-- DESIGN (reviewed for 10k users / 5yr):
-- • PER-TABLE IMMUTABILITY via RLS: the true ledgers (nexus_thesis_snapshots, nexus_signal_observations,
--   nexus_thesis_evaluations) are INSERT+SELECT only — history can't be rewritten. Tables that legitimately
--   evolve (nexus_catalysts upcoming→occurred; nexus_contradictions acknowledged) get +UPDATE, still no DELETE.
-- • TICKER MUST BE THE CANONICAL RESOLVED SYMBOL (resolveResearchSymbol output, e.g. TRX.TO) or history fragments.
-- • nexus_signal_observations is high-volume: app inserts ONLY when a signal's value CHANGES; numeric_value is
--   broken out for fast aggregation; at scale, partition by month on observed_at + prune/downsample >~24mo.
-- • SERVER writes (service role, no auth.uid()) MUST set user_id explicitly; service-role writes bypass RLS,
--   so app code is trusted to honor append-only on the ledger tables (RLS protects END USERS from rewriting).
-- ════════════════════════════════════════════════════════════════════════════════════════════

create extension if not exists pgcrypto;

-- Safe cleanup of any NON-prefixed tables a previous (v2) partial run created — ONLY drop them if they
-- exist AND are empty, so we can never destroy a pre-existing table that holds data (e.g. your `catalysts`).
do $$
declare t text; cnt bigint;
begin
  foreach t in array array['thesis_snapshots','signal_observations','thesis_evaluations','contradictions'] loop
    if exists (select 1 from information_schema.tables where table_schema='public' and table_name=t) then
      execute format('select count(*) from %I', t) into cnt;
      if cnt = 0 then execute format('drop table %I cascade', t); end if;
    end if;
  end loop;
end $$;

-- Trust tier per the Evidence Hierarchy (lower = higher authority).
do $$ begin
  if not exists (select 1 from pg_type where typname = 'nexus_trust_tier') then
    create type nexus_trust_tier as enum ('authoritative', 'derived', 'ai_interpretation', 'historical');
  end if;
end $$;

-- ── 1. nexus_thesis_snapshots — decision memory (IMMUTABLE; re-writing a thesis = a NEW row) ────
create table if not exists nexus_thesis_snapshots (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null default auth.uid(),
  ticker        text not null,
  thesis_text   text not null,
  catalyst_text text,
  conviction    numeric check (conviction is null or (conviction >= 0 and conviction <= 10)),
  entry_price   numeric,
  risks         jsonb not null default '[]'::jsonb,
  created_at    timestamptz not null default now()
);

-- ── 2. nexus_signal_observations — append-only fact ledger (WRITTEN BY gatherSignals; IMMUTABLE) ─
create table if not exists nexus_signal_observations (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null default auth.uid(),
  ticker        text not null,
  signal_type   text not null,
  numeric_value numeric,
  value         jsonb not null,
  source        text not null,
  trust_tier    nexus_trust_tier not null default 'authoritative',
  as_of         date,
  observed_at   timestamptz not null default now()
);

-- ── 3. nexus_thesis_evaluations — append-only verdict history (WRITTEN BY thesis-check; IMMUTABLE) ─
create table if not exists nexus_thesis_evaluations (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null default auth.uid(),
  thesis_snapshot_id uuid references nexus_thesis_snapshots(id) on delete cascade,
  ticker             text not null,
  status             text not null check (status in ('supported','mixed','contradicted','unsupported','insufficient')),
  strength_score     numeric check (strength_score is null or (strength_score >= 0 and strength_score <= 10)),
  points             jsonb not null default '[]'::jsonb,
  summary            text,
  engine_version     text,
  trust_tier         nexus_trust_tier not null default 'derived',
  evaluated_at       timestamptz not null default now()
);

-- ── 4. nexus_contradictions — Contradiction Engine output (UPDATABLE: acknowledged flag) ────────
create table if not exists nexus_contradictions (
  id                      uuid primary key default gen_random_uuid(),
  user_id                 uuid not null default auth.uid(),
  thesis_snapshot_id      uuid references nexus_thesis_snapshots(id) on delete cascade,
  ticker                  text not null,
  claim                   text not null,
  contradicting_signal_id uuid references nexus_signal_observations(id) on delete set null,
  severity                text check (severity is null or severity in ('low','medium','high')),
  explanation             text,
  detected_at             timestamptz not null default now(),
  acknowledged            boolean not null default false,
  updated_at              timestamptz not null default now()
);

-- ── 5. nexus_catalysts — tracked events + outcomes (UPDATABLE: status/outcome over time) ────────
create table if not exists nexus_catalysts (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null default auth.uid(),
  thesis_snapshot_id uuid references nexus_thesis_snapshots(id) on delete cascade,
  ticker             text not null,
  description        text not null,
  fiscal_period      text,
  expected_date      date,
  status             text not null default 'upcoming' check (status in ('upcoming','occurred','missed')),
  outcome            jsonb,
  source             text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

-- ── Indexes ─────────────────────────────────────────────────────────────────────────────────
create index if not exists idx_nexus_snapshots_user_ticker on nexus_thesis_snapshots (user_id, ticker, created_at desc);
create index if not exists idx_nexus_signal_user_ticker     on nexus_signal_observations (user_id, ticker, signal_type, observed_at desc);
create index if not exists idx_nexus_evals_snapshot         on nexus_thesis_evaluations (thesis_snapshot_id, evaluated_at desc);
create index if not exists idx_nexus_evals_user_ticker      on nexus_thesis_evaluations (user_id, ticker, evaluated_at desc);
create index if not exists idx_nexus_contradictions_user    on nexus_contradictions (user_id, ticker, detected_at desc);
create index if not exists idx_nexus_catalysts_user_ticker  on nexus_catalysts (user_id, ticker, expected_date);

-- ── RLS: owner-only, per-table immutability ────────────────────────────────────────────────────
-- IMMUTABLE ledgers: INSERT + SELECT only.
do $$
declare t text;
begin
  foreach t in array array['nexus_thesis_snapshots','nexus_signal_observations','nexus_thesis_evaluations'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists %I on %I', t||'_sel', t);
    execute format('drop policy if exists %I on %I', t||'_ins', t);
    execute format('create policy %I on %I for select to authenticated using (auth.uid() = user_id)', t||'_sel', t);
    execute format('create policy %I on %I for insert to authenticated with check (auth.uid() = user_id)', t||'_ins', t);
  end loop;
end $$;

-- EVOLVING tables: INSERT + SELECT + UPDATE (no delete).
do $$
declare t text;
begin
  foreach t in array array['nexus_contradictions','nexus_catalysts'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists %I on %I', t||'_sel', t);
    execute format('drop policy if exists %I on %I', t||'_ins', t);
    execute format('drop policy if exists %I on %I', t||'_upd', t);
    execute format('create policy %I on %I for select to authenticated using (auth.uid() = user_id)', t||'_sel', t);
    execute format('create policy %I on %I for insert to authenticated with check (auth.uid() = user_id)', t||'_ins', t);
    execute format('create policy %I on %I for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id)', t||'_upd', t);
  end loop;
end $$;
-- ════════════════════════════════════════════════════════════════════════════════════════════
