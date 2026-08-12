import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getRequestUserId } from "@/lib/nexus-memory";
import { isFeatureAllowed } from "@/lib/tier";

// NEXUS Memory READ — the per-user judgment layer the Dashboard reads back. Returns the latest thesis
// evaluation per ticker + the week-over-week strength delta (vs the prior evaluation), so the cockpit's
// "Act Now" can surface weakening/contradicted theses and a "Pulse" of strengthening vs weakening — real
// judgment from the memory ledger, not client-side price heuristics. Owner-scoped, read-only, fail-soft.
export const dynamic = "force-dynamic";

const EMPTY = { theses: [], pulse: { strengthening: 0, weakening: 0, total: 0 }, health: null as number | null };

export async function GET() {
  try {
    // "Track free, judgment paid" — the NEXUS memory layer (brief, strength chip, contradiction alerts,
    // Act-Now) is the paid judgment. Free users get EMPTY (the surfaces simply show nothing, no error).
    // No-op while PAID_GATING_ENABLED is off (owner always allowed).
    if (!(await isFeatureAllowed("nexus"))) return NextResponse.json(EMPTY);
    const userId = await getRequestUserId();
    if (!userId) return NextResponse.json(EMPTY);
    const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { data } = await sb
      .from("nexus_thesis_evaluations")
      .select("ticker, status, strength_score, evaluated_at, scorecard, critical_unknown")
      .eq("user_id", userId)
      .order("evaluated_at", { ascending: false })
      .limit(500);
    const rows = data ?? [];

    // Group by ticker → most recent evaluation + the one before it (for the change delta).
    const byTicker = new Map<string, typeof rows>();
    for (const r of rows) {
      const arr = byTicker.get(r.ticker) ?? [];
      arr.push(r);
      byTicker.set(r.ticker, arr);
    }

    let strengthening = 0, weakening = 0, healthSum = 0, healthN = 0;
    const theses = [...byTicker.entries()].map(([ticker, list]) => {
      const latest = list[0];
      const prev = list[1] ?? null;
      const strength = latest.strength_score as number | null;
      const delta = (strength != null && prev?.strength_score != null) ? Math.round((strength - prev.strength_score) * 10) / 10 : null;
      if (delta != null) { if (delta > 0.3) strengthening++; else if (delta < -0.3) weakening++; }
      if (strength != null) { healthSum += strength; healthN++; }
      // Conviction timeline — the full strength series for sparklines (newest-first in DB, reverse for chronological)
      const timeline = list
        .filter(e => e.strength_score != null)
        .map(e => ({ d: (e.evaluated_at as string).slice(0, 10), s: e.strength_score as number, st: e.status as string }))
        .reverse();
      // Accuracy — price_at_eval from scorecard (if recorded) for retrospective grading
      const priceAtEval = (latest.scorecard as Record<string, unknown> | null)?.price_at_eval as number | null ?? null;
      return { ticker, status: latest.status, strength, prevStrength: prev?.strength_score ?? null, delta, evaluatedAt: latest.evaluated_at, scorecard: latest.scorecard ?? null, criticalUnknown: latest.critical_unknown ?? null, timeline, priceAtEval };
    });

    const health = healthN ? Math.round((healthSum / healthN) * 10) / 10 : null;

    // ── CONVICTION LEDGER ──────────────────────────────────────────────────────────────────────────
    // Open predictions (the falsifiable calls still being tracked) + the resolved track record, graded on
    // TWO axes — outcome-right (did it hit) AND reasoning-right (did the thesis actually drive it). The
    // four quadrants separate skill from luck so we never reward a lucky win or punish a sound, unlucky call.
    // Fail-soft: any table/column not present → empty ledger, never breaks the cockpit.
    const today = new Date().toISOString().slice(0, 10);
    let ledger: Record<string, unknown> = { open: [], openCount: 0, trackRecord: null };
    try {
      const { data: preds } = await sb
        .from("nexus_predictions")
        .select("ticker, metric, direction, threshold, horizon_date, basis_price, created_at, rationale")
        .eq("user_id", userId)
        .order("horizon_date", { ascending: true })
        .limit(300);
      const allPreds = preds ?? [];
      const open = allPreds.filter((p) => String(p.horizon_date) >= today);

      const { data: resolved } = await sb
        .from("nexus_thesis_evaluations")
        .select("ticker, outcome_correct, reasoning_correct, resolved_at")
        .eq("user_id", userId)
        .not("resolved_at", "is", null)
        .order("resolved_at", { ascending: false })
        .limit(300);
      const res = resolved ?? [];
      const q = (oc: boolean, rc: boolean) => res.filter((r) => r.outcome_correct === oc && r.reasoning_correct === rc).length;
      ledger = {
        open: open.slice(0, 12).map((p) => ({ ticker: p.ticker, metric: p.metric, direction: p.direction, threshold: p.threshold, horizonDate: p.horizon_date, basisPrice: p.basis_price, createdAt: p.created_at, rationale: p.rationale })),
        openCount: open.length,
        trackRecord: res.length ? {
          resolved: res.length,
          outcomeRight: res.filter((r) => r.outcome_correct === true).length,
          reasoningRight: res.filter((r) => r.reasoning_correct === true).length,
          skill: q(true, true),       // right call, sound reasoning
          luck: q(true, false),       // right call, broken reasoning → don't reward
          variance: q(false, true),   // wrong call, sound reasoning → don't punish (bad luck / black swan)
          failure: q(false, false),   // wrong call, broken reasoning
          items: res.slice(0, 12),
        } : null,
      };
    } catch { /* fail-soft — ledger stays empty */ }

    return NextResponse.json({ theses, pulse: { strengthening, weakening, total: theses.length }, health, ledger });
  } catch {
    return NextResponse.json(EMPTY);
  }
}
