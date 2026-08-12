// ════════════════════════════════════════════════════════════════════════════════════════════
// NEXUS Grader — resolves open predictions into outcomes ("was I right?"). P1 slice 3.
// ════════════════════════════════════════════════════════════════════════════════════════════
// DETERMINISTIC, $0, no AI. For each open prediction it asks a pure question: did price reach the
// target? It grades ONLY against ADMISSIBLE facts — the logged price observations
// (nexus_signal_observations, signal_type 'price', which are Tier-1 'authoritative') plus the
// prediction's own basis price. If there's no admissible price to judge with and the horizon has
// passed, it records 'unresolved' — never a guessed hit/miss (credible by construction).
//
// EARLY-HIT rule (owner's design): a "reaches $X" call is a HIT the moment price touches $X — you
// don't wait the full horizon to confirm a win, only to confirm a miss. So good calls resolve fast.

import { nexusServiceClient, recordOutcome } from "./nexus-memory";
import { callGroqText, callCerebrasText } from "./market-context";

// §8.1 DUAL JUDGMENT — when a prediction resolves, grade the REASONING separately from the OUTCOME and
// write both to the linked thesis evaluation. outcome_correct is deterministic (did price hit the target);
// reasoning_correct is a genuine judgment (did the core premise / Critical Unknown actually hold and DRIVE
// the result, or did it win/lose for a reason the reasoning never named) → free chain, $0, fully fail-open.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function gradeReasoning(sb: any, prediction: any, grade: "hit" | "miss"): Promise<void> {
  try {
    if (!prediction.thesis_snapshot_id) return;
    const { data: evs } = await sb
      .from("nexus_thesis_evaluations")
      .select("id, scorecard, critical_unknown")
      .eq("thesis_snapshot_id", prediction.thesis_snapshot_id)
      .is("resolved_at", null)
      .order("evaluated_at", { ascending: false })
      .limit(1);
    const ev = evs?.[0];
    if (!ev) return;
    const outcome_correct = grade === "hit";
    let reasoning_correct: boolean | null = null;
    try {
      const cu = ev.critical_unknown || "(none recorded)";
      const prompt = `An investor's thesis predicted ${prediction.ticker} would reach ${prediction.threshold}. The price ${grade === "hit" ? "HIT" : "did NOT reach"} that target.
Thesis rationale: "${String(prediction.rationale || "").slice(0, 400)}"
The single load-bearing UNKNOWN the thesis rested on was: "${cu}".
Judge ONLY the REASONING, completely independent of the price result: did the thesis's core premise / that unknown actually HOLD and DRIVE this outcome (sound reasoning), or did the price move for a DIFFERENT reason than the thesis claimed (a hit would be luck; a miss despite the premise holding would be variance)? If you genuinely cannot tell from this, answer null.
Return ONLY JSON: {"reasoning_correct": true|false|null}`;
      let raw = "";
      try { raw = await callGroqText(prompt, 0); } catch { raw = await callCerebrasText(prompt, 0); }
      const m = raw.match(/\{[\s\S]*?\}/);
      if (m) { const j = JSON.parse(m[0]); if (typeof j.reasoning_correct === "boolean") reasoning_correct = j.reasoning_correct; }
    } catch { /* fail-open → reasoning_correct stays null */ }
    await sb.from("nexus_thesis_evaluations")
      .update({ outcome_correct, reasoning_correct, resolved_at: new Date().toISOString() })
      .eq("id", ev.id);
  } catch { /* fail-open — the dual judgment is additive, never blocks outcome grading */ }
}

export type GradeablePrediction = {
  id: string;
  ticker: string;
  direction: string;
  threshold: number | null;
  horizon_date: string; // ISO date
};

export type PriceWindow = { high: number; low: number } | null;

/**
 * Pure grading decision. Returns 'hit' | 'miss' | 'unresolved' | null (null = still open, don't record).
 * window = the price extremes observed since the prediction was made (null = no admissible price yet).
 */
export function gradePrediction(p: GradeablePrediction, window: PriceWindow, today: string): "hit" | "miss" | "unresolved" | null {
  if (p.threshold == null) return null; // pure-event predictions: not gradeable on price (v1)
  const horizonPassed = today > p.horizon_date;

  if (!window) {
    // No admissible price to judge with. Past the horizon → we genuinely can't tell → unresolved
    // (honest), never a guessed grade. Still open → leave it.
    return horizonPassed ? "unresolved" : null;
  }

  let reached: boolean | null;
  if (p.direction === "reaches" || p.direction === "above") reached = window.high >= p.threshold;
  else if (p.direction === "below") reached = window.low <= p.threshold;
  else reached = null; // 'occurs' / 'avoids' need event data — not gradeable on price (v1)

  if (reached === null) return null;
  if (reached) return "hit";          // early-hit: touched the target → win, even before the horizon
  if (horizonPassed) return "miss";   // horizon passed and never reached → miss
  return null;                         // not reached yet, horizon not passed → still open
}

/**
 * Resolve all OPEN predictions for a user (no outcome yet). Reads admissible price observations,
 * grades each, and appends outcomes for the ones that resolved. Idempotent (skips already-graded),
 * append-only, FAIL-OPEN. Returns how many it graded. Never throws.
 */
export async function gradeOpenPredictions(userId: string | null): Promise<{ graded: number; checked: number }> {
  if (!userId) return { graded: 0, checked: 0 };
  try {
    const sb = nexusServiceClient();
    const today = new Date().toISOString().slice(0, 10);

    const { data: preds } = await sb
      .from("nexus_predictions")
      .select("id, ticker, direction, threshold, horizon_date, basis_price, created_at, thesis_snapshot_id, rationale")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(500);
    if (!preds?.length) return { graded: 0, checked: 0 };

    // Which predictions already have an outcome → skip (resolved).
    const { data: outs } = await sb
      .from("nexus_outcomes")
      .select("prediction_id")
      .eq("user_id", userId)
      .limit(1000);
    const resolved = new Set((outs ?? []).map((o) => o.prediction_id));
    const open = preds.filter((p) => !resolved.has(p.id));
    if (!open.length) return { graded: 0, checked: 0 };

    let graded = 0;
    for (const p of open) {
      // Admissible price window since the prediction was made: logged price observations (Tier-1)
      // + the prediction's own basis price. (Global facts — price is ticker-level, not per-user.)
      const { data: obs } = await sb
        .from("nexus_signal_observations")
        .select("numeric_value")
        .eq("ticker", p.ticker)
        .eq("signal_type", "price")
        .gte("observed_at", p.created_at)
        .not("numeric_value", "is", null)
        .limit(500);
      const prices = (obs ?? []).map((o) => Number(o.numeric_value)).filter((n) => Number.isFinite(n) && n > 0);
      if (Number.isFinite(Number(p.basis_price)) && Number(p.basis_price) > 0) prices.push(Number(p.basis_price));
      const window: PriceWindow = prices.length ? { high: Math.max(...prices), low: Math.min(...prices) } : null;

      const grade = gradePrediction(p, window, today);
      if (grade === null) continue; // still open

      const actual = grade === "hit"
        ? (p.direction === "below" ? (window?.low ?? null) : (window?.high ?? null))
        : (window ? (p.direction === "below" ? window.low : window.high) : null);
      const r = await recordOutcome(userId, {
        predictionId: p.id,
        ticker: p.ticker,
        grade,
        actualValue: actual,
        evidenceSignalIds: [], // price source is Tier-1 by construction; ids omitted in v1
        lessonText: null,
      });
      if (r.wrote) graded++;
      // §8.1 dual judgment — grade the REASONING separately and write both to the thesis evaluation.
      if (r.wrote && (grade === "hit" || grade === "miss")) await gradeReasoning(sb, p, grade);
    }
    return { graded, checked: open.length };
  } catch {
    return { graded: 0, checked: 0 }; // fail-open
  }
}
