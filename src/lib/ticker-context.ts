// ════════════════════════════════════════════════════════════════════════════════════════════════
// ONE KNOWLEDGE SYSTEM — Slice 0 (buildTickerContext) + Slice 1 (Observation Log + derived Trajectory).
// See repo ONE-BRAIN.md. Layers kept distinct: FACTS (immutable daily observations) → HISTORY (derived,
// recomputed, never stored) → ... Trajectory is NOT a memory; it is difference(observations).
// Everything here is deterministic + $0 (no AI) and fully fail-soft (logging is non-critical infra).
// ════════════════════════════════════════════════════════════════════════════════════════════════
import { createClient } from "@supabase/supabase-js";
import { gatherSignals, readTickerMemory } from "@/lib/market-context";
import type { TickerMemory, TechnicalData, FilingFact } from "@/lib/market-context";

const BUCKET = "plainview-state";
const APP = process.env.NEXT_PUBLIC_APP_URL || "https://plainviewintel.com";
function admin() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
const todayUTC = () => new Date().toISOString().slice(0, 10);
const daysAgo = (d: string) => (Date.now() - new Date(d + "T00:00:00Z").getTime()) / 86400000;
const OBS_KEEP = 120; // raw daily window; older history gets rolled up by a later slice, never hard-discarded

// ─── GLOBAL per-ticker market observations (Facts layer; no user id = shared hive mind) ───────────────
export type TickerObservation = {
  d: string;                        // YYYY-MM-DD (one per calendar day)
  price: number | null;
  day: number | null;              // that day's % change
  volX: number | null;            // volume vs average
  ma: "above" | "below" | null;   // price vs 50-day
  ma200?: "above" | "below" | null;
  near52?: number | null;         // % up from 52-week low
  rsi?: number | null;
  score?: number | null;          // X-Ray score on that day
};
const obsKey = (t: string) => `_ticker_obs/${t.toUpperCase().replace(/[^A-Z0-9._-]/g, "")}.json`;

export async function loadTickerObservations(ticker: string): Promise<TickerObservation[]> {
  try {
    const { data, error } = await admin().storage.from(BUCKET).download(obsKey(ticker));
    if (error || !data) return [];
    const j = JSON.parse(await data.text());
    return Array.isArray(j?.obs) ? j.obs : [];
  } catch { return []; }
}

// Idempotent per calendar day: the first writer of the day wins; later callers (other users sweeping the
// SAME global ticker) see today already present and skip the write → ~one write/ticker/day at any user count.
export async function recordTickerObservation(ticker: string, o: Omit<TickerObservation, "d">): Promise<void> {
  try {
    const obs = await loadTickerObservations(ticker);
    const d = todayUTC();
    if (obs.length && obs[obs.length - 1].d === d) return;
    obs.push({ d, ...o });
    while (obs.length > OBS_KEEP) obs.shift();
    await admin().storage.from(BUCKET).upload(obsKey(ticker), JSON.stringify({ obs }), { upsert: true, contentType: "application/json" });
  } catch { /* fail-soft — non-critical */ }
}

// ─── PER-USER position P&L trajectory (Personal History; cost basis is private) ──────────────────────
export type PosObservation = { d: string; pnl: number };
const posTrajKey = (userId: string) => `${userId}/_postraj.json`;

export async function loadPositionTrajectory(userId: string): Promise<Record<string, PosObservation[]>> {
  try {
    const { data, error } = await admin().storage.from(BUCKET).download(posTrajKey(userId));
    if (error || !data) return {};
    const j = JSON.parse(await data.text());
    return (j && typeof j.tickers === "object" && j.tickers) ? j.tickers : {};
  } catch { return {}; }
}

export async function recordPositionObservations(userId: string, rows: Array<{ ticker: string; pnl: number }>): Promise<void> {
  if (!rows.length) return;
  try {
    const all = await loadPositionTrajectory(userId);
    const d = todayUTC();
    for (const r of rows) {
      const t = r.ticker.toUpperCase();
      const arr = all[t] || (all[t] = []);
      if (arr.length && arr[arr.length - 1].d === d) arr[arr.length - 1] = { d, pnl: r.pnl }; // refresh today
      else arr.push({ d, pnl: r.pnl });
      while (arr.length > OBS_KEEP) arr.shift();
    }
    await admin().storage.from(BUCKET).upload(posTrajKey(userId), JSON.stringify({ tickers: all }), { upsert: true, contentType: "application/json" });
  } catch { /* fail-soft */ }
}

// ─── GLOBAL earnings-date cache (Facts layer; last-known-good survives a throttled burst) ─────────────
// Finnhub's free calendar throttles when the whole watchlist fires at once, so a ticker's date can vanish
// from one reload to the next (the BB flicker). Once ANY load gets a real date we remember it here and
// serve it through throttled gaps — same date for everyone, no per-user copy. Self-heals: a fresh real
// fetch always overwrites. We never invent a date; absence stays absence.
export type CachedEarnings = { symbol: string; earningsDate: string | null; epsEstimate: number | null; revenueEstimate: number | null };
const earnKey = (sym: string) => `_earnings/${sym.toUpperCase().replace(/[^A-Z0-9._-]/g, "")}.json`;
const EARN_TTL_DAYS = 10; // how long a remembered date is trusted before we require a live confirm

export async function readCachedEarnings(symbol: string): Promise<CachedEarnings | null> {
  try {
    const { data, error } = await admin().storage.from(BUCKET).download(earnKey(symbol));
    if (error || !data) return null;
    const j = JSON.parse(await data.text());
    if (!j || !j.row || typeof j.at !== "string") return null;
    if (daysAgo(j.at.slice(0, 10)) > EARN_TTL_DAYS) return null;        // stale cache entry → ignore
    const row: CachedEarnings = j.row;
    if (!row.earningsDate) return null;
    // Don't resurrect a date that has already passed by more than a day — that report is done.
    if ((Date.now() - new Date(row.earningsDate).getTime()) / 86400000 > 1) return null;
    return row;
  } catch { return null; }
}

export async function writeCachedEarnings(row: CachedEarnings): Promise<void> {
  if (!row.earningsDate) return; // only cache real hits — never persist a blank
  try {
    await admin().storage.from(BUCKET).upload(earnKey(row.symbol), JSON.stringify({ at: new Date().toISOString(), row }), { upsert: true, contentType: "application/json" });
  } catch { /* fail-soft */ }
}

// ─── Derived signals (History/Evidence — recomputed at read time, NEVER stored) ──────────────────────
export type DrawdownTrend = { trend: "narrowing" | "widening" | "flat" | "new"; fromPnl?: number; deltaPts?: number; days?: number };

// Compare current P&L to the closest observation ≥ ~25 days old (else the oldest). "narrowing" = a loss that
// improved (less negative); "widening" = worsened. <3pt move = flat. <5 days of history = "new" (no claim).
export function deriveDrawdownTrend(history: PosObservation[] | undefined, currentPnl: number | null): DrawdownTrend {
  if (currentPnl == null || !history || !history.length) return { trend: "new" };
  const old = history.find((o) => daysAgo(o.d) >= 25) || history[0];
  const days = Math.round(daysAgo(old.d));
  if (days < 5) return { trend: "new" };
  const delta = currentPnl - old.pnl;
  if (Math.abs(delta) < 3) return { trend: "flat", fromPnl: old.pnl, deltaPts: delta, days };
  return { trend: delta > 0 ? "narrowing" : "widening", fromPnl: old.pnl, deltaPts: delta, days };
}

// The situation label — drawdown direction × momentum (3-month return) × winner/loser. Deterministic; the
// assessment must STATE it and trace it to numbers. Degrades gracefully before history exists (leans on momentum).
export type Situation = "recovering" | "rebounding" | "stabilizing" | "bleeding" | "extended" | "weak" | "holding" | "range-bound";
export function deriveSituation(dd: DrawdownTrend, ret3mo: number | null, pnl: number | null): Situation {
  const up = ret3mo != null && ret3mo >= 20;
  const down = ret3mo != null && ret3mo <= -20;
  const winner = pnl != null && pnl > 0;
  if (winner && up) return "extended";
  if (dd.trend === "narrowing") return up ? "recovering" : "stabilizing";
  if (dd.trend === "widening") return "bleeding";
  if (up && !winner) return "rebounding";   // momentum up, drawdown not yet confirmed narrowing
  if (down) return "weak";
  return winner ? "holding" : "range-bound";
}

// A short, grounded English fragment for prompts — carries the NUMBERS so the AI interprets, never invents.
export function trajectoryLine(dd: DrawdownTrend, currentPnl: number | null, ret1mo: number | null, ret3mo: number | null, situation: Situation): string {
  const parts: string[] = [];
  if ((dd.trend === "narrowing" || dd.trend === "widening") && dd.fromPnl != null) {
    parts.push(`drawdown ${dd.trend}: ${dd.fromPnl.toFixed(0)}% → ${currentPnl != null ? currentPnl.toFixed(0) + "%" : "now"} over ${dd.days}d`);
  } else if (dd.trend === "flat" && dd.fromPnl != null) {
    parts.push(`P&L flat over ~${dd.days}d`);
  }
  const mom: string[] = [];
  if (ret1mo != null) mom.push(`1mo ${ret1mo >= 0 ? "+" : ""}${ret1mo}%`);
  if (ret3mo != null) mom.push(`3mo ${ret3mo >= 0 ? "+" : ""}${ret3mo}%`);
  if (mom.length) parts.push(`momentum ${mom.join(" / ")}`);
  parts.push(`situation ${situation.toUpperCase()}`);
  return parts.join(" · ");
}

// ─── Slice 0: buildTickerContext — the shared FACTS primitive every surface will read (Slice 2 adopts it) ──
export type TickerContext = {
  ticker: string; asOf: string;
  name: string | null; sector: string | null; industry: string | null;
  score: number | null; scoreKind: string | null;
  rsi: number | null; ma50: number | null; ma200: number | null;
  marketTrend: string;                 // deterministic one-liner from technicals (+ price if given)
  observations: TickerObservation[];   // global daily history (Facts → History)
  memory: TickerMemory | null;         // accumulated per-ticker memory
  filingFacts: FilingFact[];           // structured DD from most recent 10-K/10-Q
};

function marketTrendLabel(ta: TechnicalData, price: number | null): string {
  const bits: string[] = [];
  if (ta.rsi != null) bits.push(ta.rsi >= 70 ? `overbought (RSI ${ta.rsi})` : ta.rsi <= 30 ? `oversold (RSI ${ta.rsi})` : `RSI ${ta.rsi}`);
  if (price != null && ta.ma50 != null && ta.ma200 != null) {
    const a50 = price > ta.ma50, a200 = price > ta.ma200;
    bits.push(a50 && a200 ? "above 50 & 200-day MA" : !a50 && !a200 ? "below 50 & 200-day MA" : "between 50 & 200-day MA");
    if (ta.ma50 < ta.ma200) bits.push("50-day below 200-day (longer-term caution)");
  }
  if (ta.avgVolume && ta.currentVolume) { const r = ta.currentVolume / ta.avgVolume; if (r >= 1.5) bits.push(`volume ${r.toFixed(1)}× avg`); }
  return bits.join(", ");
}

export async function buildTickerContext(ticker: string, opts?: { price?: number | null }): Promise<TickerContext> {
  const t = ticker.toUpperCase();
  const price = opts?.price ?? null;
  const [bundle, memory, observations, canonical] = await Promise.all([
    gatherSignals(t, { price, only: ["xray", "technicals", "financials", "earnings", "analyst", "profile", "filingFacts"] }),
    readTickerMemory(t).catch(() => null),
    loadTickerObservations(t),
    // CANONICAL score — the SEC-backed /api/xray card score, the single number every surface must agree on
    // (the lite gatherSignals score diverges, e.g. AMC 4.0 card vs 5.0 lite). Fail-soft → keep the lite score.
    fetch(`${APP}/api/xray/${encodeURIComponent(t)}?bg=1`).then((r) => (r.ok ? r.json() : null)).catch(() => null), // bg=1 → internal hydrate, don't log as user "X-Ray" usage
  ]);
  const ta = bundle.technicals;
  const xray = bundle.xray as ({ score?: number | null; scoreKind?: string | null } | null);
  const canon = canonical as ({ score?: number | null; scoreKind?: string | null } | null);
  const score = canon && typeof canon.score === "number" ? canon.score : (xray && typeof xray.score === "number" ? xray.score : null);
  const ctx: TickerContext = {
    ticker: t, asOf: bundle.asOf,
    name: bundle.profile.name, sector: bundle.profile.sector, industry: bundle.profile.industry,
    score, scoreKind: (canon?.scoreKind ?? xray?.scoreKind) ?? null,
    rsi: ta.rsi, ma50: ta.ma50, ma200: ta.ma200,
    marketTrend: marketTrendLabel(ta, price),
    observations, memory,
    filingFacts: bundle.filingFacts,
  };
  // Side-effect: contribute today's GLOBAL observation (idempotent per day). Every surface that builds
  // context grows the per-ticker history — the hive mind learns from organic use. Fire-and-forget.
  void recordTickerObservation(t, {
    price,
    day: null,
    volX: ta.avgVolume && ta.currentVolume ? +(ta.currentVolume / ta.avgVolume).toFixed(1) : null,
    ma: price != null && ta.ma50 != null ? (price > ta.ma50 ? "above" : "below") : null,
    ma200: price != null && ta.ma200 != null ? (price > ta.ma200 ? "above" : "below") : null,
    near52: price != null && ta.week52High && ta.week52Low ? +(((price - ta.week52Low) / (ta.week52High - ta.week52Low)) * 100).toFixed(0) : null,
    rsi: ta.rsi,
    score,
  });
  return ctx;
}
