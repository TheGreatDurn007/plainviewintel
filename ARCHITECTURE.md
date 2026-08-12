# Plainview — Architecture, verbalized

_How the system actually runs, in first-principles terms. Names below are verified against the code. Last updated 2026-06-10._

> Companion to [vision.md](vision.md). vision.md = **what** we're building. This = **how it runs**.
> Read both before building a feature. Plan and document first; build when the docs feel right.

---

## 1. Data layers (by origin → trust)

| Layer | Origin | In the code | Trust |
|---|---|---|---|
| **User-inputted** | declared by the user | `positions`, `watchlist`, thesis, exit rules (Supabase, private per account) | their truth, but subjective |
| **Auto-collected primary** | fetched first-hand | `gatherSignals()` → Yahoo (price) · SEC + FMP/AlphaVantage (fundamentals) · StockTwits (sentiment) | highest — sourced facts |
| **Analyzed & processed** | produced by the engine | `enrichXrayScan()` (derived) · `runAI()` (AI) · `rankAttention()` (scores) | derived = reproducible; AI = never evidence |

Rule (the Evidence Hierarchy): a layer may **read** the layers below it, but data is **never promoted upward** — AI output cannot become a "primary fact."

## 2. Actors

- **User** (human) — looks up, records a position/thesis, asks for a check.
- **Engine** (Next.js API routes, on request) — fetches, scores, judges, remembers.
- **Scheduled jobs** (cron — _not built yet_) — the morning market scan.
- **AI models** (Cerebras · Groq · Gemini · Claude) — a **tool** the engine calls via `runAI()`; their output is layer 3, never authoritative.

## 3. The verbalization chain

`actor › action › route/script › function › parameter › artifact › data-layer`

### Flow: pressure-test a thesis
**User** › _Check thesis vs facts_ › `POST /api/thesis-check`
→ `gatherSignals(ticker)` _(layer-2 facts)_
→ `runAI(prompt)` _(layer-3 draft verdict)_
→ `reconcileStatus(verdict)` _(guard: demotes unsupported claims)_
→ `recordThesisEvaluation(userId, …)` _(per-user memory)_ + `recordSignalObservations(ticker, …)` _(shared hive mind)_
› **artifact:** verdict (supported / weakening / contradicted) + strength score
› **writes:** layer-1 (eval, private) · layer-2 (signals, shared); the verdict is layer-3

### Flow: X-ray any ticker
**User** › types ticker, `scanXrayTicker()` › `GET /api/xray/[symbol]`
→ `resolveSearchSymbol()` _(canonical ticker)_
→ `fetchXray()` _(layer-2 primary)_
→ `enrichXrayScan()` _(layer-3 derived: margins, P/S, score)_
› **artifact:** scored X-Ray card

### Flow: rank what needs attention (the dashboard)
**User** › opens Dashboard › `renderDashboardHero()`
→ `loadNexusMemory()` → `GET /api/nexus-memory` _(reads per-user judgment)_
→ `rankAttention()` _(deterministic scorer over positions + signals + memory)_
› **artifact:** ranked "Needs attention" list _(layer-3 derived; no AI in the ranking)_

### Flow: morning market scan _(to build)_
**Scheduled job** › _run market scan_ › `scripts/morning-scan` (planned)
→ scan universe → `gatherSignals()` → detect overnight gaps → write a `picks` table
› **artifact:** today's picks / watching / candidates _(shared)_ — fuels the new-user homepage

## 4. Key routes & functions (verified)

- `src/app/route.ts` — serves the single-file UI (`plainview-command-center.html`)
- `src/app/api/prices` — live prices (Yahoo + cookie + throttle; no stale fallback)
- `src/app/api/thesis-check/route.ts` — `runAI()`, `reconcileStatus()`
- `src/app/api/xray/[symbol]/route.ts` — fundamentals scan
- `src/app/api/intel/route.ts` — skeptical brief
- `src/app/api/nexus-memory/route.ts` — reads per-user thesis judgment
- `src/app/api/opportunity-cost/route.ts` — _exists; partially built_
- `src/lib/market-context.ts` — `gatherSignals()`
- `src/lib/nexus-memory.ts` — `recordSignalObservations()`, `recordThesisEvaluation()`

## 5. Working agreement (the Architect's rule)

Tell the agent **what** to build, not **how**. Iterate on architecture + design docs (this file + vision.md) before writing code. Plan → document → agree → build. Avoid the "feature rampage" — every feature must name which data layer it consumes and which output it serves, or it doesn't belong.
