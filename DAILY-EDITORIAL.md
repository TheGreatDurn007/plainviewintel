# Daily Editorial — Product Spec

> Plainview's daily market email. General enough for every user, smart enough to feel personal.

## The Problem

The Ledger (weekly, personalized) only reaches active users who have positions. Non-active users get winback emails — but those are onboarding nudges, not value. There's no daily reason for anyone to open Plainview in their inbox.

StockTwits' Daily Rip proves the model: a short, opinionated market recap sent daily builds habit. But the Rip is hand-written editorial. Plainview's version should be **auto-generated from real data** with an editorial voice baked into the AI prompt — no human editor, no editorial bottleneck, $0 marginal cost.

## The Product

**"The Brief"** — a daily market email with two layers:

### Layer 1: The Editorial (everyone gets this)

Sent daily at ~5:30 PM ET (post-close). Same content for all recipients.

| Section | Source | Notes |
|---------|--------|-------|
| **Market Recap** (3-5 sentences) | S&P, Nasdaq, VIX, sector ETFs via `/api/prices` | AI-written with editorial voice. "What happened and why it matters." Not a data dump. |
| **Sector Scoreboard** | 11 SPDR sector ETFs (already in `MarketContext`) | Top 3 / Bottom 3, one-line each. Color-coded. |
| **What Moved & Why** | Top 5-8 market movers by volume × price change | Headlines via `fetchRecentNews`. Filtered for relevance (the HBAR fix). |
| **Earnings This Week** | Yahoo + Finnhub (existing `/api/earnings`) | Monday: full week ahead. Tue-Fri: today's reports + tomorrow preview. |
| **Economic Calendar** | New: free API source (see Data Sources below) | Same pattern: today's releases + tomorrow preview. |
| **One Thing to Watch** | AI-picked from the day's signals | The single most important thing going into tomorrow. Opinionated. |

### Layer 2: The Personal Insert (active users only)

Spliced into the middle of the editorial for users with positions/watchlist. ~3-4 lines max.

| Section | Source | Notes |
|---------|--------|-------|
| **Your Names Today** | User's holdings cross-referenced with day's movers | "TSLA -2.1% on the Fed reaction. AMC +4.9% on record attendance." Only tickers that moved ≥1%. |
| **Thesis Check** | Latest thesis evaluation status | "2 strengthening, 1 newly contradicted (KO)." One line. Links to dashboard. |

This replaces the need for a separate daily brief email — the editorial IS the daily brief, with a personal insert for active users.

## Voice & Tone

The editorial voice is Plainview's brand: **informed, direct, zero hype**.

Prompt guardrails:
- Facts first, opinion second. Every claim names its source (a number, a filing, a headline).
- No clickbait, no "you won't believe", no emoji spam. One emoji per section header max.
- Short sentences. Active voice. Present tense for today, past for this week.
- Acknowledge uncertainty ("the market read this as dovish — whether that holds depends on Friday's PCE").
- Never predict. Describe what happened, surface what's ahead, let the reader decide.
- When the day was boring, say so in one paragraph. Don't inflate nothing into something.

## Data Sources

### Already have:
- **Market indices**: S&P, Nasdaq, VIX via `^GSPC`, `^IXIC`, `^VIX` (prices API)
- **Sector performance**: 11 SPDR ETFs in `MarketContext.sectors`
- **News headlines**: `fetchRecentNews()` (Yahoo + Google News RSS) — now with crypto name fix
- **Earnings calendar**: Yahoo quoteSummary + Finnhub fallback
- **Email infra**: Resend, suppression list, unsubscribe, cron

### Need to add:
- **Economic calendar**: [Trading Economics free calendar](https://tradingeconomics.com/calendar) scrape, or Finnhub `/calendar/economic` (free tier). Lightweight — just event name + date + time + prior/forecast/actual.
- **Market movers (general)**: Top gainers/losers by volume. Yahoo Finance screener API or existing `/api/movers` route (already exists).
- **Oil / Bond / Gold**: Add `CL=F`, `GC=F`, `^TNX` to the MarketContext price fetch. Three extra symbols, no new API.

## Architecture

### Build order:

**Phase 1: Editorial engine (the content)**
1. Add `CL=F`, `GC=F`, `^TNX` to `fetchMarketContext()` in daily-brief.ts
2. Build `src/lib/daily-editorial.ts`:
   - `buildEditorial(market: MarketContext): Promise<{ subject, html, text }>`
   - Fetches: top movers (existing `/api/movers`), earnings this week, economic calendar
   - Assembles fact payload → AI narrative (Haiku, ~$0.003/call — one call for ALL users)
   - Returns email HTML using Plainview email template (same dark theme as Ledger)
3. Economic calendar: minimal fetcher, cached 1hr

**Phase 2: Personal insert**
4. `buildPersonalInsert(userId: string, market: MarketContext): Promise<string>`
   - Cross-references user holdings with day's movers
   - One-line thesis status summary
   - Returns HTML fragment spliced into the editorial

**Phase 3: Send logic**
5. New cron slot: `?slot=editorial` at 5:30 PM ET
   - Build editorial ONCE (same for everyone)
   - For each user: splice personal insert if they have holdings, otherwise send editorial-only
   - Respect suppression, unsubscribe, `LIVE_TO_ALL` gate
   - Non-active users get editorial-only (no personal insert, no AI cost per user)

**Phase 4: Blend into Ledger**
6. The weekly Ledger gets a "THIS WEEK IN MARKETS" section at the top — a condensed weekly editorial summary (Mon-Fri highlights) before diving into portfolio-specific analysis. Built from the same market data, just aggregated.

## Cost Model

| Component | Cost | Frequency |
|-----------|------|-----------|
| Editorial narrative (free AI cascade) | $0 | 1x/day (shared) |
| Personal insert (deterministic) | $0 | Per active user |
| Resend email | $0 (free tier: 3k/mo) then $20/mo | Per recipient |
| Market/earnings/econ data | $0 | All free APIs |

**AI cascade**: Cerebras → Groq → Gemini → Haiku (paid fallback, almost never hit). One call/day is well within every free tier. Same pattern used by thesis-check.

Total: **$0/day** until email volume exceeds Resend's 3k/mo free tier.

## Recipient Segmentation

| Segment | Gets | Frequency |
|---------|------|-----------|
| Active (has positions, used in 7d) | Editorial + Personal Insert | Daily |
| Warm (has account, used in 30d) | Editorial only | Daily |
| Lapsed (no activity 30d+) | Editorial only | 3x/week (Mon/Wed/Fri) — don't burn them out |
| New signup (< 3 days) | Welcome sequence first | Skip editorial until onboarding complete |
| Suppressed / unsubscribed | Nothing | — |

## Email Structure (HTML)

```
┌─────────────────────────────────────────┐
│  P  PLAINVIEW   THE BRIEF    Jun 21     │
├─────────────────────────────────────────┤
│                                         │
│  THE MARKET                             │
│  [3-5 sentence AI narrative]            │
│                                         │
│  S&P +1.1%  Nasdaq +1.9%  VIX 2        │
│  Oil $76 (+0.9%)  Gold $2,640  10Y 4.3% │
│                                         │
├─────────────────────────────────────────┤
│                                         │
│  ── YOUR NAMES TODAY ── (active only)   │
│  TSLA -2.1% · AMC +4.9% · BB -5.1%    │
│  2 strengthening · 1 contradicted       │
│  [View in Plainview →]                  │
│                                         │
├─────────────────────────────────────────┤
│                                         │
│  SECTORS                                │
│  ▲ Consumer Disc +3.0%  Tech +3.0%     │
│  ▼ Energy -1.5%  Financials -0.8%      │
│                                         │
│  WHAT MOVED                             │
│  NVDA +3.2% — Amazon custom chip deal   │
│  MRNA +5.1% — FDA flu-shot vote         │
│  HOOD +4.8% — layoffs + volume math     │
│                                         │
│  EARNINGS TOMORROW                      │
│  FDX (BMO) · KBH (AMC) · GIS (AMC)    │
│                                         │
│  ECONOMIC DATA TOMORROW                 │
│  PCE 8:30 AM · GDP 8:30 AM             │
│                                         │
│  ONE THING TO WATCH                     │
│  [Single opinionated paragraph]         │
│                                         │
├─────────────────────────────────────────┤
│  Investigate in Plainview →             │
│  [unsubscribe]                          │
└─────────────────────────────────────────┘
```

## What This Replaces

- **Daily Brief AM/PM**: Replaced by The Brief (editorial + personal insert). One email, better content.
- **Winback emails**: Lapsed users now get The Brief 3x/week — real value, not onboarding nudges. Winback becomes a fallback for users who haven't opened 5+ Briefs.
- **Ledger**: Stays weekly, but gains a "THIS WEEK IN MARKETS" editorial header.

## Success Metrics

- **Open rate**: Target 35%+ (industry avg for finance newsletters: 27%)
- **Click-through to Plainview**: Track "Investigate in Plainview →" clicks
- **Reactivation**: Lapsed users who return to dashboard within 7 days of first Brief
- **Retention**: Active users who stay active week-over-week (Brief as daily touchpoint)

## Not Doing (Yet)

- Human-written editorial (scale bottleneck, defeats the point)
- Curated "links that don't suck" section (requires editorial judgment we can't automate well)
- Per-user AI editorial (cost scales linearly — keep editorial shared)
- Weekend editions (markets closed, nothing to say)
- Push notifications (email first, prove the format, then consider)
