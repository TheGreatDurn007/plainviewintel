// ════════════════════════════════════════════════════════════════════════════════════════════
// NEXUS Memory — server-side write layer for the immutable observation ledger (Memory v1).
// ════════════════════════════════════════════════════════════════════════════════════════════
// Writes per-ticker signal observations into nexus_signal_observations. Properties enforced here:
//   • APPEND-ONLY, DEDUP ON CHANGE — only insert an observation when its value differs from the
//     latest one already on record for (user, ticker, signal_type). No noise, no rewrites.
//   • OWNER-ATTRIBUTED — user_id is set EXPLICITLY (service-role writes have no auth.uid()).
//   • FAIL-OPEN — any error is swallowed; a memory write must NEVER block or alter the user-facing
//     response. Memory is a side-effect, not part of the request's success path.
// See reference_nexus_memory_v1_design.md + reference_nexus_evidence_hierarchy.md.

import { createServerClient } from "@supabase/ssr";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { classifyTrust } from "./trust-classify";

export type TrustTier = "authoritative" | "derived" | "ai_interpretation" | "historical";

export type ObservationInput = {
  signal_type: string;          // e.g. price | gross_margin | revenue_growth | analyst_target | rsi | next_earnings
  numeric_value: number | null; // broken out for fast time-series aggregation (null for non-numeric)
  value: unknown;               // full payload (raw, units, qualifiers)
  source: string;               // e.g. "Yahoo financials" | "analyst consensus" | "SEC EDGAR"
  as_of?: string | null;        // ISO date the datum is true as of
  trust_tier?: TrustTier;       // default authoritative
};

/** Resolve the authenticated user's id from the request session (cookies). Null if not signed in. */
export async function getRequestUserId(): Promise<string | null> {
  try {
    const cookieStore = await cookies();
    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          getAll() { return cookieStore.getAll(); },
          setAll() { /* read-only in a route handler — session refresh is the middleware's job */ },
        },
      }
    );
    const { data: { user } } = await supabase.auth.getUser();
    return user?.id ?? null;
  } catch {
    return null;
  }
}

function serviceClient(): SupabaseClient {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );
}

// Two numeric values are "the same" if equal within a tiny tolerance (avoids float-noise dupes).
function sameNumber(a: number | null | undefined, b: number | null | undefined): boolean {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  const denom = Math.max(1e-9, Math.abs(a), Math.abs(b));
  return Math.abs(a - b) / denom < 1e-6;
}

/**
 * Append GLOBAL signal observations for a ticker (the shared hive mind — facts are the SAME for every
 * user, so they are stored ONCE per ticker, not per user). Only inserts the ones whose value CHANGED
 * vs the latest on record for (ticker, signal_type). Append-only + fail-open. Returns the number of
 * rows actually written (for the integrity harness / observability); never throws.
 *
 * Writes use the service role (clients can never write to the facts ledger). No user_id — these are
 * objective public facts shared by everyone. Private judgment (thesis/decisions) lives in the per-user
 * tables, not here.
 */
export async function recordSignalObservations(
  ticker: string,
  observations: ObservationInput[]
): Promise<number> {
  if (!ticker || !observations?.length) return 0;
  try {
    const sb = serviceClient();
    const canonical = ticker.trim().toUpperCase();

    // One read: the most recent GLOBAL observations for this ticker → latest value per signal_type.
    const { data: recent } = await sb
      .from("nexus_signal_observations")
      .select("signal_type, numeric_value, value, observed_at")
      .eq("ticker", canonical)
      .order("observed_at", { ascending: false })
      .limit(200);

    const latest = new Map<string, { numeric_value: number | null; value: unknown }>();
    for (const row of recent ?? []) {
      if (!latest.has(row.signal_type)) latest.set(row.signal_type, { numeric_value: row.numeric_value, value: row.value });
    }

    const nowIso = new Date().toISOString().slice(0, 10);
    const toInsert = observations
      .filter((o) => o && o.signal_type && (o.numeric_value != null || o.value != null))
      .filter((o) => {
        const prev = latest.get(o.signal_type);
        if (!prev) return true; // never recorded for this ticker → insert
        // changed if the numeric value moved, or (for non-numeric) the JSON payload differs
        if (o.numeric_value != null || prev.numeric_value != null) return !sameNumber(o.numeric_value, prev.numeric_value);
        return JSON.stringify(o.value) !== JSON.stringify(prev.value);
      })
      .map((o) => ({
        ticker: canonical,
        signal_type: o.signal_type,
        numeric_value: o.numeric_value ?? null,
        value: o.value ?? null,
        source: o.source,
        // Jurisdiction-aware trust grade (P0.2): classify by the REAL source relative to the
        // security's home regulator, instead of blanket-trusting every write as authoritative.
        // An explicit caller-supplied tier still wins. See trust-classify.ts.
        trust_tier: o.trust_tier ?? classifyTrust(o.source, canonical, o.signal_type),
        as_of: o.as_of ?? nowIso,
      }));

    if (!toInsert.length) return 0;
    const { error } = await sb.from("nexus_signal_observations").insert(toInsert);
    if (error) return 0; // fail-open
    return toInsert.length;
  } catch {
    return 0; // fail-open — memory writes never affect the request
  }
}

export type EvaluationInput = {
  ticker: string;
  thesisText: string;
  catalystText?: string | null;
  status: string;                 // supported | mixed | contradicted | unsupported | insufficient
  strengthScore: number | null;   // 0-10, derived from the verdict — the series that powers "strength +14%"
  points: unknown;                // the evidence points (jsonb)
  summary?: string | null;
  engineVersion?: string | null;
  scorecard?: unknown;            // NEXUS-THESIS §8 — the deterministic Phase-1 scorecard (jsonb), recorded learnably
  criticalUnknown?: string | null; // the load-bearing unverified claim at evaluation time (§5)
};

/**
 * Record a PER-USER thesis evaluation (the verdict history that powers thesis-evolution). Finds or
 * creates the user's current thesis_snapshot for this ticker (a NEW snapshot only when the thesis text
 * changes — immutable history of what they believed), then appends the evaluation linked to it. Dedups
 * an evaluation only when the verdict is identical to the last (same status + score) so rapid re-checks
 * don't spam the timeline. Owner-attributed, append-only, FAIL-OPEN — never throws, never blocks.
 */
export async function recordThesisEvaluation(
  userId: string | null,
  e: EvaluationInput
): Promise<{ snapshotId: string | null; wrote: boolean }> {
  const none = { snapshotId: null as string | null, wrote: false };
  if (!userId || !e?.ticker || !e?.thesisText?.trim() || !e?.status) return none;
  try {
    const sb = serviceClient();
    const canonical = e.ticker.trim().toUpperCase();
    const thesis = e.thesisText.trim();

    // 1. Find the user's latest snapshot for this ticker; create a new one if none or the thesis changed.
    const { data: snaps } = await sb
      .from("nexus_thesis_snapshots")
      .select("id, thesis_text")
      .eq("user_id", userId)
      .eq("ticker", canonical)
      .order("created_at", { ascending: false })
      .limit(1);
    let snapshotId: string | null = snaps?.[0]?.id ?? null;
    const prevThesis = (snaps?.[0]?.thesis_text ?? "").trim();
    if (!snapshotId || prevThesis !== thesis) {
      const { data: ins, error } = await sb
        .from("nexus_thesis_snapshots")
        .insert({ user_id: userId, ticker: canonical, thesis_text: thesis, catalyst_text: e.catalystText ?? null })
        .select("id")
        .single();
      if (error || !ins) return { snapshotId, wrote: false };
      snapshotId = ins.id;
    }

    // 2. Dedup: skip if the latest evaluation for this snapshot has the same verdict (status + score).
    const { data: lastEval } = await sb
      .from("nexus_thesis_evaluations")
      .select("status, strength_score")
      .eq("thesis_snapshot_id", snapshotId)
      .order("evaluated_at", { ascending: false })
      .limit(1);
    const prev = lastEval?.[0];
    if (prev && prev.status === e.status && sameNumber(prev.strength_score, e.strengthScore)) {
      return { snapshotId, wrote: false };
    }

    // 3. Append the evaluation. Record the Conviction-Ledger contract fields (scorecard + critical_unknown,
    //    NEXUS-THESIS §8) so every decision is stored learnably. RESILIENT: if those columns don't exist yet
    //    (migration nexus-ledger-contract.sql not applied), retry without them so recording never breaks.
    const baseRow = {
      user_id: userId,
      thesis_snapshot_id: snapshotId,
      ticker: canonical,
      status: e.status,
      strength_score: e.strengthScore,
      points: e.points ?? [],
      summary: e.summary ?? null,
      engine_version: e.engineVersion ?? null,
    };
    let { error: evalErr } = await sb.from("nexus_thesis_evaluations").insert({
      ...baseRow,
      scorecard: e.scorecard ?? null,
      critical_unknown: e.criticalUnknown ?? null,
    });
    if (evalErr) {
      // Most likely the ledger-contract columns aren't applied yet — fall back to the base row.
      ({ error: evalErr } = await sb.from("nexus_thesis_evaluations").insert(baseRow));
    }
    if (evalErr) return { snapshotId, wrote: false };
    return { snapshotId, wrote: true };
  } catch {
    return none; // fail-open
  }
}

export type PredictionInput = {
  ticker: string;
  metric: string;                  // price | revenue_growth | gross_margin | catalyst | ...
  direction: "above" | "below" | "reaches" | "occurs" | "avoids";
  threshold: number | null;        // target value (null for a pure event)
  horizonDate: string;             // ISO date — by when it should be true (makes it gradeable)
  basisPrice?: number | null;      // price at prediction time
  rationale?: string | null;       // the thesis in one line
  thesisSnapshotId?: string | null;
  source?: "decide" | "thesis" | "manual";
};

/**
 * Record a PER-USER falsifiable prediction (P1 write-path). Born when a user commits to a trade in
 * Decide. FAIL-OPEN (never throws, never blocks the response). ONE ACTIVE CALL per (ticker, metric,
 * direction): re-running a thesis-check UPDATES the open call in place (a changed target replaces it)
 * and collapses any older open duplicates — so the ledger holds a user's current conviction per name,
 * not a pile of every target they ever typed. A resolved/expired call (horizon passed) is left intact;
 * the next call after that opens a fresh row.
 */
export async function recordPrediction(userId: string | null, p: PredictionInput): Promise<{ wrote: boolean }> {
  if (!userId || !p?.ticker || !p?.metric || !p?.direction || !p?.horizonDate) return { wrote: false };
  try {
    const sb = serviceClient();
    const canonical = p.ticker.trim().toUpperCase();
    const today = new Date().toISOString().slice(0, 10);

    // ONE active call per (ticker, metric, direction). Re-running a thesis-check UPDATES the open call in
    // place rather than appending — so a changed target (NVDA $300 → $250 → $600) replaces it instead of
    // stacking three rows. The newest open row is kept (preserving its id + any linked outcome) and any
    // older open duplicates for the same key are collapsed. NOTE: the ticker is kept exact, so cross-listing
    // variants (BB vs BB.TO) stay distinct on purpose — the same price number means different things across
    // currencies, so merging them would corrupt grading; that's handled separately, currency-aware.
    const { data: openRows } = await sb
      .from("nexus_predictions")
      .select("id, created_at")
      .eq("user_id", userId)
      .eq("ticker", canonical)
      .eq("metric", p.metric)
      .eq("direction", p.direction)
      .gte("horizon_date", today) // still open
      .order("created_at", { ascending: false });
    const open = openRows ?? [];
    const fields = {
      thesis_snapshot_id: p.thesisSnapshotId ?? null,
      threshold: p.threshold ?? null,
      horizon_date: p.horizonDate,
      basis_price: p.basisPrice ?? null,
      rationale: p.rationale ? p.rationale.slice(0, 280) : null,
      source: p.source ?? "decide",
    };

    if (open.length) {
      // Refresh the most-recent open call; drop any older duplicates so exactly one active call remains.
      const { error: upErr } = await sb.from("nexus_predictions").update(fields).eq("id", open[0].id);
      if (open.length > 1) {
        await sb.from("nexus_predictions").delete().in("id", open.slice(1).map((r) => r.id));
      }
      return { wrote: !upErr };
    }

    const { error } = await sb.from("nexus_predictions").insert({
      user_id: userId,
      ticker: canonical,
      metric: p.metric,
      direction: p.direction,
      ...fields,
    });
    if (error) return { wrote: false }; // fail-open (e.g. table not yet created)
    return { wrote: true };
  } catch {
    return { wrote: false }; // fail-open
  }
}

export type OutcomeInput = {
  predictionId: string;
  ticker: string;
  grade: "hit" | "miss" | "partial" | "unresolved" | "cancelled";
  actualValue?: number | null;
  evidenceSignalIds?: string[];
  lessonText?: string | null;
};

/** Append a graded OUTCOME for a prediction (P1 grader write-path). Append-only, FAIL-OPEN. The grade
 *  is deterministic (trust_tier 'derived'); a prediction is considered resolved once it has an outcome. */
export async function recordOutcome(userId: string | null, o: OutcomeInput): Promise<{ wrote: boolean }> {
  if (!userId || !o?.predictionId || !o?.ticker || !o?.grade) return { wrote: false };
  try {
    const sb = serviceClient();
    const { error } = await sb.from("nexus_outcomes").insert({
      user_id: userId,
      prediction_id: o.predictionId,
      ticker: o.ticker.trim().toUpperCase(),
      grade: o.grade,
      actual_value: o.actualValue ?? null,
      evidence_signal_ids: o.evidenceSignalIds ?? [],
      lesson_text: o.lessonText ?? null,
    });
    if (error) return { wrote: false }; // fail-open
    return { wrote: true };
  } catch {
    return { wrote: false }; // fail-open
  }
}

/** Service-role client (exported so the grader can read predictions/observations + write outcomes). */
export function nexusServiceClient(): SupabaseClient { return serviceClient(); }

// ─── ACTION LOG (behavioral ledger, P1) — "what you actually did" ────────────────────────────────
// Auto-captured by the client diffing the user's book; written here. The action FACTS are set once
// (Tier-1 evidence); only `why` is patched later. PER-USER PRIVATE. Spec: repo ACTION-LOG.md.
export type ActionInput = {
  ticker: string;
  name?: string | null;
  actionType: "opened" | "added" | "trimmed" | "closed";
  sharesDelta?: number | null;
  sharesAfter?: number | null;
  avgBefore?: number | null;
  avgAfter?: number | null;
  priceAt?: number | null;
  currency?: string | null;
  fromWatchlist?: boolean;
  thesisText?: string | null;
  thesisVerdict?: string | null;
  nexusStrength?: number | null;
  zoneState?: string | null;
  occurredAt?: string | null;
};
const ACTION_TYPES = new Set(["opened", "added", "trimmed", "closed"]);
const ACTION_WHY = new Set(["take_profit", "thesis_changed", "better_opportunity", "rebalance", "stop_hit", "fomo", "not_a_trade"]);

/** Bulk-insert detected book actions (FAIL-OPEN). Caps the batch so a baseline mishap can't flood.
 *  IDEMPOTENT: the same action (ticker + type + resulting share count) within a 12h window is collapsed to
 *  one — so a user with several devices open (each diffing its own stale baseline and re-posting the same
 *  sell, often at slightly different live prices) logs the trade ONCE, not once per device/sync. Price is
 *  deliberately excluded from the key for this reason. Dedups both against what's stored AND within the batch. */
const _actionKey = (ticker: string, type: string, after: number | null | undefined, delta: number | null | undefined) =>
  `${String(ticker).trim().toUpperCase()}|${type}|${after != null ? Math.round(after) : delta != null ? "d" + Math.round(delta) : "?"}`;

export async function recordActions(userId: string | null, actions: ActionInput[]): Promise<{ wrote: number; deduped?: number }> {
  if (!userId || !Array.isArray(actions) || !actions.length) return { wrote: 0 };
  try {
    const sb = serviceClient();
    const candidates = actions
      .filter((a) => a && a.ticker && ACTION_TYPES.has(a.actionType))
      .slice(0, 40);
    if (!candidates.length) return { wrote: 0 };
    // Burst guard: a single batch with many opens/closes is a bulk-load / multi-device-sync mis-detection
    // (the book repopulating), not real activity — drop it rather than log a whole portfolio as "opened today".
    const burstOpens = candidates.filter((a) => a.actionType === "opened").length;
    const burstCloses = candidates.filter((a) => a.actionType === "closed").length;
    if (burstOpens >= 4 || burstCloses >= 4) return { wrote: 0, deduped: candidates.length };

    // Recent actions (12h) → the dedup set. Best-effort: if this read fails we fall back to inserting all.
    const since = new Date(Date.now() - 12 * 3600 * 1000).toISOString();
    const seen = new Set<string>();
    try {
      const { data: recent } = await sb.from("nexus_actions")
        .select("ticker, action_type, shares_after, shares_delta")
        .eq("user_id", userId).gte("occurred_at", since).limit(300);
      for (const r of (recent ?? []) as Array<{ ticker: string; action_type: string; shares_after: number | null; shares_delta: number | null }>)
        seen.add(_actionKey(r.ticker, r.action_type, r.shares_after, r.shares_delta));
    } catch { /* no dedup set → insert all (fail-open) */ }

    const rows: Record<string, unknown>[] = [];
    let deduped = 0;
    for (const a of candidates) {
      const key = _actionKey(a.ticker, a.actionType, a.sharesAfter, a.sharesDelta);
      if (seen.has(key)) { deduped++; continue; }     // duplicate of a stored or earlier-in-batch action
      seen.add(key);
      rows.push({
        user_id: userId,
        ticker: String(a.ticker).trim().toUpperCase(),
        name: a.name ?? null,
        action_type: a.actionType,
        shares_delta: a.sharesDelta ?? null,
        shares_after: a.sharesAfter ?? null,
        avg_before: a.avgBefore ?? null,
        avg_after: a.avgAfter ?? null,
        price_at: a.priceAt ?? null,
        currency: a.currency ?? null,
        from_watchlist: !!a.fromWatchlist,
        thesis_text: a.thesisText ? a.thesisText.slice(0, 600) : null,
        thesis_verdict: a.thesisVerdict ?? null,
        nexus_strength: a.nexusStrength ?? null,
        zone_state: a.zoneState ?? null,
        occurred_at: a.occurredAt ?? new Date().toISOString(),
      });
    }
    if (!rows.length) return { wrote: 0, deduped };
    const { error } = await sb.from("nexus_actions").insert(rows);
    if (error) return { wrote: 0, deduped }; // fail-open (e.g. table not yet created)
    return { wrote: rows.length, deduped };
  } catch {
    return { wrote: 0 };
  }
}

/** Recent actions for the Journal timeline (newest first). */
export async function listActions(userId: string | null, limit = 40): Promise<Record<string, unknown>[]> {
  if (!userId) return [];
  try {
    const sb = serviceClient();
    const { data } = await sb
      .from("nexus_actions")
      .select("*")
      .eq("user_id", userId)
      .order("occurred_at", { ascending: false })
      .limit(Math.min(100, Math.max(1, limit)));
    return data ?? [];
  } catch {
    return [];
  }
}

/** Label an action's intent (the one-tap "why"). The only mutable field on an action. */
export async function setActionWhy(userId: string | null, id: string, why: string): Promise<{ ok: boolean }> {
  if (!userId || !id || !ACTION_WHY.has(why)) return { ok: false };
  try {
    const sb = serviceClient();
    const { error } = await sb
      .from("nexus_actions")
      .update({ why, why_at: new Date().toISOString() })
      .eq("id", id)
      .eq("user_id", userId);
    return { ok: !error };
  } catch {
    return { ok: false };
  }
}

/** Delete one of the user's OWN actions — for mis-detection cleanup (e.g. a typo-fix logged as a trade).
 *  Ownership enforced in the query; the service client bypasses RLS so no extra policy is needed. */
export async function deleteAction(userId: string | null, id: string): Promise<{ ok: boolean }> {
  if (!userId || !id) return { ok: false };
  try {
    const sb = serviceClient();
    const { error } = await sb.from("nexus_actions").delete().eq("id", id).eq("user_id", userId);
    return { ok: !error };
  } catch {
    return { ok: false };
  }
}
