# NEXUS — the judgment layer

_The moat. Plainview's reason to exist beyond "AI stock scanner." Last updated 2026-06-12._

---

## North star

You open Plainview and **NEXUS speaks first**:

> "3 theses strengthened this week, 2 weakened. **NOK needs a decision** — its thesis lost support while it's up 70% with no take-profit. **AUR** hit your buy zone and ran +6% without you. Your weakest dollar is in **SI=F**; your best unowned candidate is **X**."

The intelligence is invisible until it has something to say. That brief is the **retention engine** — the thing a user checks every morning. We sell **judgment + memory, not data**.

## What already exists (build ON this)

- **`nexus_signal_observations`** — global, per-ticker facts ledger. Append-only, dedup-on-change. The hive mind. (`recordSignalObservations`)
- **`nexus_thesis_snapshots`** — per-user, immutable record of *what you believed* (new row only when thesis text changes).
- **`nexus_thesis_evaluations`** — per-user verdict history with `strength_score` 0–10. **The series that powers "conviction in NOK +14% this month."** (`recordThesisEvaluation`)
- **`/api/thesis-check`** — gathers signals + AI-evaluates one thesis + records the evaluation. Already wired.
- **`/api/nexus-memory`** — read side, already feeds the Dashboard "Act Now."
- **Buy-zone journal** (client) — detects/marks/persists zone entries & exits per watchlist name.

The gap: evaluations are only written **when the user manually runs a check**, and **nothing reads the ledger back as a brief**. A filing cabinet no one reads aloud.

## Home: the Journal page

Dashboard stays the live cockpit. **Journal becomes NEXUS's memory + judgment surface** (its old "exit" content is disposable):
1. **The NEXUS Brief** (top) — synthesized morning judgment + "what changed since your last visit."
2. **Thesis evolution** — per-position conviction timelines (the `strength_score` series).
3. **Discipline ledger** — the buy-zone journal + "was it right" outcomes + contradictions.

## The path — three slices

### Phase 1 — Daily thesis sweep (foundation)
Make NEXUS evaluate **continuously, not on-click**. Client-orchestrated, reusing `/api/thesis-check`:
- On app open, if `lastNexusSweep !== today` (date guard — rapid open/close on the same day does NOT re-trigger; once per day per user), fire a throttled background sweep over every portfolio holding with a thesis → each records an evaluation.
- Persist `lastNexusSweep` in appSettings (survives reload). Fire-and-forget; never blocks the UI. Cost ≈ $0 (free-first models).
- Result: the evaluations ledger accumulates a real per-holding record → "what changed" becomes computable.

### Phase 2 — The NEXUS Brief (the visible magic)
A synthesis on the Journal page that reads the ledger + buy-zone journal + portfolio attention signals and produces:
- **Portfolio pulse**: N strengthening / M weakening / K contradicted (from `strength_score` deltas across evaluations).
- **Needs attention, ranked**: weakening/contradicted theses, un-protected winners, buy-zone hits/exits.
- **What changed since last visit**: new verdict flips, new SEC signals, zone transitions.
- One AI pass synthesizes the above into a short brief (Claude — this IS the judgment, the place quality matters; free fallback).

### Phase 3 — Thesis evolution + "was it right"
- Per-position conviction timeline (strength_score over time) + thesis-change history (snapshots).
- Outcome scoring on the buy-zone journal: "you said buy $X; it hit on D; it's since done Y." The discipline scorecard. (This is the journal's deferred "was it right" — now powered by NEXUS, not hand-coded.)

## Laws (non-negotiable)
- **Facts > AI opinion.** AI output may be stored/shown but never becomes evidence (no self-poisoning). Tier-1 facts outrank everything.
- **Global facts, private judgment.** Observations are global per-ticker; snapshots/evaluations/decisions are per-user.
- **Fail-open.** Memory writes and the sweep never block or alter a user-facing response.

See [[reference_nexus_memory_v1_design]], [[reference_nexus_evidence_hierarchy]], [[project_quickview_and_journal]], [[project_nexus_accuracy]].
