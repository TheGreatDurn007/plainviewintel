# One Knowledge System — Infinite Tickers

_A single accumulated understanding that every surface queries for a different purpose. A ticker is a **view into** the knowledge, not a silo that owns it (eventually Tesla informs Rivian, dilution patterns transfer across names). "One Brain Per Ticker" is the **principle**; this is the operating system._

> Principle: **shared FACTS → shared HISTORY → shared PATTERNS → surface JUDGMENT → private DECISIONS.** Surfaces must never disagree on a fact; they reach different *conclusions* (a thesis verdict ≠ a timing call ≠ a portfolio review) — like one analyst writing different reports from one understanding. General-product capability — any user, any ticker — never a hand-tuned response for one holding.

## 0. The five layers (the north star — keep these DISTINCT)

The whole value is that conclusions stay **traceable** back through history and facts instead of being a black-box answer. Never let a higher layer contaminate a lower one (the Evidence Hierarchy law).

| Layer | What it is | Memory type | Mutability |
|---|---|---|---|
| **Facts** | what happened — price, filing, fundamentals, an observation on a date | Global Facts | **immutable** observations |
| **History** | how facts evolved — the ordered series of observations | derived from Facts | recomputed |
| **Patterns** | what *usually* happens — mined from many outcomes across users/time | Learned Patterns (shared) | statistical, regenerated |
| **Reasoning** | what it means — every thesis, verdict, confidence, outcome, mistake | Reasoning Ledger | append-only |
| **Decision** | what to do — for *this* user, *their* basis & rules | Private | per-user |

**Four memories, not two:** ① Global Facts (everyone) · ② Personal History (mine) · ③ Learned Patterns (shared, from thousands of outcomes) · ④ Reasoning Ledger (every thesis→outcome). Don't merge them.

**Trajectory is NOT a memory — it's derived Evidence.** Store immutable daily *observations*; trajectory = `difference(observations)`, recomputed forever. (Corrects an earlier framing where trajectory was treated as the memory.)

## Build doctrine — bottom-up, because each layer is gated on the one below

The grand layers (Patterns, forecasting-from-precedent, cross-ticker transfer) are the highest long-term payoff **but cannot be built yet**: they require months of logged observations + graded outcomes across many users — data that does not exist today. You cannot mine *"RKLB theses fail because people overestimate launch cadence"* from zero outcomes. **So the Observation Log (Slice 1) is not the destination — it is the foundation every higher layer stands on, and building it now is what makes Patterns/forecasting possible later with zero new data collection.** Build the floors before the penthouse.

---

## 1. Where we are (2026-06-18)

| Layer | State |
|---|---|
| Per-ticker GLOBAL memory `_ticker_memory/{T}.json` (business, sector, SEC signals, risk flags, catalysts, last brief) | ✅ exists, but **only `/api/intel` reads/writes it** — the other 4 surfaces are amnesiac |
| Output caches (thesis-check 24h, portfolio-review 24h, X-Ray SEC, radar) | ✅ exist — cache the *answer* for cost; do **not** accumulate a time series |
| NEXUS ledger (thesis snapshots → evaluations) | 🟡 partial — tracks *thesis* evolution, not *price/drawdown* path |

**The gap this spec closes:** the platform caches **facts** but does not remember **trajectory**. Concrete symptom: the portfolio review calls AMC "your biggest loss position (−59%)" and stops — even though the drawdown narrowed from −70%, the stock is +100% over 3 months, and volume is rising. The review is **stateless** (it gets today's snapshot, nothing remembers yesterday), and its prompt is told to lead with "biggest loser **by P/L%**" — a point-in-time framing with no direction.

---

## 2. The model — the Observation Log (Facts layer) + derived Trajectory (Evidence)

Slice 1 builds the **Facts** and **History** layers only. Store immutable daily *observations*; derive trajectory from them. Split along the global-vs-private line (market data = global hive mind; cost-basis P&L = private).

### 2a. GLOBAL market trajectory (per ticker, no user id)
Appended to `_ticker_memory/{T}.json` as a daily series. One snapshot per calendar day (dedup by date), written by whichever daily sweep first touches the ticker. Deterministic, $0, no AI.

**Retention = roll up, never hard-discard.** Keep raw daily observations for a recent window (~90d), then **summarize older history into monthly roll-ups** (range, key events, dilution/earnings markers) rather than deleting it — adaptive by activity, so a Tesla keeps years of summarized history and a dormant micro-cap stays tiny. Throwing away old observations throws away the precedent the Patterns layer will need.

```
trajectory: [
  { d:"2026-06-18", price, volX, ret1mo, ret3mo, rsi, ma50Rel:"above|below", ma200Rel:"above|below", xrayScore },
  …
]
```
Every user viewing that ticker benefits — this is the hive mind.

### 2b. PRIVATE position trajectory (per user)
Per held position, a daily P&L-on-cost-basis point (private — cost basis is personal). Stored per-user (extend the saved state or a `_pos-traj/{user}.json`).

```
positionTrajectory: { AMC: [ {d:"2026-06-18", pnlPct:-59.0}, … ] }
```

### Capture hook
The daily sweep (`sweepUserTheses` / `/api/cron/daily-brief`) already runs once per user per day and re-scores holdings — add `recordTrajectorySnapshot()` there: write the global market snap (dedup by date) + the user's per-position P&L point. Cheap, idempotent.

---

## 3. Derived signals (computed at read time, deterministic)

From 2a + 2b, compute and expose via the shared context — these are **Tier-1 facts** (computed, not AI), so they're admissible evidence (see Evidence Hierarchy):

- **`drawdownTrend`** — narrowing / widening / flat (compare latest pnlPct to ~30d ago; carry the numbers, e.g. "−70% → −59%").
- **`momentum`** — ret1mo, ret3mo (persisted with history now).
- **`volumeTrend`** — rising / falling (volX slope over ~10d).
- **`trendStructure`** — above/below 50 & 200 MA, 50-vs-200 cross.
- **`situation` (the 2×2)** — a deterministic label combining drawdown direction × momentum:
  - narrowing + strong → **recovering**
  - widening + weak → **bleeding**
  - narrowing + weak → **stabilizing**
  - flat → **range-bound**

---

## 4. The objectivity invariant (the anti-yes-man guardrail)

Trajectory must cut **both** ways, or it becomes a momentum-cheerleader. Hard rules, enforced in the prompt and checkable:

1. A loser is never described by its static P&L alone — it carries its **situation** label + the numbers.
2. A **recovering** position is still flagged if it is overbought / has dilution or a contradicted thesis. (AMC: "recovery is real, the entry isn't — RSI 75, active ATM dilution.")
3. An **extended winner** (e.g. +100% / +120%) is never called "safe" — extension and missing take-profit are surfaced.
4. The label must trace to **computed numbers**; the AI may interpret them but never invent a different trajectory.

This rescues every assessment from both **false doom** (static −59%) and **false hope** (chasing a bounce) — the discipline-not-FOMO doctrine applied to context.

---

## 5. Assessment changes (what the user sees)

- **Portfolio review** — sentence 1 reframed: name the biggest loser by P/L% **and its `situation` + trajectory numbers** (drawdown narrowing/widening, 1mo/3mo momentum, volume/trend), with the §4 guardrail. "Biggest winner" likewise carries extension/risk.
- **Brief / Decide / Intel** — consume the same derived signals from the shared context, so a ticker's trajectory reads identically everywhere (no cross-surface contradiction).

---

## 6. Build slices — bottom-up (each gated on the layer below accumulating data)

- **Slice 0 — `buildTickerContext`** (shared fetch feeding all surfaces). _Prereq; small._
- **Slice 1 — Observation Log + derived Trajectory (THIS spec → Facts + History):** capture (2a/2b) → derived signals (§3) → portfolio-review reframing (§5) + the §4 objectivity invariant. **Highest visible value + it's the foundation; builds the substrate everything above needs.**
- **Slice 2 — Shared context across surfaces:** migrate Thesis + Brief + Decide to read one `buildTickerContext` (kills the 4.0-vs-5.0 cross-surface score split).
- **Slice 3 — Reasoning Ledger capture (Reasoning):** every surface writes its verdict/confidence/outcome back (extends the existing NEXUS Memory v1 / P1 outcome-grader — **already on the roadmap**). This is what later makes "was the thesis right?" answerable.
- **Slice 4 — Learned Patterns (Patterns) — GATED on data:** once Slices 1+3 have logged months of observations + graded outcomes across enough users, mine deterministic statistics ("companies with X+Y+Z historically…", "RKLB theses that cited backlog beat those that cited launch cadence"). **Statistics, not ML, not LLM-invented** — traceable to the ledger. _Do not start until the tables are non-trivially populated; building it over an empty ledger is wasted work._
- **Slice 5 — Forecasting-from-precedent + cross-ticker transfer (the penthouse):** expectations from history ("this management raises then beats"; dilution patterns transfer Tesla→Rivian). Highest payoff, furthest out, fully gated on Slice 4.

_North star: every surface — Portfolio Review, Intel, Decide, Opportunity Cost, The Ledger, X-Ray — becomes a **query into the same accumulated understanding**, not an isolated tool._

---

## 7. Acceptance tests (falsifiable)

- Position −70% → −59% with +100% 3mo → review says **"largest drawdown but recovering (−70%→−59%, +100% 3mo, rising volume)"**, not just "biggest loser." AND still flags overbought/dilution.
- Position −10% → −40% (widening) → review says **"deteriorating / bleeding,"** not "down 40%."
- +120% runner, overbought, no take-profit → review flags **extension + missing take-profit** despite the gain.
- Re-run same day → identical snapshots (deterministic, like the X-Ray score determinism the accuracy harness verified).

---

## 8. Non-goals
- Not predicting price — only describing the path.
- Not changing the X-Ray score (the growth/profitability de-saturation is a separate scoring track).
- Not a per-user hack — global market path + per-user drawdown, works for any user/ticker.

_Related: project memory `project_one_brain`, `feedback_global_vs_private_memory`, `reference_nexus_evidence_hierarchy`, `feedback_two_tier_intelligence`. Repo: `PIPELINE.md`._
