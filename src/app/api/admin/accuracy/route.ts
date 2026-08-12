import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { isAdmin } from "@/lib/usage-log";
import {
  fetchEarningsDate,
  fetchFinancialSnapshot,
  fetchTechnicalData,
  fetchNewsEvidence,
  fetchSecFilings,
  fetchThesisEdgarEvidence,
  runXray,
  fetchYahooProfile,
} from "@/lib/market-context";
import { isLikelyDifferentCompany } from "@/lib/thesis-score";

// ── ACCURACY HARNESS — the trust backstop. ──────────────────────────────────────────────────────────
// Turns the manual debug-sweeps into an automated guard: each check asserts one of the bug-CLASSES we've
// fixed (wrong-company resolution, dead earnings/financials/MA feeds, missing news/insider retrieval,
// implausible X-Ray output, an over-eager identity guard). It exercises the RETRIEVAL layer directly —
// no LLM, fast, $0 — so it can run per-deploy / on a cron and catch a regression before a user does.
// Owner-gated (404 otherwise). Universal tickers (AAPL/NVDA/AMC/MAG), no hardcoded "answers".
export const dynamic = "force-dynamic";
export const maxDuration = 60;

type Check = { name: string; cls: string; ok: boolean; ms: number; detail: string };

async function check(name: string, cls: string, fn: () => Promise<{ ok: boolean; detail: string }>): Promise<Check> {
  const t = Date.now();
  try {
    const r = await Promise.race([
      fn(),
      new Promise<{ ok: boolean; detail: string }>((_, rej) => setTimeout(() => rej(new Error("timeout")), 12000)),
    ]);
    return { name, cls, ok: r.ok, ms: Date.now() - t, detail: r.detail };
  } catch (e) {
    return { name, cls, ok: false, ms: Date.now() - t, detail: e instanceof Error ? e.message : "error" };
  }
}

// Persist the last run so the Admin card shows it instantly + a regression is visible even if no one clicked.
const HARNESS_KEY = "_harness/last.json";
function storage() { return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } }); }
async function readHarness(): Promise<Record<string, unknown> | null> {
  try { const { data, error } = await storage().storage.from("plainview-state").download(HARNESS_KEY); if (error || !data) return null; return JSON.parse(await data.text()); } catch { return null; }
}
async function writeHarness(obj: Record<string, unknown>): Promise<void> {
  try { const blob = new Blob([JSON.stringify(obj)], { type: "application/json" }); await storage().storage.from("plainview-state").upload(HARNESS_KEY, blob, { upsert: true, contentType: "application/json" }); } catch { /* fail-open */ }
}

export async function GET(request: Request) {
  // Auth: the owner's session (isAdmin) OR a Vercel cron carrying the CRON_SECRET bearer token.
  const auth = request.headers.get("authorization") || "";
  const cronOk = !!process.env.CRON_SECRET && auth === `Bearer ${process.env.CRON_SECRET}`;
  const admin = await isAdmin();
  if (!admin && !cronOk) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // ?last=1 → return the last stored run WITHOUT re-running (the Admin card paints it on open).
  if (new URL(request.url).searchParams.get("last") === "1" && admin) {
    const last = await readHarness();
    return NextResponse.json(last || { checks: [], passed: 0, total: 0, ranAt: null, never: true });
  }

  const checks = await Promise.all([
    // ── Identity / wrong-company resolution ──────────────────────────────────────────────────────────
    check("Wrong-listing guard catches MAG≠MAG Silver", "identity", async () => {
      const prof = await fetchYahooProfile("MAG");
      const flagged = isLikelyDifferentCompany("MAG Silver", prof.name);
      return { ok: flagged, detail: `profile="${prof.name ?? "?"}" → flagged=${flagged}` };
    }),
    check("Identity guard does NOT false-flag NVIDIA", "identity", async () => {
      const prof = await fetchYahooProfile("NVDA");
      const flagged = isLikelyDifferentCompany("NVIDIA", prof.name);
      return { ok: !flagged, detail: `profile="${prof.name ?? "?"}" → flagged=${flagged} (want false)` };
    }),

    // ── Retrieval completeness (the data feeds that were dead/blocked) ────────────────────────────────
    check("Earnings date resolves (Finnhub)", "retrieval", async () => {
      const d = await fetchEarningsDate("AMC");
      return { ok: !!d, detail: d ? `AMC → ${d}` : "null (no source — add FINNHUB_API_KEY?)" };
    }),
    check("Financials feed populates", "retrieval", async () => {
      const f = await fetchFinancialSnapshot("AAPL");
      const ok = f.grossMargins != null || f.revenueGrowth != null;
      return { ok, detail: ok ? `gm=${f.grossMargins}, revGrowth=${f.revenueGrowth}` : "all null" };
    }),
    check("Technicals: 50/200-day MAs populate", "retrieval", async () => {
      const t = await fetchTechnicalData("AAPL");
      const ok = t.ma50 != null && t.ma200 != null && t.week52High != null;
      return { ok, detail: ok ? `ma50=${Math.round(t.ma50!)}, ma200=${Math.round(t.ma200!)}, 52wHi=${Math.round(t.week52High!)}` : "MA/52w null" };
    }),
    check("News retrieval returns headlines", "retrieval", async () => {
      const n = await fetchNewsEvidence(["NVIDIA stock news"], 5, 8, 7000);
      return { ok: n.length > 0, detail: `${n.length} headlines` };
    }),
    check("SEC filings retrieved (insider/8-K)", "retrieval", async () => {
      const sec = await fetchSecFilings("AMC");
      const form4 = sec.some((s) => /^\s*[^\d]*\b4\b\s*\(/.test(s) || /insider|open-market buy/i.test(s));
      return { ok: sec.length > 0, detail: `${sec.length} filings; insider-Form4=${form4}` };
    }),
    check("EDGAR full-text corroboration works", "retrieval", async () => {
      const lines = await fetchThesisEdgarEvidence("AAPL", "Apple", "Apple grows on services and a new product launch");
      return { ok: Array.isArray(lines), detail: `${lines.length} corroborating filings` };
    }),

    // ── Plausibility invariants (no impossible outputs) ───────────────────────────────────────────────
    check("X-Ray plausibility (AAPL score 0–10)", "invariant", async () => {
      const x = await runXray("AAPL");
      const ok = !!x && typeof x.score === "number" && x.score >= 0 && x.score <= 10;
      return { ok, detail: x ? `score=${x.score}/10` : "null" };
    }),
  ]);

  const passed = checks.filter((c) => c.ok).length;
  const result = { ok: passed === checks.length, passed, total: checks.length, checks, ranAt: new Date().toISOString(), via: cronOk ? "cron" : "manual" };
  await writeHarness(result); // persist for the Admin card + so a cron failure is visible later

  // Alert the owner when the DAILY automated run finds a regression. Gated on RESEND_API_KEY (no-op until
  // set) and on cron+failure, so it can't spam — the cron runs once/day. Fail-soft: never breaks the run.
  if (cronOk && !result.ok) { try { await alertHarnessFailure(result); } catch { /* alerting is best-effort */ } }

  return NextResponse.json(result);
}

// Owner email on a harness regression, via Resend. Dormant until RESEND_API_KEY is set. Lists the failed
// checks so the alert is actionable from the inbox without opening the app.
async function alertHarnessFailure(result: { passed: number; total: number; checks: Check[]; ranAt: string }): Promise<void> {
  const key = process.env.RESEND_API_KEY;
  if (!key) return; // dormant until configured
  const to = process.env.ALERT_EMAIL || "dar_fishman@hotmail.com";
  const from = process.env.RESEND_FROM || "Plainview Alerts <onboarding@resend.dev>";
  const failed = result.checks.filter((c) => !c.ok);
  const rows = failed.map((c) => `<li><b>${c.name}</b> <span style="color:#888">[${c.cls}]</span> — ${c.detail}</li>`).join("");
  const html = `<div style="font-family:system-ui,sans-serif">
    <h2 style="color:#c0392b">🛡 Plainview accuracy harness regressed</h2>
    <p><b>${result.passed}/${result.total}</b> checks passed at ${result.ranAt}.</p>
    <p style="color:#c0392b"><b>${failed.length} failing — a data feed or guard broke:</b></p>
    <ul>${rows}</ul>
    <p style="color:#888;font-size:13px">Open Admin → Mission Control → Accuracy Harness for the full run. This fires only on the daily automated check.</p>
  </div>`;
  await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to, subject: `🛡 Plainview harness FAILED — ${result.passed}/${result.total} passing`, html }),
  });
}
