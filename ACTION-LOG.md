# ACTION-LOG — The Behavioral Ledger

_What the user actually **did** with their book — captured automatically, tagged with intent, graded against the thesis at the moment of the act. The behavioral spine of the Conviction Ledger. Companion to `NEXUS.md` (judgment vision) and `NEXUS-THESIS.md` (thesis law). Spec v1 — 2026-06-16._

---

## 0. Why this exists

NEXUS today records two things: **theses** (what you believe) and **predictions** (what you said would happen). It has **no record of what you actually did.** And behavior — not belief — is where discipline lives or dies.

> You can hold a perfect thesis and still sell the winner in a panic, or average into a thesis that's already breaking. The ledger can't see any of that today.

The Action Log closes the loop. It is the missing fourth stream:

```
Thesis (belief)  →  Prediction (claim)  →  ACTION (what you did)  →  Outcome (was it right + was the reasoning right)
```

It is also the hinge the rest of the product has been missing: it is **the event that connects Watchlist → Portfolio → Exit**. "Bought NOK from watchlist" simultaneously *resolves a watchlist entry-call* ("did waiting for my zone pay off?") and *opens a portfolio conviction-call* ("target Z by date"). Selling resolves the conviction-call. The action is the join.

### The one rule that makes it usable
**Zero manual bookkeeping.** The user already keeps their book current in Plainview (shares + average cost per position). The log is **derived by diffing that book**, not typed. The only thing a diff can't infer is *why* — and that's one optional tap.

---

## 1. What an Action IS

An action is an **immutable, sourced event** describing a change to the user's book:

```
Action = ⟨ ticker, type, sharesΔ, avgBefore→avgAfter, priceAtDetection, at, context, why? ⟩
```

| Field | Meaning |
|---|---|
| `type` | `opened` · `added` · `trimmed` · `closed` |
| `sharesΔ` | signed change in share count |
| `avg` | average cost before → after (distinguishes "added at a higher price" = averaging up) |
| `priceAtDetection` | live price when detected — the approximate execution mark |
| `context` | **snapshot of belief at the moment**: thesis text, thesis-check verdict, NEXUS strength score, buy-zone state. This is what makes grading possible. |
| `why` | one-tap intent (nullable): `take-profit · thesis changed · better opportunity · rebalance · stop hit · FOMO · correction (not a trade)` |

### Evidence tier
An action is a **Tier-1 fact** — the user demonstrably did it (derived deterministically from their own book). Per `NEXUS.md`'s evidence hierarchy, it is *evidence*, never AI output. It can be referenced and graded but is **never overwritten or invented**. Append-only.

### Privacy: PER-USER, PRIVATE
Actions are **decisions**, not facts about the world. Per the global-vs-private rule (facts = global hive mind; thesis/decisions = per-user isolated), the Action Log is stored **per `user_id` and never shared**. New table `nexus_actions`, mirroring the existing immutable-ledger pattern.

---

## 2. How it's captured (detection, not data entry)

A baseline "last-known book" snapshot is kept per user. On each book change:

1. **Diff** the current `positions[]` against the baseline (by canonical ticker).
2. Emit an event per changed holding:
   - present now / absent before → **opened**
   - shares ↑ → **added** (compare avg to label averaging up/down)
   - shares ↓ but > 0 → **trimmed**
   - absent now / shares → 0 → **closed**
3. Capture `priceAtDetection` + the **belief context** (thesis, verdict, strength, zone) at that instant.
4. Write the action with `why = null`.
5. **Update the baseline** so the same change is never re-detected.

### Invariants (the things that make it not-annoying)
- **Silent first run.** Initialize the baseline with no events — never emit "opened" for everything already held. (Same pattern as the buy-zone journal init.)
- **Shares/avg only.** A price move is *not* an action. Only share-count or average-cost changes trigger events.
- **Forgiving on corrections.** A typo-fix looks like a trade. We log it anyway, but `why` includes **"correction — not a trade"**, which drops it from grading. Never block, never nag.
- **Non-blocking.** The action is written immediately; the "why" is requested gently afterward (an "unlabeled moves" nudge on the Journal), **never** in the path of adding/editing a position.
- **Universal.** Pure book-diff logic — works for any user, any ticker, crypto/fractional included. No portfolio-specific assumptions.

---

## 3. What it produces (outputs / surfaces)

Per the doc-first rule — every feature names its data layer **and** its output. Data layer: `nexus_actions` (per-user, immutable). Outputs:

1. **The log** — a timeline on the Journal page:
   > _Jun 16 · Trimmed **SLS** 25% @ $7.59 · take-profit · thesis was **Strengthening** (+168%, Supported)_

2. **Behavioral grading — the moat.** NEXUS compares each action to the belief context at the time and surfaces discipline flags (deterministic rules first):
   - Sold while thesis **strengthening** → _"sold a winner early — plan or flinch?"_
   - Added while thesis **weakening/contradicted** → _"averaging into a breaking thesis."_
   - Bought **in buy zone + supported thesis** → _"disciplined entry."_
   This is "discipline, not FOMO" made literal — the highest-value coaching NEXUS can give.

3. **Loop closure for predictions.** A `buy` opens/affirms a prediction at the real entry price; a `sell`/`close` resolves the relevant call. Over time this **replaces thesis-check-born predictions** (the noisy ones) with **action-born** ones tied to real money — killing the duplicate problem at the source.

4. **"Your Edge" (future / Advanced tier).** Realized results computed from real actions: _"setups you acted on: +X% · exits you heeded: avoided −Y%."_ This is exactly the dollars-helped / loss-prevented instrumentation the monetization plan needs to justify the premium tier — and it can only exist on top of the Action Log.

---

## 4. Build sequence

| Phase | Scope | Cost / Tier |
|---|---|---|
| **1 — Capture (MVP)** | `nexus_actions` table · book-diff detection · silent baseline init · write actions · one-tap "why" · action timeline on Journal | Deterministic, **$0 / free** (it's tracking) |
| **2 — Behavioral grading** | action-vs-belief discipline flags (deterministic rules) on Journal + Dashboard | Judgment → **paid** |
| **3 — Loop closure** | actions open/resolve predictions; retire thesis-check-born predictions | — |
| **4 — Your Edge** | realized-results scorecard (the proof layer) | Advanced |

Phase 1 stands alone: even with nothing else, "here's everything you did and what you believed when you did it" is valuable and shippable.

### Tiering
Capture + the raw log = **free** ("track free"). Grading, coaching, and Your Edge = **paid** ("judgment paid"). Consistent with `TIERS.md`.

---

## 5. Open decisions (need sign-off before building Phase 1)

1. **Detection trigger** — diff on every book save (debounced), mirroring how the buy-zone journal runs on render? _(Recommended.)_
2. **The "why" UX** — log immediately with `why=null`, then a gentle "label your recent moves (3)" nudge on the Journal you clear at leisure — vs. an inline prompt at edit time. _(Recommend the non-blocking nudge — never interrupt a trade entry.)_
3. **Corrections** — trust the user to mark "not a trade," or add a heuristic (e.g. ignore <2% share changes)? _(Recommend trust + the dismiss tag; keep it forgiving, revisit if noisy.)_
4. **Manual entry** — Phase 1 is auto-detect only; allow manually logging trades made outside the app later? _(Recommend defer to Phase 2+.)_
5. **Watchlist events** — log "started/stopped watching" too, or positions only in Phase 1? _(Recommend positions-only first; watchlist intent is lighter, add in Phase 2.)_

---

## 6. One-line summary

> **Decide** is where you make the call. The **Action Log** is what you actually did about it. The **Journal** grades both — over time, honestly. Without the middle one, the other two can never tell you whether your *behavior* matched your *conviction* — and that gap is the whole game.
