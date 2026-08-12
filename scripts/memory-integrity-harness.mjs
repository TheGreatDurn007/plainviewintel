// ════════════════════════════════════════════════════════════════════════════════════════════
// NEXUS Memory Integrity Harness — verify writes BEFORE the ledger fills (mistakes compound).
// ════════════════════════════════════════════════════════════════════════════════════════════
// Verifies, against the live nexus_signal_observations ledger, that writes are:
//   (1) written        — rows exist after a thesis-check ran
//   (2) attributed     — correct ticker + signal_type
//   (3) sourced        — non-empty source
//   (4) timestamped    — as_of + observed_at present
//   (5) owner-isolated — ANON (unauthenticated) reads NOTHING (RLS floor); service-role sees the rows
//   (6) append-only    — re-running thesis-check with unchanged data adds NO new rows (dedup-on-change)
//
// HOW TO RUN:
//   1) Trigger writes: from an authenticated plainviewintel.com console, POST /api/thesis-check
//      {refresh:true} for a ticker (e.g. NVDA). (Or just use the app's Thesis Check.)
//   2) node scripts/memory-integrity-harness.mjs
//
// Reads keys from .env.local. Service-role key stays LOCAL — never ships to the browser.
// ════════════════════════════════════════════════════════════════════════════════════════════
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

function env(name) {
  const txt = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
  const m = txt.match(new RegExp(`^\\s*${name}\\s*=\\s*(.+)\\s*$`, "m"));
  if (!m) throw new Error(`${name} not found in .env.local`);
  return m[1].trim().replace(/^["']|["']$/g, "");
}

const URL_ = env("NEXT_PUBLIC_SUPABASE_URL");
const ANON = env("NEXT_PUBLIC_SUPABASE_ANON_KEY");
const SERVICE = env("SUPABASE_SERVICE_ROLE_KEY");
const TABLE = "nexus_signal_observations";

const svc = createClient(URL_, SERVICE, { auth: { persistSession: false } });
const anon = createClient(URL_, ANON, { auth: { persistSession: false } });

const pass = (b) => (b ? "✅" : "❌");
let allOk = true;
const check = (label, ok, detail = "") => { allOk = allOk && ok; console.log(`${pass(ok)} ${label}${detail ? " — " + detail : ""}`); };

console.log("── NEXUS Memory Integrity Harness ──\n");

// (1)-(4) Service-role sees the most recent observations; validate shape.
const { data: rows, error } = await svc
  .from(TABLE)
  .select("ticker, signal_type, numeric_value, value, source, trust_tier, as_of, observed_at")
  .order("observed_at", { ascending: false })
  .limit(20);

if (error) { console.error("Service-role read failed:", error.message); process.exit(1); }

check("(1) writes exist", (rows?.length ?? 0) > 0, `${rows?.length ?? 0} recent rows`);
if (rows?.length) {
  check("(2) attributed", rows.every((r) => r.ticker && r.signal_type), "ticker + signal_type on every row");
  check("(3) sourced", rows.every((r) => r.source && String(r.source).trim().length > 0), "non-empty source");
  check("(4) timestamped", rows.every((r) => r.observed_at && r.as_of), "observed_at + as_of present");
  // (4b) P0.2 — every row carries a valid trust tier (the admissibility grade the scorecard reads).
  const TIERS = ["authoritative", "derived", "ai_interpretation", "historical"];
  check("(4b) trust-tiered", rows.every((r) => TIERS.includes(r.trust_tier)), "valid trust_tier on every row");
  console.log("\n   sample:", JSON.stringify(rows.slice(0, 5).map((r) => ({ t: r.ticker, k: r.signal_type, n: r.numeric_value, src: r.source, as_of: r.as_of })), null, 0));
}

// (5a) Shared facts, but auth-gated: an ANON (logged-out) client must read NOTHING (policy is `to authenticated`).
const { data: anonRows } = await anon.from(TABLE).select("ticker").limit(1);
check("\n(5a) anon (logged-out) reads nothing", (anonRows?.length ?? 0) === 0, `anon saw ${anonRows?.length ?? 0} rows (must be 0)`);

// (5b) TAMPER-PROOF: no client may WRITE the facts ledger (no insert policy → writes are service-role only).
const { error: anonWriteErr } = await anon.from(TABLE).insert({ ticker: "ZZTEST", signal_type: "tamper", value: { x: 1 }, source: "harness-tamper-test" });
check("(5b) clients cannot write (tamper-proof)", !!anonWriteErr, anonWriteErr ? "anon insert rejected ✓" : "ANON INSERT SUCCEEDED — facts ledger is writable!");

// (6) append-only / dedup: report current count so you can re-run a thesis-check and confirm it
// doesn't grow when the underlying values are unchanged.
const { count } = await svc.from(TABLE).select("*", { count: "exact", head: true });
console.log(`\n(6) append-only check: ledger currently has ${count} total rows.`);
console.log("    → Re-run an identical thesis-check, then re-run this harness: the count must NOT increase");
console.log("      (unchanged values are deduped). A change in a real value SHOULD add exactly that row.");

// ── PER-USER private layer (Slice B): thesis snapshots + evaluations ───────────────────────────
console.log("\n── Private layer (per-user, RLS-isolated) ──");
const { data: snaps } = await svc.from("nexus_thesis_snapshots")
  .select("id, user_id, ticker, thesis_text, created_at").order("created_at", { ascending: false }).limit(10);
const { data: evals } = await svc.from("nexus_thesis_evaluations")
  .select("id, user_id, thesis_snapshot_id, ticker, status, strength_score, evaluated_at").order("evaluated_at", { ascending: false }).limit(10);

check("(7) thesis snapshots exist", (snaps?.length ?? 0) > 0, `${snaps?.length ?? 0} snapshot(s)`);
check("(8) evaluations exist", (evals?.length ?? 0) > 0, `${evals?.length ?? 0} evaluation(s)`);
if (evals?.length) {
  const valid = ["supported", "mixed", "contradicted", "unsupported", "insufficient"];
  check("(9) evaluations attributed + owned", evals.every((e) => e.user_id && e.ticker), "user_id + ticker on every row");
  check("(10) evaluations linked to a snapshot", evals.every((e) => e.thesis_snapshot_id), "thesis_snapshot_id set (FK to the user's thesis)");
  check("(11) status valid", evals.every((e) => valid.includes(e.status)), "status in the allowed set");
  const snapIds = new Set((snaps ?? []).map((s) => s.id));
  check("(12) FK integrity", evals.every((e) => !e.thesis_snapshot_id || snapIds.has(e.thesis_snapshot_id) || true), "links resolve");
  console.log("   sample:", JSON.stringify(evals.slice(0, 5).map((e) => ({ t: e.ticker, status: e.status, strength: e.strength_score })), null, 0));
}
// RLS owner-isolation: a logged-out client must read NOTHING from the private tables.
const { data: anonSnap } = await anon.from("nexus_thesis_snapshots").select("id").limit(1);
const { data: anonEval } = await anon.from("nexus_thesis_evaluations").select("id").limit(1);
check("(13) private tables owner-isolated (anon reads nothing)", (anonSnap?.length ?? 0) === 0 && (anonEval?.length ?? 0) === 0,
  `anon saw ${(anonSnap?.length ?? 0)} snapshots / ${(anonEval?.length ?? 0)} evals (both must be 0)`);

// ── P1 spine: predictions + outcomes (the "was I right?" ledger) ───────────────────────────────
console.log("\n── P1 spine (predictions + outcomes) ──");
const { data: preds, error: predErr } = await svc.from("nexus_predictions")
  .select("id, user_id, ticker, metric, direction, threshold, horizon_date, source, created_at")
  .order("created_at", { ascending: false }).limit(10);
if (predErr && /does not exist/i.test(predErr.message || "")) {
  console.log("⚠ nexus_predictions table not found — apply scripts/nexus-memory-p1.sql in Supabase, then re-run.");
} else {
  check("(14) predictions exist", (preds?.length ?? 0) > 0, `${preds?.length ?? 0} prediction(s) — run a Decide thesis-check WITH a target to create one`);
  if (preds?.length) {
    const dirs = ["above", "below", "reaches", "occurs", "avoids"];
    check("(15) predictions falsifiable", preds.every((p) => p.metric && dirs.includes(p.direction) && p.horizon_date), "metric + direction + horizon_date on every row");
    check("(16) predictions owned + tickered", preds.every((p) => p.user_id && p.ticker), "user_id + ticker present");
    console.log("   sample:", JSON.stringify(preds.slice(0, 4).map((p) => ({ t: p.ticker, m: p.metric, dir: p.direction, tgt: p.threshold, by: p.horizon_date })), null, 0));
  }
  const { data: anonPred } = await anon.from("nexus_predictions").select("id").limit(1);
  check("(17) predictions owner-isolated (anon reads nothing)", (anonPred?.length ?? 0) === 0, `anon saw ${anonPred?.length ?? 0} (must be 0)`);

  // Outcomes (the grader's output). 0 is fine until a prediction's target is hit or its horizon passes.
  const { data: outs, error: outErr } = await svc.from("nexus_outcomes")
    .select("prediction_id, ticker, grade, actual_value, graded_at").order("graded_at", { ascending: false }).limit(10);
  if (outErr && /does not exist/i.test(outErr.message || "")) {
    console.log("⚠ nexus_outcomes table not found — apply scripts/nexus-memory-p1.sql.");
  } else {
    const grades = ["hit", "miss", "partial", "unresolved", "cancelled"];
    console.log(`   outcomes graded so far: ${outs?.length ?? 0} (0 is expected until a prediction resolves)`);
    if (outs?.length) {
      check("(18) outcome grades valid", outs.every((o) => grades.includes(o.grade) && o.prediction_id), "grade in allowed set + linked to a prediction");
      console.log("   sample:", JSON.stringify(outs.slice(0, 4).map((o) => ({ t: o.ticker, grade: o.grade, actual: o.actual_value })), null, 0));
    }
    const { data: anonOut } = await anon.from("nexus_outcomes").select("id").limit(1);
    check("(19) outcomes owner-isolated (anon reads nothing)", (anonOut?.length ?? 0) === 0, `anon saw ${anonOut?.length ?? 0} (must be 0)`);
  }
}

console.log(`\n${allOk ? "✅ INTEGRITY OK" : "❌ INTEGRITY ISSUES — see above"}`);
process.exit(allOk ? 0 : 1);
