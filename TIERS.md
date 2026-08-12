# Plainview — Tiers & Cost Logic

_How the plans map to what actually costs us money. Prices are **provisional** — we finalize them after the Founder Analytics dashboard tells us what an average active user costs and what feature drives retention. Last updated 2026-06-11._

---

## The principle

**Sell judgment and memory, not data.** Raw information stays generous; the paywall sits in front of the *thinking* (AI synthesis) and the *remembering* (NEXUS memory). This also happens to line up with cost: the free surfaces are exactly the ones that cost us ~$0 to serve.

## What costs us money

| Source | What drives the cost | Notes |
|---|---|---|
| **Anthropic (Claude Haiku 4.5)** | Every AI action — SEC summary, Intel brief, thesis-check, opportunity-cost, portfolio review, deep analyze | **The only meaningful per-call cost.** ~$0.005–0.01 per call (small prompts, capped outputs). |
| **Plaid / broker-wallet sync** | Per linked account | Only the Advanced tier. Future. |
| **Supabase / Vercel** | Storage, function executions, bandwidth | Negligible at current scale; text storage is cheap. |

**Free data sources (no per-call cost):** Yahoo Finance (quotes, screeners), SEC EDGAR, CoinGecko, StockTwits. X-Ray, market-movers, crypto, and quotes call **no LLM** — so the free tier's AI cost is **$0**.

**Cost controls already in place:**
- AI lives behind auth (anonymous users cannot burn tokens).
- Dormant per-user daily quota (`src/lib/ai-quota.ts`, flip `AI_QUOTA_ENABLED` at ~150 users).
- Global per-filing SEC summary cache (`src/lib/ai-cache.ts`): an immutable filing = **one** Anthropic call ever, shared across all users.

## Tiers

> Prices below are placeholders for discussion. Two candidate ladders are on the table — a $0 / $12 / $35 ladder (built into the Pricing tab) and ChatGPT's $0 / $9.99 / $19.99 ladder. **Decide after retention data, not before.**

### Free — "Know any stock in seconds."
The acquisition engine. Be generous — this is the funnel, and it costs ~$0 to run.
- **Unlimited** X-Ray scans + shareable snapshot cards
- Live public market lists (top movers, trending, candidates heatmap)
- News + raw SEC filing access
- Basic watchlist
- A small monthly allowance of AI actions (e.g. a handful of SEC summaries) so they taste the magic
- _Limits:_ no NEXUS memory/history, no opportunity-cost engine, capped AI

### Pro — "Know what matters in your portfolio." (core paid plan)
Everything free, plus the **thinking** and the **remembering** — this is where Anthropic cost lives, and where the value lives.
- Unlimited AI: Intel briefs, SEC summaries, thesis-check (Decide), deep analyze
- **Opportunity Cost engine** (the differentiator — "where does my next dollar go?")
- NEXUS memory: thesis tracking, contradiction detection, thesis-evolution history
- Unlimited watchlist + portfolio
- Cost to serve: dominated by Anthropic, ~$0.60/active user/month → very high margin at any sane price.

### Advanced — "Your whole book, synced." (scale / power users)
Everything in Pro, plus connected accounts and scale.
- Broker / wallet **sync** (Plaid) — auto-import positions
- Morning Brief, weekly intelligence reports, NEXUS ranking engine
- Higher limits for heavy users
- Cost to serve: Pro's AI cost **+ per-connection Plaid cost** → priced to cover that.

## The order of operations

1. **Instrument** (done — Founder Analytics dashboard). Learn what an average user costs and what they keep coming back to.
2. **Gate** AI behind Pro once usage justifies it (the quota plumbing is ready).
3. **Price** based on the real cost-per-active-user number — not a guess between $9.99 and $15.

See [vision.md](vision.md) for positioning and the funnel.
