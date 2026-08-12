-- ════════════════════════════════════════════════════════════════════════════════════════════
-- NEXUS Memory P1 — the outcome & accuracy spine ("was I right?")
-- ════════════════════════════════════════════════════════════════════════════════════════════
-- Additive to NEXUS Memory v1 (nexus-memory-v1.sql). Two new IMMUTABLE, owner-RLS, nexus_-prefixed
-- tables that turn the ledger from "what you believed" into "and whether you were right":
--
--   • nexus_predictions — a FALSIFIABLE forward claim, born when you commit to a trade (Decide) or
--     write a thesis. metric + direction + threshold + horizon_date make it gradeable, not vibes.
--     IMMUTABLE: a prediction is a commitment; changing your mind = a NEW prediction, never an edit.
--
--   • nexus_outcomes — the GRADE, appended when the horizon arrives. Graded DETERMINISTICALLY against
--     admissible facts only (Tier-1 / corroborated per the trust gate, lib/trust-classify.ts); if the
--     deciding fact isn't admissible, grade = 'unresolved' — never a guessed hit/miss. evidence_signal_ids
--     records WHICH facts graded it (provenance). lesson_text is AI prose → trust_tier 'ai_interpretation'
--     (stored, shown, but it can NEVER itself become evidence — the Evidence Hierarchy, enforced by tier).
--
-- This is what powers: "Your Edge" scorecard, hit-rate by style, the Decide co-pilot ("your hit rate on
-- setups like this is 1-for-4"), and the proof that justifies the paid tiers. Reuses nexus_trust_tier.
-- Idempotent / re-runnable. Apply: Supabase → SQL Editor → paste → Run. UNWIRED until the app writes to it.
-- ════════════════════════════════════════════════════════════════════════════════════════════

create extension if not exists pgcrypto;

-- ── 1. nexus_predictions — the falsifiable forward claim (IMMUTABLE; INSERT + SELECT only) ───────
create table if not exists nexus_predictions (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null default auth.uid(),
  ticker             text not null,                       -- canonical resolved symbol (resolveResearchSymbol)
  thesis_snapshot_id uuid references nexus_thesis_snapshots(id) on delete set null,
  metric             text not null,                       -- what's predicted: price | revenue_growth | gross_margin | catalyst | ...
  direction          text not null check (direction in ('above','below','reaches','occurs','avoids')),
  threshold          numeric,                             -- the target value (null for a pure event prediction)
  horizon_date       date not null,                       -- by when it should be true (the deadline that makes it gradeable)
  basis_price        numeric,                             -- price at prediction time (context for grading a price call)
  rationale          text,                                -- short "why" (the thesis in one line)
  source             text not null default 'decide' check (source in ('decide','thesis','manual')),
  created_at         timestamptz not null default now()
);

-- ── 2. nexus_outcomes — the graded result (IMMUTABLE append-only; latest graded_at wins) ─────────
create table if not exists nexus_outcomes (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null default auth.uid(),
  prediction_id       uuid not null references nexus_predictions(id) on delete cascade,
  ticker              text not null,
  grade               text not null check (grade in ('hit','miss','partial','unresolved','cancelled')),
  actual_value        numeric,                            -- what actually happened (e.g. realized price at horizon)
  evidence_signal_ids jsonb not null default '[]'::jsonb, -- nexus_signal_observations ids that graded it (provenance)
  lesson_text         text,                               -- AI one-liner ("attendance grew, operating leverage didn't")
  trust_tier          nexus_trust_tier not null default 'derived', -- the deterministic grade is 'derived'; a lesson is 'ai_interpretation'
  graded_at           timestamptz not null default now()
);

-- ── Indexes ─────────────────────────────────────────────────────────────────────────────────
create index if not exists idx_nexus_predictions_user_ticker on nexus_predictions (user_id, ticker, created_at desc);
create index if not exists idx_nexus_predictions_horizon      on nexus_predictions (horizon_date);                 -- grader: find predictions due
create index if not exists idx_nexus_predictions_snapshot     on nexus_predictions (thesis_snapshot_id);
create index if not exists idx_nexus_outcomes_prediction      on nexus_outcomes (prediction_id, graded_at desc);   -- latest grade per prediction
create index if not exists idx_nexus_outcomes_user_ticker     on nexus_outcomes (user_id, ticker, graded_at desc); -- hit-rate aggregates

-- ── RLS: owner-only, IMMUTABLE (INSERT + SELECT only — history can't be rewritten) ──────────────
do $$
declare t text;
begin
  foreach t in array array['nexus_predictions','nexus_outcomes'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists %I on %I', t||'_sel', t);
    execute format('drop policy if exists %I on %I', t||'_ins', t);
    execute format('create policy %I on %I for select to authenticated using (auth.uid() = user_id)', t||'_sel', t);
    execute format('create policy %I on %I for insert to authenticated with check (auth.uid() = user_id)', t||'_ins', t);
  end loop;
end $$;
-- ════════════════════════════════════════════════════════════════════════════════════════════
