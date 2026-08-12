-- NEXUS Conviction Ledger contract (NEXUS-THESIS.md §8) — additive columns on the existing
-- per-user evaluation ledger so every decision is recorded LEARNABLY:
--   • scorecard         — the deterministic Phase-1 scorecard (Evidence/Opposition/verdict) as jsonb
--   • critical_unknown  — the load-bearing unverified claim at evaluation time (§5)
--   • outcome_correct   — on resolution: did the thesis WORK? (result)
--   • reasoning_correct — on resolution: was the ARGUMENT sound, independent of the result? (process)
--   • resolved_at       — when the dual judgment was applied
-- Outcome-right ≠ reasoning-right (§8.1): the two are graded SEPARATELY so the ledger never rewards luck
-- or punishes variance. Safe to run multiple times (IF NOT EXISTS). No data migration; existing rows keep NULLs.

alter table if exists nexus_thesis_evaluations
  add column if not exists scorecard         jsonb,
  add column if not exists critical_unknown   text,
  add column if not exists outcome_correct    boolean,
  add column if not exists reasoning_correct  boolean,
  add column if not exists resolved_at        timestamptz;

-- Fast lookup of still-unresolved evaluations (for the grader that fills the dual judgment later).
create index if not exists idx_nexus_eval_unresolved
  on nexus_thesis_evaluations (ticker)
  where resolved_at is null;
