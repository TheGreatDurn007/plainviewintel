-- ════════════════════════════════════════════════════════════════════════════════
-- Filing Insights — structured facts extracted from SEC 10-K / 10-Q / 8-K filings
-- ════════════════════════════════════════════════════════════════════════════════
-- Stores the output of the Filing Reader (Sonnet extraction): management quotes,
-- KPIs, risk disclosures, guidance, sensitivity formulas — everything thesis-check
-- needs to grade a user's thesis against filing evidence. Global (per-ticker, no
-- user_id) because filed facts are the same for everyone. Trust tier is always
-- "authoritative" (Tier-1) — this IS the primary source.
--
-- Apply: Supabase → SQL Editor → paste → Run.
-- ════════════════════════════════════════════════════════════════════════════════

create table if not exists filing_insights (
  id            uuid primary key default gen_random_uuid(),
  ticker        text not null,
  filing_type   text not null,            -- 10-K, 10-Q, 8-K, 8-K/A, etc.
  filing_date   date not null,
  accession     text not null,            -- EDGAR accession number (dedup key)
  category      text not null,            -- revenue, margins, cash_flow, debt, guidance, risk, mgmt_quote, sensitivity, litigation, segment, capital_allocation, outlook
  fact          text not null,            -- the extracted fact in plain English
  numeric_value double precision,         -- parsed number (nullable — not all facts are numeric)
  quote         text,                     -- verbatim management quote from the filing (nullable)
  source_section text,                    -- where in the filing this came from (e.g. "MD&A")
  created_at    timestamptz not null default now()
);

-- Fast lookups: latest insights per ticker, and dedup by accession
create index if not exists idx_fi_ticker_date on filing_insights (ticker, filing_date desc);
create unique index if not exists idx_fi_accession_category on filing_insights (accession, category, fact);

-- RLS: public read, service-role write (same pattern as nexus_signal_observations)
alter table filing_insights enable row level security;
drop policy if exists "filing_insights_select" on filing_insights;
create policy "filing_insights_select" on filing_insights for select using (true);
-- Service-role writes bypass RLS automatically; no insert policy needed for end users.

comment on table filing_insights is 'Structured facts extracted from SEC filings by the Filing Reader. Tier-1 evidence for NEXUS thesis evaluation.';
