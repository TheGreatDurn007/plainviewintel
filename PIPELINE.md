# Plainview — Pipeline & Night QA Log

_Living backlog + objective QA notes. Started 2026-06-17 (end-of-night review). Newest section on top._

---

## 2026-06-17 — Decisions made tonight

- **Scoring engine: LEAVE AS-IS for now.** We discussed unifying the adaptive rubric (pre-revenue "Speculative grade" vs "Business Quality"). Owner's call: don't risk breaking a load-bearing, unit-tested engine at night over one wart. The inversion below is logged as a **known issue, decision pending** — not to be touched without explicit go-ahead.
- **Hive-mind ticker context = #1 PRIORITY.** Owner, verbatim: _"this is where I want the hive mind having ticker context 100%… the AI needs to be learning."_ The "One Brain Per Ticker" initiative is the headline of the roadmap. Spec was paused mid-write; resume on owner's go.

---

## TOP PRIORITY — "One Brain Per Ticker" (the learning hive mind)

**Problem (confirmed by audit tonight):** the 5 AI surfaces don't share one source of truth, and only 1 of 5 contributes to the ticker's accumulated memory.

| Surface | Canonical facts (`gatherSignals`) | Reads ticker memory | Writes ticker memory | Smart tier |
|---|---|---|---|---|
| Thesis (Decide) | ✅ | ✅ | ✅ | ✅ |
| Intel / Brief | ✅ | ✅ | ✅ | ✅ |
| Opportunity Cost | ✅ | ✅ | ✅ | ✅ |
| Narrative | N/A (receives pre-built data) | N/A | N/A | ✅ |

**The build — COMPLETE (2026-06-20):**
1. ✅ `buildTickerContext(ticker, {price?})` + `gatherSignals` — canonical signal bundle.
2. ✅ Thesis + Brief migrated to `gatherSignals`.
3. ✅ Opportunity Cost migrated (replaced own `gather()` with `gatherSignals` + signal block + ticker memory).
4. ✅ Every surface writes back to GLOBAL `_ticker_memory/{TICKER}.json` — thesis verdict (`lastVerdict`/`lastVerdictSummary`), opp-cost lean+read, Intel brief summary, X-Ray snapshot. 24h TTL, labeled as AI context (never Tier-1 evidence).
5. ✅ Deterministic signal labels (`signal-labels.ts`: `buildSignalBlock` = financial standing + price action + score trend) injected by all surfaces — the "grounding preamble" through architecture, not prompts.
6. ✅ Decide (thesis-check) already on smart tier (`getJudgmentModel()`).
   Narrative is N/A — receives pre-built data from the client, no per-ticker fetching.

**Principle to encode:** shared FACTS + shared MEMORY, surface-specific JUDGMENT. Surfaces must never disagree on a fact; they SHOULD reach different conclusions (verdict ≠ timing ≠ summary). Don't mis-build "consistent" into "identical."

---

## KNOWN ISSUES (from tonight's objective scoring audit)

Pulled live `/api/xray/{TICKER}` across the spectrum. Ranked:

```
9.0  SPY    (ETF)
8.7  NVDA   profitability:10 balanceSheet:6 growth:9.5
8.4  AAPL   profitability:10 balanceSheet:6 growth:8.5
8.4  MSFT   profitability:10 balanceSheet:6 growth:8.5
8.2  GME    profitability:8.5 balanceSheet:7.5 growth:8.5   ← suspect
7.8  TSLA   profitability:8.5 balanceSheet:6 growth:8.5
7.5  KO     profitability:10 balanceSheet:3 growth:8.5       ← balance-sheet harsh
5.4  SLS    (prerev) Survival:10 Balance:6.7 Validation:10   ← outranks AMC/SMR
4.9  ARAAF  (prerev)
4.9  TMQ    (prerev)
4.0  AMC    profitability:2 balanceSheet:2 growth:8.5
4.0  SMR    profitability:2 balanceSheet:7.5 growth:3        ← classified "stock", not prerev
```

1. **Spec-outranks-real inversion** _(decision: pending — leave for now)._ SLS (pre-rev biotech, $0 rev) **5.4** > AMC (real, $5B rev) **4.0** and SMR **4.0**. Violates the engine's own stated rule ("never let a speculative pre-revenue name outrank a real company"). The 6.0 cap only stops spec beating a _good_ (≥7) company, not a weak one. Resolution discussed = "separate the axes" (one business-quality headline for all + survival as a separate labeled axis) — parked.
2. **GME 8.2 > Coca-Cola 7.5 and Tesla 7.8.** GameStop's `profitability:8.5` + `growth:8.5` look too generous for a declining-retail business whose profit is mostly interest income. Credibility flag — a casual user will not trust a system that ranks GME above KO.
3. **`growth: 8.5` saturation.** AAPL, MSFT, GME, TSLA, AMC, KO all land on _exactly_ 8.5. The growth component appears to clamp/default to 8.5 for most names → little discrimination. Investigate the growth sub-score curve.
4. **KO `balanceSheet: 3`.** Coca-Cola's balance sheet scored 3/10 (net-debt heavy) drags a blue chip to 7.5. The balance-sheet component may over-penalize investment-grade leverage (looks at net cash, ignores coverage / cash-flow servicing).
5. **Inconsistent speculative classification.** SMR (NuScale, early-stage) scored as a regular "stock" while SLS/ARAAF/TMQ are "prerev". The pre-rev classifier is uneven — same _kind_ of company, different rubric.
6. ~~**SSR SEO body still thin.**~~ **FIXED (2026-06-20):** SSR now fetches the canonical `/api/xray/{ticker}?bg=1` instead of the lite `runXray`. Googlebot sees the real score + full fundamentals + enriched meta description with live score+sector.
7. **"The read" wording nit.** The deterministic read says _"business quality X/10"_ even for speculative-kind tickers (SLS), conflicting with the card's "Speculative" label. Word it off `scoreKind`. (Tiny.)
8. **Crypto X-Ray is sparse.** BTC-USD returns score `NA` (no fundamentals). Acceptable, but the crypto card reads thin — consider a crypto-specific lens later.

---

## VERIFIED WORKING (tonight)

- **Deterministic "the read"** — accurate, clean, graceful with $0-revenue names; tested live on AMC / AAPL / SLS / TMQ. Reads well across stock, biotech, miner.
- **price-vs-MA consistency** (today's fix) — verified across 4 live tickers; "above 50 & 200 MA" / "below" now matches the deterministic trend everywhere.
- **SEC filings** — real, dated, fresh (AMC: 8-K 2026-06-11, Form 4, 8-K 2026-05-13).
- **Scoring for mega-caps** — sensible (NVDA 8.7, AAPL/MSFT 8.4, ETF SPY 9.0).
- **Public surfaces reachable** — `/api/xray/{T}` (JSON), `/api/sec-filings`, `/sitemap.xml`, `/robots.txt` all 200 logged-out. (`/api/prices`, `/api/quote`, `/api/intel` correctly 401.)
- **Catalysts cleanup** (today) — earnings-led, undated notes collapsed. _(Logic verified; live render needs a logged-in look.)_

---

## COULD NOT TEST (needs owner / a real account)

I can't create an account (prohibited action), so these auth-gated flows weren't tested end-to-end tonight — they need your eyes or a shared test session:

- **Plainview Brief** (`/api/intel`) — quality + the smart-tier wiring shipped today. _Flip NEXUS→Sonnet in Admin and regenerate AMC to feel it._
- **Thesis-check** verdicts — credibility, the contradiction gate.
- **Decide** + **Opportunity Cost** outputs.
- **Portfolio / Watchlist / Catalysts** live render (today's catalysts change).
- **Morning / Evening briefs** — the 8:00am & 6:30pm emails; watch the next sends for sane verdicts + narrative voice.

---

## IDEAS / IMPROVEMENTS (backlog)

- **Scoring (when revisited):** separate the axes — one Business-Quality headline for all + a clearly-labeled "Survival grade" sidecar for cash-burners. Fixes the inversion without flattening spec-name differentiation. (Full design discussed 2026-06-17.)
- **Scoring quality pass:** fix `growth` saturation (8.5 for everyone), revisit `balanceSheet` penalty for investment-grade debt, and the GME-over-KO outcome — these are the credibility-sappers a new user notices first.
- **Plainview Brief cache** — per-ticker 24h cache so running on Sonnet is cost-safe by default (X-Ray data barely moves intraday).
- **Catalysts:** add SEC-derived dated events (votes, deadlines); auto-decay stale undated watch notes (90d → "still watching?").
- **Scoring-lens disclosure in the compare view** — flag when two tickers are scored on different frameworks ("not directly comparable").

---

## INFRA / OPS BACKLOG
- **Email *receiving* (real inboxes) — Private-Email-SAFE setup.** Owner wants real mailboxes (you@plainviewintel.com) but Namecheap **Private Email** switches the domain's DNS to **cPanel**, which dropped the Vercel `A` record and took the **whole site down 2026-06-18** (see `reference_deploy_workflow` memory). DO NOT use Namecheap Private Email's cPanel DNS. Options: (a) keep BasicDNS + add receiving via a provider that uses plain MX/CNAME records you control in BasicDNS (e.g. a forwarding service or a mailbox host that gives MX records, not a DNS-type switch); (b) email forwarding only. **Hard rule: the domain stays on Namecheap BasicDNS; all records (Vercel A/CNAME + Resend send + any receive MX) managed there; never "Change DNS Type" to cPanel.**
- **DNS guard:** consider a tiny monitor that alerts if `plainviewintel.com` stops resolving to `76.76.21.21` (would have caught the outage instantly instead of via "I can't sign out").

## DOCTRINE REMINDERS (don't violate)

- Free tier = **$0 AI / no cost bomb**. Deterministic-first. Smart tier only on the owner's Admin toggle.
- **Never serve stale prices as live** (`/api/prices` is the sole source).
- **Evidence hierarchy:** AI output may be stored/referenced but never becomes a Tier-1 fact (prevents circular self-poisoning).
- Deploy: `npx vercel --prod --yes` ONLY. Parse-check inline HTML via `new Function()`.
- Owner controls all sends.
