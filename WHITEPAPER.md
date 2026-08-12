# Plainview — Master White Paper

*The single source of truth. Vision at the top, architecture and money underneath, and the way we build at the bottom. If you ever feel lost, start here.*

---

## 0. The one sentence

**Plainview is a conviction engine with a memory.** It turns your holdings and the market's *facts* into grounded judgment — and it remembers your theses, so over time you learn whether you're actually good at this.

It sells **judgment + memory.** Not data (commoditized), not advice (regulated and risky). Not a robo-advisor. Not a Bloomberg terminal.

---

## 1. Who it's for

Self-directed retail investors who **hold convictions and want them tested** — not signal-chasers, not pure index-and-forget. People who research before they buy, who have a *thesis*, and who want something to keep them honest about it over time. The kind of person who currently has a thesis in their head, a position in their brokerage, and no system connecting the two.

---

## 2. The problem (why this should exist)

- **Generic LLMs hallucinate and forget you.** ChatGPT gives a confident answer with no grounding and no memory of your portfolio or your reasoning.
- **Data terminals overwhelm and never judge.** They hand you 400 numbers and zero opinion about whether your thesis holds.
- **Finfluencers and robo-advisors are the two bad extremes** — hype with no accountability, or genericized "just buy the index" with no conviction.
- **Nobody holds you accountable to your own reasoning.** You make a call, the market moves, and there's no ledger of *why you bought* and *whether you were right*.

Plainview sits in the gap: grounded, opinionated, and it remembers.

---

## 3. The moat — MEMORY, not analysis

This is the most important page. **Analysis is commoditizing** — every LLM can summarize a 10-K. What *cannot* be copied is **your own decision history and whether each thesis was right.**

- **NEXUS is not a feature — it's the company.** The daily thesis sweep, the "was it right?" scoring, the conviction ledger. The longer someone uses Plainview, the more it knows *how they think* and *whether they're any good at it.*
- That track record is a **compounding, un-clonable asset.** A competitor can clone the X-Ray scanner in a weekend. They cannot clone three years of *your* graded convictions.
- So the product orients around one idea: **your conviction track record that compounds.** Everything else (scanning, buy zones, stress-tests) is in service of feeding and grading that ledger.

> **The strategic test for any feature:** does it make the memory richer or the judgment sharper? If not, it's a distraction.

---

## 4. The principle — "Credible by construction"

In an age of confidently-hallucinating AI, Plainview's brand is **"never confidently wrong."** This is enforced architecturally, not by hoping the AI behaves:

- **Two-layer intelligence.** A free *deterministic* layer (the "consciousness") + a paid *judgment* layer.
- **The deterministic layer is the credibility.** Plausibility invariants ("a buy price can't exceed the market price"), confluence ("a level is trustworthy when multiple methods agree"), cross-source validation. These run on every ticker, for free, and **cannot hallucinate.**
- **It would rather say "N/A" than lie.** Insufficient data → "—", not a fake 5.0. A collapsed stock → "below support, thesis call" not an invented buy zone.
- **Evidence hierarchy (permanent law):** Tier-1 facts > AI output. AI output may be stored and referenced, but it **never becomes evidence** — that prevents the circular self-poisoning where the model cites its own past guess as fact.

This is a *defensible position*. Most fintech-AI is the opposite — fluent and wrong.

---

## 5. The product surfaces

| Surface | What it does | Tier |
|---|---|---|
| **X-Ray** | Scan any stock/ETF/crypto → business-quality score, accurate SEC-backed fundamentals, the credible buy zone, head-to-head compare, shareable snapshots | Free (the funnel) |
| **Decide** | Buy zone + market context + thesis stress-test for a specific trade | Free zone / **Pro** stress-test |
| **Portfolio + Watchlist** | Track your holdings & hunt list, each with a thesis and catalysts | **Pro** |
| **Thesis stress-test** | Paste your reasoning → red-team / blue-team it against the facts | **Pro** (Sonnet) |
| **NEXUS** | Daily thesis sweep, the Brief, "was it right?" scoring, contradiction alerts, the memory ledger | **Pro** (the moat) |
| **Dashboard** | The cockpit — one ranked "needs attention" list across your convictions | **Pro** |

The free/paid line, in one rule: **analyzing *any ticker* is free; tracking *your convictions* — with AI judgment and memory — is paid.**

---

## 6. The intelligence architecture

Intelligence is split by cost, and the free layer does most of the work:

- **Free / deterministic — the "consciousness."** Invariants, confluence, volume-by-price support, cross-source agreement. $0, every ticker, no hallucination. *This is most of what makes Plainview credible.*
- **Free LLMs** (Cerebras → Groq → Gemini): bulk prose — summaries, gem blurbs, narratives. ~$0.
- **Sonnet 4.6** (`claude-sonnet-4-6`): the *thesis verdict* only — genuine reasoning (the "Chapter 11 wipes the equity" caliber call). ~$0.03/check, cached 24h, temp-0 → max one paid call per user/ticker/day.
- **Opus 4.8** (`claude-opus-4-8`): the hardest flagged calls (Pro+). Rare.

**Controls:** a `SMART_MODEL` env knob (default free → $0 today; flip to Sonnet at launch), per-user `AI_DAILY_LIMIT` + `AI_QUOTA_ENABLED`, 24h verdict cache. The expensive intelligence is bounded and rare; the credibility layer is free.

---

## 7. The data / evidence hierarchy

Correctness comes from *where* data is sourced and *how* it's validated, not from one provider:

1. **Tier-1 — source of truth:** SEC EDGAR (US fundamentals — the actual filings), the exchange/Yahoo-chart (price), CoinGecko (crypto). These *are* the data.
2. **Tier-2 — aggregators:** Yahoo enriched, Finnhub, Alpha Vantage. Broad coverage (foreign, analyst data) but second-hand → can lag or misparse.
3. **Tier-3 — scraped / computed:** stockanalysis.com (short interest), our own computed beta/confluence.

**Rules:** prefer the highest tier available per field; cross-check across sources and distrust the outlier; enforce plausibility invariants before anything reaches a card; one ticker = one verified company. **Caching by data velocity:** price ~30s, technicals ~2h, fundamentals/SEC ~12h — so load scales with *unique tickers*, not user count. (Server-side note: Yahoo's crumb-gated fields are blocked from datacenter IPs, so SEC is the reliable backbone for US fundamentals.)

---

## 8. Monetization — the value ladder

**Willingness to pay in stocks scales with money at stake, not feature count.** Nobody pays for more screens; they pay for a tool that helped them catch one setup or cut one loss. One good call pays for years. So the tiers ladder by *how close you are to the money:*

- **Free — analyze.** X-Ray any ticker. No money at stake yet → the acquisition funnel.
- **Pro ($10–25) — judge your convictions.** Your money's in it: portfolio/watchlist + NEXUS daily judgment, thesis verdicts, contradiction alerts, the memory.
- **Advanced ($100, *earned*) — the edge engine.** NEXUS in *every* money decision: Decide co-pilot (red-team a buy, size it, set the exit), TA setups (confluence entries, gem setups), Opportunity-Cost judgment (where the next dollar goes), loss-prevention alerts (get out before −40%), the proactive agent, Opus-grade judgment.

**No claims, ever — proof instead.** We never promise returns (and legally must not). Value is shown with the user's OWN data: *"setups you acted on: +X% · breaks you heeded: avoided −Y%."* Their track record, not our claim — self-evident value, zero regulatory exposure. The memory/scorecard (P1) is the machine that produces this proof.

**You earn the price, you don't set it.** The north-star metric is **dollars helped / losses prevented per active user.** Instrument it; let the proof justify $100. Do not build or market Advanced before that proof loop exists.

- **Rail: Whop** (Merchant of Record — tax/compliance/cancellation; checkout links at the gates; webhook → tier in Supabase). Provider-agnostic — only the link + webhook are Whop-specific.
- **Cost is safe:** free deterministic + free-LLM layers = $0; only the paid verdict touches Sonnet (~$0.50–1/user/mo, quota-capped). The Admin **NEXUS Judgment Engine** toggle flips Free↔Sonnet↔Opus live — an instant cost kill-switch.

---

## 9. The growth loop

**X-Ray snapshots are the engine.** Every shared snapshot is a branded ad:

```
scan a ticker (free)  →  share the snapshot  →  someone else scans  →  they sign up
        →  they track a thesis (Pro)  →  NEXUS keeps them honest  →  they stay  →  they pay
```

Free scanning is the *acquisition*; the conviction engine + memory is the *retention*. Virality at the top, the moat at the bottom.

---

## 10. The road to marketable — three gates, each with a written "done"

"Done" feels unknowable because of **scope creep** — every good idea (Sonnet, insider intel, the edge engine) raises the ceiling, so the finish line keeps moving. The cure: a **scope freeze per gate** and an explicit definition of done. **You market at Gate 1 — which is small and close — not when the whole vision is built.** This section is the single source of truth for progression; "done is done" = the checklist is empty.

**Gate 1 — LAUNCH-READY (this is "marketable"). Scope FROZEN here.** Done when:
- [ ] X-Ray accurate across stocks / ETFs / crypto incl. **pre-revenue** (the score/label fix); mobile clean; share card works
- [ ] Core paid loop runs end-to-end, **zero embarrassing bugs**: add position → thesis → NEXUS daily judgment → "what changed" → right more than wrong
- [ ] Onboarding delivers a **first-session "aha"** on a stock they actually hold
- [ ] Whop checkout works; the launch flip tested
- [ ] Stress-test punch-list = **0 open**
- *Status ~80%:* facts trustworthy (figure guard, trust gate), Sonnet wired + Admin toggle, gem insider intel, stale-value fixed. **Remaining: pre-rev score · mobile pass · onboarding aha · punch-list to zero.**

**Gate 2 — MONETIZE (flip paid on).** Done when:
- [ ] **Retention proven** (e.g. ≥X% of signups create a thesis / return 3+ times over N weeks)
- [ ] **P1 live** — the track-record ledger accumulating (the proof seed)
- [ ] Pricing CTAs + gating tested end-to-end

**Gate 3 — PREMIUM ($100 edge engine).** Done when:
- [ ] **"Dollars helped / losses prevented" instrumented and positive** (the north-star metric)
- [ ] NEXUS spans every money decision — Opportunity-Cost judgment, Decide co-pilot, TA setups, loss alerts — on Sonnet/Opus
- [ ] **Proactive alerts** (NEXUS comes to you) + a user-facing **"Your Edge" scorecard** (their realized results)
- [ ] **Shareable WIN cards** — outcome virality, the user's own results, no claims by us

The agent future lives inside Gate 3: **v2 proactive NEXUS** that pings you when a thesis breaks (*"your AMC thesis was just contradicted by today's 8-K"*) + broker sync; **v3 the personal investing OS** that knows your style, track record, and blind spots. The wedge across all of it: **"ChatGPT gives you a confident answer and forgets you exist. Plainview grounds the facts, red-teams your reasoning, and keeps the receipts."**

---

## 11. How we build — the design-before-code ritual

No feature goes to Claude Code until this one-pager is filled. It's the difference between features that *work* and features that feel *right*.

1. **Job** — what user problem, why it matters now. (One sentence. If you can't, it's not ready.)
2. **Data layer** — which sources feed it, and the **Tier-1 source of truth** (§7). What's the evidence.
3. **Intelligence** — what's *free/deterministic* (invariants, confluence) vs *paid judgment* (Sonnet/Opus). **Default to free.** Only spend AI where genuine reasoning is required.
4. **Surface** — where it lives, what the user sees, which **tier** (Free/Pro/Pro+).
5. **Invariants & failure modes** — what must *never* happen; the self-checks that keep it credible-by-construction.
6. **Cost** — $0 / Sonnet / Opus, and the expected volume.
7. **The ask to Claude Code** — *WHAT, not HOW.* Describe the outcome and the constraints; let the implementation be derived.

Get those seven right and the code is almost mechanical — and you stop shipping things that work but feel wrong.

---

## 12. The north star, restated

Plainview is not "AI for stocks." It's the **edge engine** between a person and their money decisions — grounded so it's credible, opinionated so it's useful, remembering so it compounds, and **measured by dollars helped and losses prevented.** It earns more than $10–25 by working on the dollars themselves, and it proves its worth with the user's own track record, never a claim. Build everything toward the memory and the judgment; price it off the proof. Everything else is a feeder.
