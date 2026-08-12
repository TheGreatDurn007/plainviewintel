# Decision Log — Plainview

Decisions that should never be accidentally undone.

---

## 2026-06-08 - SEC Alert Memory TTL = 6 hours

Status: accepted
Decision: SEC alert memory TTL set to 6h (was 1h)
Reason: Reduces EDGAR API calls ~6x per day. New filings still detected within trading day.

---

## 2026-06-08 - Radar Cache Key = daily-v5

Status: accepted
Decision: Radar cache stored at `_radar/daily-v5.json` with 12h TTL
Reason: v5 introduced evidence-first ranking with Evidence Momentum Score

---

## 2026-06-08 - Evidence Momentum Score

Status: accepted
Decision: Deterministic integer score combining SEC signals + TA
Scoring: Form4 P=+3, Item 1.01=+2, SC13D=+2, news=+2, volume=+1, MA50=+1, dilution=-1, NT/bankruptcy=-3
Reason: Ranks hidden gems by evidence quality, not just price action

---

## 2026-06-08 - fetchFilingSnippet for Real SEC Text

Status: accepted
Decision: All 8-K, 10-K, 10-Q, 424B, S-3 filings fetch first 60KB via Range header and extract real prose
Reason: Show actual filing content in popups instead of generic labels
Files: src/lib/market-context.ts

---

## 2026-06-08 - 10-K/10-Q Alert Gate = 7 days

Status: accepted
Decision: 10-K and 10-Q only trigger alerts if filed within last 7 days
Reason: Prevents every portfolio ticker having a permanent dot from old quarterlies

---

## 2026-06-08 - Mobile SEC Dot = 56px Touch Target

Status: accepted
Decision: .sec-dot on mobile is 56x56px transparent element with 7px visual dot as ::before
Reason: Reliable touch targeting — e.target IS .sec-dot so closest() always matches
Also: Document touchstart handler has 30px proximity check as additional layer

---

## 2026-06-08 - AI_QUOTA_ENABLED stays DORMANT

Status: accepted
Decision: Quota/billing logic exists in code but is never enabled
Reason: Owner is not charging users. "We are nowhere near charging people."

---

## 2026-06-08 - Single HTML File Architecture

Status: accepted
Decision: All UI, JS, CSS lives in one file: plainview-command-center.html
Reason: Established architecture — do not split into components without explicit owner request

---

## 2026-06-08 - Mobile Card Actions Pattern

Status: accepted
Decision: .card-actions-mobile hidden (opacity:0) until card tap, appears as overlay via position:absolute
Reason: Saves space on mobile, clean toggle UX
Note: .card-actions (desktop) uses position:absolute;top:10px;right:10px;z-index:2 — DO NOT CHANGE

---

## 2026-06-08 - Refresh Radar Removed

Status: accepted
Decision: "Refresh Radar" button removed. refreshIntelDesk() now calls loadGemRadar(true) automatically.
Reason: One button does everything — simpler UX
