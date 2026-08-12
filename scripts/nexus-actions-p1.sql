-- ════════════════════════════════════════════════════════════════════════════════════════════
-- NEXUS Actions P1 — the BEHAVIORAL ledger ("what you actually did")
-- ════════════════════════════════════════════════════════════════════════════════════════════
-- Additive to NEXUS Memory P1 (nexus-memory-p1.sql). The missing fourth stream:
--   Thesis (belief) → Prediction (claim) → ACTION (what you did) → Outcome (right + right-reason)
--
--   • nexus_actions — one row per book change (opened / added / trimmed / closed), AUTO-CAPTURED by
--     diffing the user's positions (shares + avg). Each row stamps the LIVE PRICE at detection plus a
--     SNAPSHOT OF BELIEF at that instant (thesis text, thesis-check verdict, NEXUS strength, buy-zone
--     state) — that snapshot is what lets NEXUS later grade BEHAVIOR vs conviction, not just outcome.
--
-- The action FACTS are set once (Tier-1 evidence — the user demonstrably did it). The only mutable
-- field is `why` — the user's intent, added later via one tap (non-blocking). PER-USER PRIVATE: actions
-- are decisions, never the global hive mind. Spec: repo ACTION-LOG.md.
-- Idempotent / re-runnable. Apply: Supabase → SQL Editor → paste → Run. UNWIRED until the app writes to it.
-- ════════════════════════════════════════════════════════════════════════════════════════════

create extension if not exists pgcrypto;

create table if not exists nexus_actions (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null default auth.uid(),
  ticker          text not null,                       -- canonical symbol (as held)
  name            text,                                -- display name at the time
  action_type     text not null check (action_type in ('opened','added','trimmed','closed')),
  shares_delta    numeric,                             -- signed change in share count
  shares_after    numeric,                             -- resulting shares (0 for closed)
  avg_before      numeric,                             -- average cost before
  avg_after       numeric,                             -- average cost after (distinguishes averaging up/down)
  price_at        numeric,                             -- live price at detection (~execution mark)
  currency        text,                                -- native currency (USD / CAD / ...)
  from_watchlist  boolean not null default false,      -- opened a name that was on the watchlist (the hinge)
  -- ── belief snapshot at the moment of the act (what makes grading possible) ──
  thesis_text     text,
  thesis_verdict  text,                                -- supported | mixed | contradicted | unsupported | null
  nexus_strength  numeric,                             -- NEXUS thesis-strength score at the time (0-10)
  zone_state      text,                                -- in | out | null (buy-zone state)
  -- ── user intent (added later, nullable) ──
  why             text check (why is null or why in ('take_profit','thesis_changed','better_opportunity','rebalance','stop_hit','fomo','not_a_trade')),
  why_at          timestamptz,
  occurred_at     timestamptz not null default now(),  -- when the change was detected
  created_at      timestamptz not null default now()
);

-- ── Indexes ─────────────────────────────────────────────────────────────────────────────────
create index if not exists idx_nexus_actions_user_time   on nexus_actions (user_id, occurred_at desc);  -- the timeline
create index if not exists idx_nexus_actions_user_ticker on nexus_actions (user_id, ticker, occurred_at desc);
create index if not exists idx_nexus_actions_unlabeled   on nexus_actions (user_id) where why is null;   -- the "label your moves" nudge

-- ── RLS: owner-only. INSERT + SELECT, plus UPDATE restricted to labeling `why` (facts stay set-once
--    by app convention; only the intent tag is added after the fact). ──────────────────────────────
alter table nexus_actions enable row level security;
drop policy if exists nexus_actions_sel on nexus_actions;
drop policy if exists nexus_actions_ins on nexus_actions;
drop policy if exists nexus_actions_upd on nexus_actions;
create policy nexus_actions_sel on nexus_actions for select to authenticated using (auth.uid() = user_id);
create policy nexus_actions_ins on nexus_actions for insert to authenticated with check (auth.uid() = user_id);
create policy nexus_actions_upd on nexus_actions for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
-- ════════════════════════════════════════════════════════════════════════════════════════════
