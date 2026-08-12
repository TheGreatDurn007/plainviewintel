-- ════════════════════════════════════════════════════════════════════════════════════════════
-- NEXUS Memory v1 — convert nexus_signal_observations to the GLOBAL HIVE-MIND model
-- ════════════════════════════════════════════════════════════════════════════════════════════
-- Facts are the same for everyone (TSLA's revenue/filings don't differ by user), so the FACTS ledger
-- must be SHARED — keyed by TICKER, not user. One observation serves all users; the more anyone
-- researches a ticker, the richer its timeline for everyone (the network-effect-on-truth).
--
-- The four PRIVATE tables (nexus_thesis_snapshots / _evaluations / _contradictions / _catalysts) are
-- UNCHANGED — beliefs and decisions stay per-user, RLS-isolated.
--
-- SAFE: only test rows exist (caught at 3 rows). Apply: Supabase → SQL Editor → paste → Run.
-- ════════════════════════════════════════════════════════════════════════════════════════════

-- Drop the per-user table + recreate global. CASCADE removes the dependent FK on nexus_contradictions
-- (the column stays; we re-add the FK below).
drop table if exists nexus_signal_observations cascade;

create table nexus_signal_observations (
  id            uuid primary key default gen_random_uuid(),
  ticker        text not null,            -- canonical resolved symbol — the SHARED key (NO user_id)
  signal_type   text not null,
  numeric_value numeric,
  value         jsonb not null,
  source        text not null,
  trust_tier    nexus_trust_tier not null default 'authoritative',
  as_of         date,
  observed_at   timestamptz not null default now()
);
create index if not exists idx_nexus_signal_ticker on nexus_signal_observations (ticker, signal_type, observed_at desc);

-- RLS — SHARED FACTS, TAMPER-PROOF:
--   • authenticated users may READ ALL (the hive mind)
--   • NO insert/update/delete policy for clients → users can NEVER write or alter the facts
--   • writes happen ONLY server-side via the service role (which bypasses RLS)
alter table nexus_signal_observations enable row level security;
drop policy if exists nexus_signal_read on nexus_signal_observations;
create policy nexus_signal_read on nexus_signal_observations
  for select to authenticated using (true);

-- Re-add the contradiction → signal link (a contradiction can point at the global fact that triggered it).
alter table nexus_contradictions
  drop constraint if exists nexus_contradictions_signal_fk;
alter table nexus_contradictions
  add constraint nexus_contradictions_signal_fk
  foreign key (contradicting_signal_id) references nexus_signal_observations(id) on delete set null;
-- ════════════════════════════════════════════════════════════════════════════════════════════
