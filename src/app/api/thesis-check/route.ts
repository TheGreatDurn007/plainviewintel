import Anthropic from "@anthropic-ai/sdk";
import { enforceAiQuota } from "@/lib/ai-quota";
import { logUsage } from "@/lib/usage-log";
import { recordSmartSpend } from "@/lib/ai-spend";
import { createClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import {
  gatherSignals,
  formatXray,
  formatFinancialSnapshot,
  formatTechnical,
  fetchRecentNews,
  buildInvestorContext,
  resolveResearchSymbol,
  buildNewsQueries,
  fetchNewsEvidence,
  fetchThesisEdgarEvidence,
  xrayOpposingFundamentals,
  classifyMining,
  buildMiningNewsQueries,
  computeCashRunway,
  MINING_LENS_FRAME,
  classifyBiotech,
  buildBiotechNewsQueries,
  BIOTECH_LENS_FRAME,
  isCryptoTicker,
  buildCryptoNewsQueries,
  CRYPTO_LENS_FRAME,
  isCommodityTicker,
  commodityName,
  buildCommodityNewsQueries,
  COMMODITY_LENS_FRAME,
  verifyClaims,
  type ThesisClaim,
  type ClaimEvidence,
  stripThinkBlocks,
  callCerebrasText,
  callGroqText,
  callGeminiText,
  formatFilingFacts,
  type InvestorProfile,
} from "@/lib/market-context";
import { getRequestUserId, recordSignalObservations, recordThesisEvaluation, recordPrediction, type ObservationInput } from "@/lib/nexus-memory";
import { getJudgmentModel } from "@/lib/ai-tier";
import { buildSignalBlock } from "@/lib/signal-labels";
import { loadTickerObservations } from "@/lib/ticker-context";
import { readTickerMemory, writeTickerMemory, buildMemoryContext } from "@/lib/market-context";
import { isFeatureAllowed } from "@/lib/tier";
import { buildScorecard, buildMagnitude, deriveVerdict, pointsToClaims, isLikelyDifferentCompany, type OpposingFact } from "@/lib/thesis-score";

export const maxDuration = 55;

type Point = { evidence: string; effect: string };
// NEXUS-THESIS §2.2 — the Logic pillar: does the conclusion follow from the evidence? The reconstructed
// causal chain + a 0-10 validity score + the weakest/missing link. Judgment (smart tier), rubric-constrained.
type LogicAssessment = { score: number; chain: string[]; weakestLink: string };
// §2.3 Magnitude — the catalyst's MATERIALITY to this company (judged); the band score is computed in code.
type Materiality = "transformational" | "significant" | "incremental" | "negligible";
// §5.1 Competing Explanation — the strongest ALTERNATIVE cause for the SAME facts, + the discriminator
// (the fact that would tell the thesis and the alternative apart = the real "what would change my mind").
type Competing = { explanation: string; discriminator: string };
type ThesisCheck = { status: string; points: Point[]; summary: string; logic?: LogicAssessment | null; materiality?: Materiality | null; competing?: Competing | null };

const cap = <T>(p: Promise<T>, ms: number, fallback: T): Promise<T> =>
  Promise.race([p, new Promise<T>((r) => setTimeout(() => r(fallback), ms))]);

// RECONCILIATION GUARD — a thesis can only be CONTRADICTED by a genuine disconfirming FACT, never by
// "no confirmation yet" (missing/UNKNOWN) or short-term PRICE action. The cheaper models sometimes
// collapse UNKNOWN+price into CONTRADICTION (e.g. TRX: only "stock dips" + absence-of-confirmation, no
// real negative → wrongly "contradicted"). Enforce the 3-state distinction (SUPPORTS/CONTRADICTS/UNKNOWN)
// deterministically: if a contradicted/unsupported verdict rests on NO genuine contradiction, downgrade
// to the honest state — mixed (some support) or insufficient (awaiting catalyst / too thin).
function reconcileStatus(v: ThesisCheck): ThesisCheck {
  const priceLike = /\b(dip|dips|dipped|fell|falls|fall|drop|dropped|decline[ds]?|sold[- ]off|sell[- ]?off|pull(?:ed|s)?[- ]back|slid|slips?|slumped|share price|stock price|stock (?:dips|fell|drop|slid|slips)|profit[- ]?tak|rally draws|price (?:falls?|drops?|slid|slips?))\b/i;
  if (v.status === "contradicted" || v.status === "unsupported") {
    const genuine = v.points.filter((p) => p.effect === "contradicts" && !priceLike.test(p.evidence));
    if (genuine.length > 0) return v;
    const supports = v.points.filter((p) => p.effect === "supports").length;
    const status = supports > 0 ? "mixed" : "insufficient";
    return { ...v, status };
  }
  if (v.status === "mixed") {
    const contradicts = v.points.filter((p) => p.effect === "contradicts");
    const genuine = contradicts.filter((p) => !priceLike.test(p.evidence));
    if (contradicts.length > 0 && genuine.length === 0) {
      const points = v.points.map((p) =>
        p.effect === "contradicts" && priceLike.test(p.evidence) ? { ...p, effect: "neutral" } : p
      );
      return { ...v, points };
    }
  }
  return v;
}

// ── POLARITY + CONFIRMATION GUARD (deterministic — runs on the POINTS before they reach the card) ─────
// The recurring credibility failure the owner keeps catching: a real, sourced, GOOD fact gets the wrong
// label and so reads as "unsupported" — e.g. BlackBerry "raised 2026 guidance after strong Q2" tagged
// CONTRADICTS (a guidance RAISE is bullish, it SUPPORTS a rally thesis). The LLM mis-buckets by topic
// ("guidance" is in the thesis's risk clause) without checking POLARITY (raised vs cut) or CONFIRMATION
// (a sourced, completed event vs an unverified downstream effect). The fix mirrors reconcileStatus /
// applyMagnitudeGuard: correct the obvious sign/confirmation errors in CODE so one mislabeled good fact
// can never drag the verdict down. Conservative by design — only flips on unambiguous, negation-free cues.
function thesisIsBullish(thesis: string, price: number | null, target: number | null): boolean {
  if (target && price && target > price * 1.01) return true;
  if (target && price && target < price * 0.99) return false;
  const bull = /\b(rally|rallies|rais(?:e|es|ing)|surg|soar|upside|higher|rise|rising|grow(?:th|ing)?|gain|moon|squeeze|breakout|appreciat|undervalued|multibagger|re-?rat|expand|beat|outperform|bull|long\b|accumulat|buy\b)\b/i;
  const bear = /\b(short\b|shorting|collaps|crash|declin|downside|overvalued|bubble|bankrupt|plunge|sink|bear\b|fade|deteriorat|sell\b|avoid|puts?\b|drop|plummet|worthless|fraud|scam|dilut|zero|chapter\s*11|insolven|default\b|going\s+to\s+(?:zero|0)|will\s+(?:fall|drop|crash|decline))\b/i;
  const isBull = bull.test(thesis), isBear = bear.test(thesis);
  if (isBear && !isBull) return false;
  if (isBull && !isBear) return true;
  return true;
}
// Unambiguous GOOD-NEWS catalysts (completed/confirmed), and a negation guard so "failed to win the deal"
// or "missed estimates" never trips them.
const GOOD_NEWS = /\b(rais(?:ed|es)\s+(?:[\w$%.,'-]+\s+){0,3}(?:guidance|outlook|forecast|target|estimate|revenue)|beat|beats|topp?ed|tops|exceed(?:ed|s)?|surpass(?:ed|es)?|record\s+(?:revenue|results|quarter|sales|earnings|backlog)|all-time high|win(?:s|ning)?\b|won\b|awarded|secur(?:ed|es)|signed?\b|approv(?:ed|al)|upgrad(?:ed|e)|above (?:consensus|estimates|expectations)|stronger[- ]than|better[- ]than[- ]expected|partnership|new\s+(?:contract|order|deal))\b/i;
const NEGATED = /\b(no\b|not\b|fail(?:ed|s|ure)?|miss(?:ed|es)?|without|denied|reject(?:ed|s)?|cut\b|cuts\b|lower(?:ed)?|slash(?:ed)?|short of|below|warn(?:ed|ing)?|delay(?:ed|s)?|loss\b|loses|declin(?:e|ed|ing)|weak(?:er)?|disappoint)\b/i;
// A point that cites a real dated source AND states a COMPLETED event (past-tense), with no forward modal —
// i.e. a confirmed catalyst that was wrongly filed as "missing" (which is for UNVERIFIED downstream effects).
const DATED_SOURCE = /\([^)]*\d{4}-\d{2}-\d{2}[^)]*\)\s*$/;
const COMPLETED = /\b(announced|rais(?:ed|es)|signed|won|secured|reported|posted|launched|beat|closed|completed|delivered|acquired|partnered|unveiled|landed|received|awarded|ramp(?:s|ed|ing)?|enter(?:s|ed|ing)|begin(?:s|ning)?|began|power(?:s|ing|ed)|open(?:s|ed|ing)|start(?:s|ed|ing)|expand(?:s|ed|ing)|scal(?:es|ed|ing)|ship(?:s|ped|ping)|go(?:es)?\s+live|in(?:to)?\s+(?:full\s+)?production)\b/i;
const FORWARD_MODAL = /\b(will|would|expected to|plans? to|aims? to|could|should|projected to|anticipat|set to|on track to|targeting|hopes? to|intends? to)\b/i;
// Speculative framing — a dated source can still wrap an UNsettled question ("analysts debate whether the
// ramp is real"). Don't treat these as confirmations; leave them "missing" (the safe default).
const SPECULATIVE = /\b(debate|whether|unclear|uncertain|rumou?r|speculat|alleg|reportedly|may|might|possibl|potential|question)\b/i;
function reconcilePoints(v: ThesisCheck, ctx: { thesis: string; price: number | null; target: number | null }): ThesisCheck {
  const bullish = thesisIsBullish(ctx.thesis, ctx.price, ctx.target);
  const points = v.points.map((p) => {
    const e = p.evidence;
    const negated = NEGATED.test(e);
    // (1) SIGN GUARD — a confirmed good-news catalyst can't be "contradicts" on a bullish thesis (BB bug).
    if (p.effect === "contradicts" && bullish && GOOD_NEWS.test(e) && !negated) {
      return { ...p, effect: "supports" };
    }
    // (2) CONFIRMATION GUARD — a sourced, COMPLETED event filed as "missing" (unverified) is actually a
    // confirmed fact → "supports". "missing" is only for unverified DOWNSTREAM effects ("will lift margins").
    if (p.effect === "missing" && DATED_SOURCE.test(e) && COMPLETED.test(e) && !FORWARD_MODAL.test(e) && !SPECULATIVE.test(e) && !negated) {
      return { ...p, effect: "supports" };
    }
    return p;
  });
  return { ...v, points };
}

// ── MAGNITUDE CHECK (deterministic, computed in code — NOT left to the LLM) ──────────────────────────
// The single biggest credibility hole: the price-target math (your target vs the current price vs the
// analyst consensus) was a judgment call the LLM made inconsistently — e.g. BB's "$13-14 target vs $4.88
// consensus" landed as a NEUTRAL blank dot. That comparison is pure arithmetic; code does it the same way
// every time. We (1) inject the exact math as an authoritative fact the LLM reasons with, and (2) enforce a
// floor on the verdict so a target far above every professional estimate can never be graded "supported".
function parseThesisTarget(thesis: string): number | null {
  // Pull a $ price or "$13-14" range from the thesis; a range → its midpoint. Plausible equity-price guard.
  const m = thesis.match(/\$\s?(\d+(?:\.\d+)?)(?:\s?(?:[-–—]|to)\s?\$?\s?(\d+(?:\.\d+)?))?/);
  if (!m) return null;
  const a = parseFloat(m[1]); const b = m[2] ? parseFloat(m[2]) : null;
  const v = b != null ? (a + b) / 2 : a;
  return Number.isFinite(v) && v > 0 ? v : null;
}
type Magnitude = { fact: string | null; point: Point | null; overreach: "none" | "above_fresh_high" };
function magnitudeCheck(opts: { thesis: string; price: number | null; target: number | null; analystMean: number | null; analystHigh: number | null }): Magnitude {
  const price = opts.price && opts.price > 0 ? opts.price : null;
  const target = opts.target && opts.target > 0 ? opts.target : parseThesisTarget(opts.thesis);
  if (!price || !target) return { fact: null, point: null, overreach: "none" };
  const pct = (a: number, b: number) => ((a - b) / b) * 100;
  const fmt = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(0)}%`;
  const tgtUp = pct(target, price); // the upside the thesis is actually betting on, from here — always valid
  const parts = [`MAGNITUDE CHECK (computed — use this exact arithmetic, do not recompute it): the thesis price target $${target.toFixed(2)} is ${fmt(tgtUp)} vs the current price $${price.toFixed(2)}.`];
  let overreach: Magnitude["overreach"] = "none";
  let point: Point | null = null;
  const mean = opts.analystMean && opts.analystMean > 0 ? opts.analystMean : null;
  const high = opts.analystHigh && opts.analystHigh > 0 ? opts.analystHigh : null;
  if (mean) {
    const consVsPrice = pct(mean, price);
    // STALE-CONSENSUS GUARD: if the stock already trades ABOVE consensus, analysts are LAGGING the move —
    // consensus is a weak yardstick, NOT downside evidence. Judge the target on the catalyst, not consensus.
    if (consVsPrice < -3) {
      parts.push(`NOTE: the analyst consensus $${mean.toFixed(2)} sits ${fmt(consVsPrice)} BELOW the current price — the stock has already run past consensus, so analysts appear to LAG the recent move. Treat consensus as a weak reference here, NOT as downside. Judge the ${fmt(tgtUp)} target on the strength of the CATALYST/news evidence, not on the stale consensus.`);
      point = { evidence: `Analyst consensus $${mean.toFixed(2)} is below the current $${price.toFixed(2)} — analysts lag the recent move, so consensus is a weak yardstick; the $${target.toFixed(2)} target (${fmt(tgtUp)}) hinges on the catalyst, not consensus (computed)`, effect: "neutral" };
    } else {
      const tgtVsCons = pct(target, mean);
      parts.push(`The analyst consensus $${mean.toFixed(2)} is ${fmt(consVsPrice)} vs price (analysts current — price has not run past them), so the target sits ${fmt(tgtVsCons)} ${tgtVsCons >= 0 ? "ABOVE" : "below"} consensus${high ? `; the most bullish analyst target is $${high.toFixed(2)}` : ""}.`);
      if (high && target > high * 1.02) {
        // Analysts are CURRENT and even the most bullish doesn't reach the target → genuine caution.
        overreach = "above_fresh_high";
        point = { evidence: `Thesis target $${target.toFixed(2)} is above even the most bullish analyst target $${high.toFixed(2)}, and analysts are current (the stock hasn't run past them) — no professional estimate reaches this price (computed)`, effect: "contradicts" };
      } else if (tgtVsCons > 60) {
        point = { evidence: `Thesis target $${target.toFixed(2)} is ${fmt(tgtVsCons)} above the $${mean.toFixed(2)} analyst consensus — ambitious vs current professional estimates (computed)`, effect: "neutral" };
      } else if (target <= mean * 1.05) {
        point = { evidence: `Thesis target $${target.toFixed(2)} (${fmt(tgtUp)}) is within the analyst consensus $${mean.toFixed(2)} — the magnitude is supported by professional estimates (computed)`, effect: "supports" };
      }
    }
  }
  return { fact: parts.join(" "), point, overreach };
}
// Always surface the computed magnitude point (never a blank dot). Only a target above EVERY CURRENT
// analyst (analysts not lagging) softly caps the verdict — a stale consensus never penalizes the thesis.
function applyMagnitudeGuard(v: ThesisCheck, mag: Magnitude): ThesisCheck {
  if (!mag.point) return v;
  // Drop any LLM point that's loosely about the same target/consensus math, then prepend the computed one.
  const dupy = /\b(target|consensus|upside|downside|price target)\b/i;
  const kept = v.points.filter((p) => !(dupy.test(p.evidence) && /\$\d/.test(p.evidence)));
  const points = [mag.point, ...kept].slice(0, 6);
  // Only a fresh (non-lagging) consensus where the target tops even the most bullish analyst caps "supported".
  let status = v.status;
  if (mag.overreach === "above_fresh_high" && status === "supported") status = "mixed";
  return { ...v, points, status };
}

// Derive a 0-10 strength score from the verdict, for the thesis-evolution timeline ("strength +14%").
// Base from the status, nudged by the net of supporting vs contradicting evidence points. "insufficient"
// has no score (we genuinely can't judge strength). Honest, derived — not an invented number.
function strengthFromVerdict(v: ThesisCheck): number | null {
  const base: Record<string, number | null> = { supported: 7.5, mixed: 5, contradicted: 2.5, unsupported: 1.5, insufficient: null };
  const b = base[v.status];
  if (b == null) return null;
  const net = v.points.filter((p) => p.effect === "supports").length - v.points.filter((p) => p.effect === "contradicts").length;
  return Math.round(Math.max(0, Math.min(10, b + net * 0.5)) * 10) / 10;
}

// ---- Shared verdict cache (Supabase Storage) ----
// A thesis-check must return the SAME verdict when re-run (Recheck), or it looks broken. The
// evidence (Google News) rotates and serverless instances don't share memory, so we cache the
// finished verdict in Storage (shared across all instances) for 24h. Fail-open: any Storage
// error just falls through to a normal compute.
const THESIS_CACHE_TTL = 24 * 60 * 60 * 1000; // 24h — a thesis verdict doesn't change intraday, so rechecks stay STABLE across a day (kills flicker); a genuinely new thesis re-keys, and the monitor re-evaluates on new evidence
const CACHE_BUCKET = "plainview-state";
// Bump this whenever the thesis-check prompt, lenses, or claim engine change, so old cached verdicts
// (computed by the previous logic) are not served. Acts as a global cache-buster.
const CACHE_VERSION = "v43"; // v43: bear-thesis detection, news-unavailable sentinel, improved query stop words
function hashStr(s: string): string { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return (h >>> 0).toString(36); }
function storageAdmin() { return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } }); }
async function readVerdictCache(key: string): Promise<(Record<string, unknown> & { _ts?: number }) | null> {
  try {
    const { data, error } = await storageAdmin().storage.from(CACHE_BUCKET).download(key);
    if (error || !data) return null;
    return JSON.parse(await data.text());
  } catch { return null; }
}
async function writeVerdictCache(key: string, obj: Record<string, unknown>): Promise<void> {
  try {
    const blob = new Blob([JSON.stringify({ ...obj, _ts: Date.now() })], { type: "application/json" });
    await storageAdmin().storage.from(CACHE_BUCKET).upload(key, blob, { upsert: true, contentType: "application/json" });
  } catch { /* fail-open */ }
}

function extractCheck(raw: string): ThesisCheck | null {
  let cleaned = stripThinkBlocks(raw).replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start >= 0 && end > start) cleaned = cleaned.slice(start, end + 1);
  try {
    const j = JSON.parse(cleaned) as Record<string, unknown>;
    const rawPts = Array.isArray(j.points) ? (j.points as Record<string, unknown>[]) : [];
    const points: Point[] = rawPts
      // Drop any "Headline:"/"News:"/"Source:" prefix so every fact reads cleanly (just the fact + its
      // dated source), regardless of how the model phrased it — consistent, GRSL-style presentation.
      .map((p) => ({ evidence: String(p.evidence || "").trim().replace(/^["']?\s*(?:headline|news|source|fact|report)\s*:\s*/i, ""), effect: String(p.effect || "neutral").toLowerCase().trim() }))
      .filter((p) => p.evidence)
      .slice(0, 6);
    const status = String(j.status || "").toLowerCase().trim();
    const valid = ["supported", "mixed", "contradicted", "unsupported", "insufficient"];
    // Logic pillar (§2.2) — optional structured block: the causal chain + a 0-10 validity score.
    let logic: LogicAssessment | null = null;
    const lj = j.logic as Record<string, unknown> | undefined;
    if (lj && typeof lj === "object") {
      const sc = Number(lj.score);
      const chain = Array.isArray(lj.chain) ? (lj.chain as unknown[]).map((s) => String(s || "").trim()).filter(Boolean).slice(0, 6) : [];
      if (Number.isFinite(sc) && chain.length) {
        logic = { score: Math.max(0, Math.min(10, Math.round(sc * 10) / 10)), chain, weakestLink: String(lj.weakestLink || lj.weakest_link || "").trim() };
      }
    }
    // Materiality (§2.3) — judged input to the deterministic Magnitude band.
    const matRaw = String(j.materiality || "").toLowerCase().trim();
    const materiality = (["transformational", "significant", "incremental", "negligible"] as const).find((m) => matRaw.includes(m)) ?? null;
    // Competing Explanation + discriminator (§5.1).
    let competing: Competing | null = null;
    const cj = j.competing as Record<string, unknown> | undefined;
    if (cj && typeof cj === "object") {
      const explanation = String(cj.explanation || "").trim();
      const discriminator = String(cj.discriminator || "").trim();
      if (explanation) competing = { explanation, discriminator };
    }
    return {
      status: valid.includes(status) ? status : "mixed",
      points,
      summary: String(j.summary || "").trim(),
      logic,
      materiality,
      competing,
    };
  } catch {
    return null;
  }
}

async function runAI(prompt: string): Promise<ThesisCheck | null> {
  // TEMP 0 = fully greedy/deterministic decoding — the same prompt+evidence yields the SAME verdict
  // every time, so a thesis-check never flickers between supported/mixed/contradicted on a re-run.
  const TEMP = 0;

  // FREE CASCADE FIRST — Cerebras→Groq→Gemini handle thesis verdicts well at $0.
  // Anthropic Haiku is the emergency-only fallback if all free providers fail.
  if (process.env.CEREBRAS_API_KEY) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try { const v = extractCheck(await callCerebrasText(prompt, TEMP)); if (v) return v; } catch { /* retry, then fall through */ }
    }
  }
  if (process.env.GROQ_API_KEY) {
    try { const v = extractCheck(await callGroqText(prompt, TEMP)); if (v) return v; } catch { /* fall through */ }
  }
  if (process.env.GEMINI_API_KEY) {
    try { const v = extractCheck(await callGeminiText(prompt, TEMP)); if (v) return v; } catch { /* fall through */ }
  }
  // Smart model fallback (Sonnet/Opus if configured, else Haiku) — only fires when all free providers failed.
  const smart = await getJudgmentModel();
  if (process.env.ANTHROPIC_API_KEY) {
    const model = smart || "claude-haiku-4-5-20251001";
    try {
      const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: 30000 });
      const res = await anthropic.messages.create({
        model,
        max_tokens: 900,
        temperature: TEMP,
        messages: [{ role: "user", content: prompt }],
      });
      const raw = res.content.filter((b) => b.type === "text").map((b) => (b as unknown as { text: string }).text).join("");
      const v = extractCheck(raw);
      if (v) { if (smart) void recordSmartSpend(smart, res.usage?.input_tokens || 0, res.usage?.output_tokens || 0); return v; }
    } catch { /* all providers exhausted */ }
  }
  return null;
}

// Server-side morning sweep auth: the daily-brief cron re-scores a user's holdings on their behalf
// (no session). It proves authority with the CRON_SECRET and names the user via x-cron-user. When
// present + valid, this userId is used for the per-user ledger write (instead of the cookie session),
// and the paid gate is bypassed (the sweep is a system action). Belt-and-suspenders: returns null
// unless the secret matches exactly, so a forged header can never attribute a write to someone else.
function cronUserOverride(request: Request): string | null {
  const secret = process.env.CRON_SECRET;
  if (!secret) return null;
  const got = request.headers.get("x-cron-secret");
  const user = request.headers.get("x-cron-user");
  return got && got === secret && user ? user : null;
}

export async function POST(request: Request) {
  let body: {
    ticker?: string;
    name?: string;
    thesis?: string;
    price?: number | string | null;
    status?: string;
    xrayScore?: string | number | null;
    liveSignals?: string | null;
    currency?: string | null;
    exchange?: string | null;
    investorProfile?: InvestorProfile | null;
    priorKnowledge?: string | null;
    catalyst?: string | null;
    claimVerify?: boolean | null;
    target?: number | string | null; // Decide's price target → records a falsifiable P1 prediction
  };
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Invalid request" }, { status: 400 }); }

  const rawTicker = body.ticker || "";
  // Resolve the RIGHT listing — a CAD/TSX ticker can collide with a US security (USA fund vs
  // Americas Gold & Silver), so use currency/exchange to pick the Canadian symbol when needed.
  const ticker = await resolveResearchSymbol(rawTicker, { currency: body.currency, exchange: body.exchange }).catch(() => rawTicker);
  const thesis = (body.thesis || "").trim();
  if (!ticker) return NextResponse.json({ error: "Ticker required" }, { status: 400 });
  if (!thesis) return NextResponse.json({ error: "No thesis to test — write a thesis first." }, { status: 400 });

  // "Track free, judgment paid" — the thesis verdict IS the paid judgment. Enforced server-side so it can't
  // be bypassed by calling the API directly. No-op while PAID_GATING_ENABLED is off (owner always allowed).
  // The morning sweep (cron, system action) bypasses the gate — it must refresh every user's ledger.
  const sweepUserId = cronUserOverride(request);
  if (!sweepUserId && !(await isFeatureAllowed("thesis"))) {
    return NextResponse.json({ error: "Thesis pressure-testing is a Pro feature.", upgrade: true }, { status: 402 });
  }

  // Shared verdict cache: a re-check within 30 min returns the SAME result (stable + fast). Keyed by
  // the resolved ticker + the EXACT thesis + catalyst text (so a different thesis for the same
  // ticker — QNX growth vs cyber turnaround vs squeeze — never reuses another's verdict) + an engine
  // version (bump CACHE_VERSION when the prompt/lenses/claim engine change, to invalidate old cache).
  const claimOn = process.env.CLAIM_VERIFY === "on" || body.claimVerify === true;
  const cacheKey = `_thesis-cache/${CACHE_VERSION}/${ticker.toUpperCase()}_${hashStr(thesis + "|" + (body.catalyst || "") + "|" + (claimOn ? "cv" : "nocv"))}.json`;
  const forceRefresh = (body as { refresh?: boolean }).refresh === true;
  const cachedVerdict = forceRefresh ? null : await readVerdictCache(cacheKey);
  if (cachedVerdict && typeof cachedVerdict._ts === "number" && Date.now() - cachedVerdict._ts < THESIS_CACHE_TTL) {
    return NextResponse.json({ ...cachedVerdict, _cached: true });
  }
  // Only a real (uncached) verdict calls the LLM, so only that counts against the daily AI cap. A
  // retrieval-only debug call (no LLM) must NOT burn quota — skip the meter for it.
  const _retrievalOnlyDebug = (body as { debug?: boolean }).debug === true && (body as { retrievalOnly?: boolean }).retrievalOnly === true;
  if (!_retrievalOnlyDebug) {
    const _quota = await enforceAiQuota(); if (_quota) return _quota;
    // Only a real USER action counts as "Decide" usage. The cron sweep (sweepUserId set) re-scores every
    // holding server-to-server with no cookie — logUsage would tag it "anonymous" and flood the live
    // activity feed + inflate the Decide count with the system talking to itself. Skip it for sweeps so
    // both the activity feed and founder analytics stay honest (real users only).
    if (!sweepUserId) void logUsage("decide");
  }

  const price = body.price != null && body.price !== "" ? Number(body.price) : null;

  // Load ticker memory in parallel with signals — what NEXUS has previously observed/written about
  // this ticker (SEC risk flags, prior brief context, classified signals). Fail-soft: a missing memory
  // file is normal for tickers we haven't seen before. Fires and waits alongside gatherSignals so it
  // adds no latency to the critical path.
  const [signals, tickerMemory] = await Promise.all([
    gatherSignals(ticker, { price, name: body.name }),
    readTickerMemory(ticker).catch(() => null),
  ]);

  // ---- LEVEL 1: the FACTS (ground truth) ----
  // NEXUS step 3: every per-ticker fact comes from the ONE canonical signal store (gatherSignals),
  // tagged with source + as-of date, so thesis-check, intel and X-Ray all read the SAME truth and
  // can never disagree. (Lens detection, name-based news top-up, and claim verification below stay
  // here — they are thesis-check-specific layers on top of the shared signals.)
  const {
    xray, financials, technicals: ta, description: desc, baseNews: news,
    secFilings: secLines, secSignals, filingFacts, earnings, analyst, btc, profile: prof,
  } = signals;
  let businessLine = desc ? `Business: ${desc}` : null;
  let resolvedName: string | null = body.name || prof.name || null;
  if (!desc && (prof.name || prof.sector)) {
    resolvedName = prof.name || resolvedName;
    businessLine = `Business: ${prof.name || rawTicker}${prof.sector || prof.industry ? ` — ${[prof.sector, prof.industry].filter(Boolean).join(" / ")}` : ""} (research symbol ${ticker})`;
  }

  // ── IDENTITY GUARD (deterministic, pre-LLM) ──────────────────────────────────────────────────────
  // The user's holding KNOWS its company (body.name). If the data resolved to a clearly DIFFERENT company
  // (a ticker collision across exchanges resolved the wrong listing — MAG=Magnite vs MAG Silver), do NOT
  // analyze the wrong company and present it as truth. Flag it honestly so the user re-checks the listing.
  // Skips the LLM entirely (cheaper) and is the robust catch-all behind any flaky symbol/profile resolution.
  if (body.name && prof.name && isLikelyDifferentCompany(body.name, prof.name)) {
    const mismatchCard = {
      evidence: 0, evidenceBacked: 0, evidenceTotal: 0, contradiction: 10,
      verdict: "Insufficient — possible wrong listing",
      criticalUnknownType: null as string | null,
      criticalUnknown: `The data we found is for "${prof.name}", but your holding is "${body.name}". Ticker "${rawTicker}" likely collides with another company across exchanges, so we may have pulled the wrong listing — this thesis can't be safely verified against the right company. Re-check with the exact exchange/listing.`,
      claims: [] as { raw: string; type: string; verified: boolean; source: string | null }[],
      opposing: [] as string[], coreVerified: false, engine: "phase1" as const,
    };
    return NextResponse.json({
      ticker, status: "insufficient", points: [],
      summary: `Possible wrong listing: the data resolved to "${prof.name}", not "${body.name}".`,
      scorecard: mismatchCard, checkedAt: new Date().toISOString(),
    });
  }
  // Now that we have the resolved company name, top up news with a name-based search and merge.
  const baseSymbol = ticker.replace(/[.\-].*$/, "").toUpperCase();
  const allNews = resolvedName && resolvedName.toUpperCase() !== baseSymbol
    ? [...new Map([...news, ...await fetchRecentNews(resolvedName).catch(() => [] as string[])].map(l => [l.slice(0, 40), l])).values()]
    : news;

  // Asset-type lens: miners and clinical-stage biotechs need different framing than general
  // equities. Detect conservatively; mining takes priority if a name somehow matches both.
  const mining = classifyMining({ name: resolvedName, sector: prof.sector, industry: prof.industry, description: desc });
  const biotech = !mining.isMining && classifyBiotech({ name: resolvedName, sector: prof.sector, industry: prof.industry, description: desc }).isBiotech;
  // Ticker-collision guard: a bare ticker like "TRX" matches a crypto (TRON) AND a stock (TRX Gold).
  // If the listing is clearly an equity — an exchange suffix (.TO/.V/...), a stock exchange tag, or a
  // real-equity sector from the profile — it is NOT crypto, regardless of the symbol match. This stops
  // the crypto lens + crypto news queries from polluting a stock's evidence with the wrong company.
  const looksLikeStockListing =
    /\.(TO|V|NE|CN|L|AX|HK|TG|F|DE|PA|MI|MC|ST|HE|OL|VI|SW)$/i.test(ticker) ||
    /\b(TSX|TSXV|TSX-V|NYSE|NASDAQ|AMEX|OTC|LSE|ASX|NEO|CSE|XETRA)\b/i.test(String(body.exchange || "")) ||
    /(basic materials|gold|silver|mining|industrials|technology|healthcare|energy|financial|consumer|utilities|real estate|communication)/i.test(String(prof.sector || ""));
  const crypto = !mining.isMining && !biotech && !looksLikeStockListing && (isCryptoTicker(rawTicker) || isCryptoTicker(ticker));
  const commodity = !mining.isMining && !biotech && !crypto && (isCommodityTicker(rawTicker) || isCommodityTicker(ticker));
  if (commodity && !resolvedName) resolvedName = commodityName(ticker) || commodityName(rawTicker) || resolvedName;

  // Live news evidence — verifies "easily-Googleable" thesis claims (partnerships,
  // acquisitions, order wins, earnings figures) that the structured feed misses,
  // especially for foreign/small-cap names (TSX/TSXV) where SEC/EDGAR is skipped.
  // For miners/biotechs, add targeted catalyst queries (drill/assay/resource, or trial/FDA).
  const lensQueries = mining.isMining
    ? buildMiningNewsQueries(resolvedName, ticker, mining.commodity)
    : biotech
    ? buildBiotechNewsQueries(resolvedName, ticker)
    : crypto
    ? buildCryptoNewsQueries(resolvedName, ticker)
    : commodity
    ? buildCommodityNewsQueries(resolvedName, ticker)
    : [];
  // General/catalyst queries FIRST (always relevant), lens queries (drill/assay/PEA — useful for an
  // explorer, useless for a streamer/producer) LAST, so baseline coverage runs before the niche ones.
  const newsQueries = [...buildNewsQueries(resolvedName, ticker, thesis), ...lensQueries];
  // No external cap — fetchNewsEvidence self-budgets (6.5s) and returns PARTIAL results, so a slow query
  // can never nuke the whole set to [] (the WPM "0 news" bug). Per-fetch AbortTimeout bounds total time.
  const newsEvidence = await fetchNewsEvidence(newsQueries, 5, 8, 6500);

  // DATE-AGNOSTIC EDGAR full-text corroboration — the 30-day fetchSecSignals window + recent-news-only
  // retrieval miss a catalyst the thesis still rests on but that was FILED MONTHS AGO (e.g. Infleqtion's
  // Feb-2026 government-grant 8-Ks judged against a June thesis → wrongly "no source confirms"). This
  // searches the company's full filing history for the thesis's catalyst noun and surfaces the confirming
  // tier-1 filing regardless of age. Ungated, capped, fail-open, $0.
  const secCorroboration = await cap(
    fetchThesisEdgarEvidence(ticker, resolvedName, thesis),
    6000,
    [] as string[]
  );

  // RETRIEVAL-ONLY DEBUG (body.debug && body.retrievalOnly) — return EXACTLY what each retrieval layer
  // produced and SKIP the LLM entirely. This makes a retrieval-audit sweep fast, free, and immune to
  // LLM rate-limits (the dominant accuracy failure is retrieval, so auditing it shouldn't depend on the
  // verdict call). Backend-only; never cached.
  if ((body as { debug?: boolean }).debug === true && (body as { retrievalOnly?: boolean }).retrievalOnly === true) {
    return NextResponse.json({ ticker, _debug: {
      resolvedTicker: ticker, resolvedName, mining: { isMining: mining.isMining, commodity: mining.commodity }, biotech, crypto,
      analystMean: analyst.mean ?? null, newsQueries, allNews,
      newsEvidence: newsEvidence.map((n) => `${n.title}${n.source ? ` — ${n.source}` : ""}`),
      secLines, secCorroboration,
      hasXray: !!xray, hasFinancials: !!(financials && (financials.revenueGrowth != null || financials.grossMargins != null)),
      earnings, financialsRaw: financials,
    }, checkedAt: new Date().toISOString() });
  }

  // Claim-level verification (Phase 1, gated). Extracts the thesis's specific factual claims and
  // fetches targeted per-claim evidence so the model can classify each (Verified/Contradicted/
  // Forecast/Unverified/Weak-Source). Additive + FAIL-OPEN: any error leaves thesis-check exactly
  // as it is without this layer. Enabled by env CLAIM_VERIFY=on, or per-request for testing.
  const claimFlag = (process.env.CLAIM_VERIFY || "").trim().toLowerCase();
  const claimVerifyOn = claimFlag === "on" || claimFlag === "true" || claimFlag === "1" || body.claimVerify === true;
  let claimBlock: string | null = null;
  let extractedClaims: ThesisClaim[] = [];
  // The scorecard now scores from the LLM's evidence POINTS directly (one source of truth), so the separate
  // claim-decomposition only runs when explicitly testing claim-verification (claimVerifyOn) — its text block
  // feeds the LLM extra per-claim evidence. Gated → no wasted fetch/extraction on a normal request. Fail-open.
  if (claimVerifyOn) {
    try {
      const cv = await cap(
        verifyClaims({ thesis, catalyst: body.catalyst ?? null, name: resolvedName, ticker }),
        12000,
        { block: null, claims: [] as ThesisClaim[], evidence: [] as ClaimEvidence[] }
      );
      claimBlock = cv.block;
      extractedClaims = cv.claims;
    } catch { /* fail-open: claim layer is a bonus, never required */ }
  }

  const facts: string[] = [];
  // Anchor in real time so the model can tell a claimed period/event hasn't been reported yet.
  facts.push(`Today's date: ${new Date().toISOString().slice(0, 10)}. Use it to judge whether any claimed result or event could already have been reported as of now.`);
  if (businessLine) facts.push(businessLine);
  if (price) facts.push(`Current price: $${price}`);
  if (body.xrayScore) facts.push(`Plainview X-Ray financial-health score: ${body.xrayScore} (use exactly as given)`);
  if (xray) { const fx = formatXray(xray); if (fx) facts.push(`Fundamentals (SEC EDGAR + Yahoo):\n${fx}`); }
  if (financials) { const ff = formatFinancialSnapshot(financials); if (ff) facts.push(`Financials:\n${ff}`); }
  if (mining.isMining || biotech) {
    const runway = computeCashRunway(financials.totalCash, financials.operatingCashflow);
    if (runway) facts.push(runway);
  }
  const taBlock = formatTechnical(ta as Parameters<typeof formatTechnical>[0], price);
  if (taBlock) facts.push(`Technicals (incl. RSI, moving averages, short interest):\n${taBlock}`);
  if (body.liveSignals) facts.push(`Momentum: ${body.liveSignals}`);
  // NEXUS ticker memory — what the hive mind has previously observed + classified about this ticker
  // (SEC risk flags, prior brief summaries, insider patterns). Context only: AI-derived content is
  // labeled as such and never promoted to Tier-1 evidence (evidence-hierarchy law).
  if (tickerMemory) { const mc = buildMemoryContext(tickerMemory); if (mc) facts.push(mc); }
  // NEXUS signal block — same deterministic labels as Intel Brief so every surface agrees.
  // Financial standing (score → STRONG/WEAK/etc), business trend (observation log), price action
  // (MA position, slope, RSI, volume). Pre-interpreted so the AI reports what the data shows.
  try {
    const _obs = await loadTickerObservations(ticker).catch(() => []);
    const _scoreNum = (() => { const n = parseFloat(String(body.xrayScore ?? "")); return Number.isFinite(n) ? n : null; })();
    const _sb = buildSignalBlock({ score: _scoreNum, technicals: ta as import("@/lib/market-context").TechnicalData, currentPrice: price, observations: _obs });
    if (_sb) facts.push(`NEXUS signal block (deterministic context — NOT standalone evidence for a specific claim):\n${_sb}`);
  } catch { /* fail-soft */ }
  if (analyst.mean) {
    const staleNote = analyst.stale ? " — ⚠ price already above consensus, may be lagging recent upgrades" : "";
    facts.push(`Analyst consensus: $${analyst.mean.toFixed(2)}${analyst.high ? ` (high $${analyst.high.toFixed(2)})` : ""}${staleNote}`);
  }
  // DETERMINISTIC magnitude check — compute the target-vs-price-vs-consensus math in code and inject it as
  // an authoritative fact so the LLM reasons with the exact numbers (the BB "$13-14 vs $4.88" blank-dot bug).
  // The target the user STATES in the thesis is the claim being graded — it takes precedence over the
  // structured d-target field (which can go stale, e.g. left at an AI-suggested value after the user edits
  // the thesis text). Fall back to the field only when the thesis prose names no price. Keeps plausibility
  // honest: change "$12.50" to "$35.5" in your thesis and the %/yr move recomputes accordingly.
  const _targetForMag = (() => {
    const fromText = parseThesisTarget(thesis);
    if (fromText && fromText > 0) return fromText;
    const n = typeof body.target === "number" ? body.target : parseFloat(String(body.target ?? ""));
    return Number.isFinite(n) && n > 0 ? n : null;
  })();
  const mag = magnitudeCheck({ thesis, price, target: _targetForMag, analystMean: analyst.mean ?? null, analystHigh: analyst.high ?? null });
  if (mag.fact) facts.push(mag.fact);
  if (earnings) facts.push(`Next earnings: ${earnings}`);
  if (allNews.length) facts.push(`Recent headlines:\n${allNews.slice(0, 6).map((h) => `- ${h}`).join("\n")}`);
  if (!allNews.length && !newsEvidence.length) facts.push("NEWS: no headlines could be retrieved — news sources may be temporarily unavailable. Base your assessment on the other evidence (filings, financials, technicals). Do NOT interpret empty news as 'no developments'.");
  if (newsEvidence.length) {
    facts.push(
      `Live published news (real article headlines retrieved just now from Google News — these ARE published evidence; a headline that states a claim verifies it):\n${newsEvidence
        .map((n) => `- "${n.title}"${n.source ? ` — ${n.source}` : ""}${n.ts ? ` (${new Date(n.ts).toISOString().slice(0, 10)})` : ""}`)
        .join("\n")}`
    );
  }
  if (secLines.length) facts.push(`Recent SEC filings:\n${secLines.slice(0, 4).map((s) => `- ${s}`).join("\n")}`);
  const filingFactLines = formatFilingFacts(filingFacts);
  if (filingFactLines.length) facts.push(filingFactLines.join("\n"));
  if (secCorroboration.length) facts.push(`EDGAR full-text corroboration (TIER-1 — official filings matching the thesis's catalyst, searched across the company's FULL filing history regardless of date; a filing here confirms the catalyst's subject is real even if it is months old and absent from recent news):\n${secCorroboration.map((s) => `- ${s}`).join("\n")}`);
  if (btc) facts.push(`Live macro reference — Bitcoin spot: $${Math.round(btc).toLocaleString("en-US")} (use only if crypto-exposed; never cite a crypto price from memory)`);
  if (claimBlock) facts.push(claimBlock);

  const investorCtx = buildInvestorContext(body.investorProfile ?? null);

  const prompt = `You are Plainview, a disciplined analyst stress-testing an investment thesis.${investorCtx ? `\n\n${investorCtx}` : ""}

THE FACTS ARE THE SOURCE OF TRUTH. The thesis below is a HYPOTHESIS to test against those facts — NEVER something to confirm. A professional investor spends more effort trying to KILL a thesis than to prove it; a single hard counter-fact can invalidate a case. If the facts do not support the thesis, say so explicitly and without hedging.

THE THESIS (hypothesis under test):
"${thesis}"
${resolvedName ? `\nThe ticker the investor holds is "${rawTicker}" and the company is "${resolvedName}". CRITICAL IDENTITY CHECK: if the FACTS below clearly describe a DIFFERENT company than "${resolvedName}" (a ticker collision — e.g. the business, sector, or filings are for an unrelated entity), do NOT grade the thesis. Return status "insufficient" and say plainly that the data appears to be for the wrong listing, so the thesis can't be verified against the right company.` : ""}

THE FACTS (ground truth — Level 1, highest authority):
${facts.join("\n\n") || "No facts retrieved — say so and return status insufficient."}
${body.priorKnowledge ? `\nPLAINVIEW'S OWN EARLIER NOTES (context only — NOT evidence):\nThese are Plainview-generated summaries (prior Intel/X-Ray briefs and filing explanations), not independent sources. Use them ONLY to understand what was previously discussed. NEVER cite them as a fact, and NEVER let them support or refute the thesis — that would be circular (Plainview proving Plainview). Every evidence point you cite must come from THE FACTS above, not from these notes.\n${body.priorKnowledge}` : ""}

${mining.isMining ? `${MINING_LENS_FRAME}\n\n` : biotech ? `${BIOTECH_LENS_FRAME}\n\n` : crypto ? `${CRYPTO_LENS_FRAME}\n\n` : commodity ? `${COMMODITY_LENS_FRAME}\n\n` : ""}Test the thesis against the facts. Pull 3-5 SPECIFIC evidence points (each with its real number/detail), and tag each by how it relates to THIS thesis. FORMAT each evidence point as the plain fact followed by its source and date in parentheses — e.g. \`GR Silver reports 45.1m at 1,623 g/t Ag at San Marcial (Newswire, 2026-05-19)\`. Do NOT prefix a point with "Headline:", "News:", or "Source:".
- "supports" — a real, sourced fact that backs the thesis, INCLUDING a confirmed-but-announced/planned/in-progress catalyst. If a source confirms the thesis's catalyst EXISTS (a facility announced, a deal signed, a partnership, a metric, a filing), that is "supports" — cite it (note "announced/planned" if it hasn't completed yet). Do NOT downgrade a confirmed catalyst to "missing" just because the thesis phrases it as already-happening ("ramps") while the source shows it announced/planned ("plans to start") — the catalyst is REAL, so it supports; the unproven EFFECT is what's missing (next bullet).
- "contradicts" — a fact that works against the thesis.
- "missing" — a DOWNSTREAM EFFECT or OUTCOME the thesis depends on that NO source confirms (e.g. the announced factory will LIFT MARGINS, the deal will ACCELERATE REVENUE, the catalyst will DRIVE the rally), OR a premise the thesis cites that appears nowhere in the data (e.g. "insider buying" with no filing). This means unverified/absent, NOT disproven — and NOT a real announced catalyst (that is "supports"). The single most load-bearing "missing" item is usually the Critical Unknown. HONESTY ABOUT RETRIEVAL: a "missing" point is a LIMIT OF WHAT WE RETRIEVED, not proof the thing doesn't exist — phrase it that way. Write "No source found here confirming X" / "We couldn't verify X in the available facts", NEVER "X did not happen" or "no source confirms X exists" (we may simply not have fetched it). Our retrieval window for recent news is short; a real but older catalyst can be absent here yet still true — so stay humble in the wording.
- "neutral" — genuinely tangential context that neither backs nor breaks the thesis (e.g. a price move, a general market note). IMPORTANT: the thesis's CORE claim/catalyst, if NO source confirms it (including a fabricated or unverifiable claim like "signed a $90B deal" that appears nowhere), is "missing", NEVER "neutral". Reserve neutral for side context only — never for the load-bearing claim itself. Always emit at least one "supports" or "missing" point for the thesis's central premise.
Then assign an overall status:
- "supported" — the weight of evidence backs the thesis.
- "mixed" — meaningful evidence on both sides.
- "contradicted" — the weight of evidence works against the thesis.
- "unsupported" — the thesis has little or no basis in the facts (e.g. a price target many multiples above any grounded estimate, or a narrative the fundamentals/news/filings do not back). Use this for fantasy theses.
- "insufficient" — there genuinely aren't enough facts available to judge the thesis either way (sparse data, no fundamentals/analyst/filings/news at all). Do NOT guess a verdict when the data is too thin — say insufficient. BUT: if you have even ONE solid grounded "supports" or "contradicts" point (a fact or a real news headline that confirms or breaks a core claim), you have enough to judge — use supported/mixed/contradicted, NOT insufficient. Reserve insufficient for when there is essentially no usable evidence on either side. A SPECIFIC claim being Unverified does NOT make the whole thesis "insufficient" when the broader packet (fundamentals, financials, analyst coverage, news) is substantive — judge the thesis on the full weight of evidence, not on one figure you couldn't confirm.

Only cite numbers present in the facts above — never invent or recall them from memory. Be willing to tell the investor their thesis is weak.
SOURCE HIERARCHY — weight your evidence by how authoritative the source is: (1) regulatory filings (SEC/SEDAR) > (2) company press releases / investor relations > (3) reputable financial news (Reuters/WSJ/Barron's and the live news headlines above) > (4) market/price data > (5) analyst opinions. Plainview's OWN prior briefs/notes are NOT a source and carry zero evidentiary weight. Prefer the highest-tier source available for any claim.
FACT vs FORECAST — distinguish what is CONFIRMED from what is merely EXPECTED. A signed/closed event, a reported figure, or a completed filing is a confirmed fact. A future-dated event, management guidance, an analyst expectation, a "submitted/pending/expected" regulatory step, or market speculation is NOT yet a fact — phrase it as such in your evidence (e.g. "Confirmed: …" vs "Expected (management guidance): …", "Pending: permit submitted, not yet approved"). Never present an expected catalyst as if it has already happened, and be precise about regulatory wording (submitted ≠ accepted ≠ approved).
TEMPORAL VALIDITY — today's date is given in THE FACTS. NEVER claim the company "reported"/"posted"/"delivered" results for a fiscal period unless a dated filing or headline in the facts shows it with a date ON OR BEFORE today. A period whose report would land on/after today has NOT reported yet — treat any figure attached to it as "missing" (unverified) or "Expected", never as a confirmed "supports"/"contradicts". Issuers often use a non-calendar fiscal year, so a fiscal "Q3" may not be filed even if the calendar quarter passed — rely ONLY on a dated filing/headline in the facts, never on the calendar, to decide a period has reported.
LIVE NEWS COUNTS AS EVIDENCE — WITH SOURCE DISCIPLINE: the "Live published news" headlines were retrieved just now from real publishers and ARE valid evidence for the QUALITATIVE event they state (a partnership, an acquisition "X to buy Y", an order win, a certification, a results release). When a headline plainly states such an event, treat it as VERIFIED ("supports") and cite it — do NOT mark a confirmed event "missing". BUT two hard limits that protect trust:
(1) SPECIFIC FIGURES NEED AN EXPLICIT SOURCE. Cite a hard number — a revenue/production/EPS/margin figure, a % change, a $ backlog — as confirmed ONLY if a headline or filing in the facts EXPLICITLY contains that exact number. NEVER infer, compute, estimate, or attach a figure to an event from a headline that does not itself state it. If the event is confirmed but the precise figure is not stated, mark only the figure "missing" and keep the qualitative event "supports" — do not manufacture a number to fill the gap.
(2) WEIGHT BY PUBLISHER. A regulatory filing or a recognized wire / financial publisher (Reuters, Bloomberg, company IR/PR, GlobeNewswire, Newswire, established outlets) is reliable. A single headline from an unknown aggregator, blog, forum, or content farm is WEAK: treat it as "neutral" qualitative context, NOT standalone verification of a hard financial claim, unless a filing or a second independent source in the facts corroborates it.
MATH CHECK: when you state a percentage move between two prices, compute (target − current) / current and GET THE SIGN RIGHT — a target ABOVE the current price is POSITIVE upside (a gain), a target BELOW is negative (downside). E.g. a $2.30 target vs a $1.48 price is +55% upside, NOT −55%. Sanity-check the direction before writing it.
"MISSING" IS NOT "CONTRADICTS": a claim you cannot verify in the available facts is "missing" (unverified), NOT evidence against the thesis. Thin-data names (small or foreign listings where production, margins, or cash aren't in the feed) will have many missing points — do NOT mark a thesis "contradicted" or "unsupported" just because its claims are unverified. Reserve "contradicted"/"unsupported" for facts that actively work AGAINST the thesis (wrong business, or a target far above any grounded estimate). When the evidence is mostly missing/neutral with nothing genuinely disconfirming, use "insufficient" (too thin to judge) or "mixed".
A DIFFERENT FIGURE IN THE SAME DIRECTION IS NOT A CONTRADICTION: if the thesis says a "$30M raise/placement" and the evidence shows a $73M or $100M raise, that CONFIRMS the qualitative claim (the company IS raising capital) — it is "supports" for the event, with at most a "neutral" note that the figure differs. A larger raise, a bigger backlog, or stronger-than-claimed growth does NOT "contradict" the thesis. Only use "contradicts" when the evidence shows the OPPOSITE of the claim (NO raise, a cancelled/failed deal, declining where the thesis claims growth, the wrong company). Do not let a precise number the investor got slightly wrong flip the whole verdict.
OVERALL STATUS = HEALTH OF THE CORE PREMISE, not nitpicks. A single overstated or off-base NUMBER (e.g. the thesis says "109% upside" but from the current price it's ~55% — the investor likely measured from their entry) does NOT make the whole thesis "contradicted" when its CORE remains intact (right business, real catalyst, target above the current price). Flag that point as "contradicts", but keep the OVERALL status "mixed" or "supported" unless the CENTRAL premise itself is disproven. Reserve "contradicted"/"unsupported" for when the thesis's core fails.
SELF-CONSISTENCY CHECK (do this silently before you answer): re-read your own points and summary as if auditing another analyst. (a) Does every figure you cite actually appear in THE FACTS above? If not, remove it. (b) Do any two of your statements contradict each other (e.g. one calls a period "reported" while another treats it as upcoming)? If so, fix the inconsistency. (c) Does your status match the weight of your points (you can't be "supported" if your points are mostly missing/contradicts)? (d) Does any claim contradict today's date or the thesis's own stated catalyst timing? Reconcile before returning. Only output the corrected, internally consistent result.

LOGIC / REASONING VALIDITY — judged in COMPLETE ISOLATION from whether the evidence is TRUE. **ASSUME EVERY PREMISE THE THESIS STATES IS 100% TRUE**, then ask only: IF all of that were true, would the conclusion FOLLOW? Reconstruct the causal chain (e.g. "attendance up → EBITDA up → re-rating → higher price") and score its VALIDITY 0-10 on the INFERENCE alone: are the links causally plausible, is each step proportional, do they together actually reach the conclusion?
HARD RULES so this stays separate from the Evidence score:
- Do NOT lower the Logic score because a premise is unverified, unconfirmed, missing, or lacks a source — that is the EVIDENCE pillar's job, NOT yours. The weakest link must be a LOGICAL flaw (a leap, a DISPROPORTION, a non-sequitur, a missing causal step), NEVER "unconfirmed/no evidence."
- Example of LOW logic with a TRUE premise: "won a $5M contract → a $20B-market-cap company doubles." Even if the $5M contract is 100% real, $5M is immaterial to a $20B company, so the inference is a disproportion → ~2/10. The weakest link is "a $5M deal is far too small to move a $20B valuation," NOT "the contract is unconfirmed."
- Example of HIGH logic: "GPU demand → revenue growth → earnings expansion → higher valuation → higher price" is a VALID chain (~8/10) even if none of the steps are yet confirmed — because IF they held, the conclusion follows. Confirmation is the Evidence score's concern, not Logic's.
Name the single weakest or missing LOGICAL link (never an evidence gap).

CATALYST MATERIALITY (for the magnitude/plausibility band — judge SIZE relative to THIS company's scale, NOT whether it's confirmed): classify the thesis's core catalyst as exactly one of:
- "transformational" — changes the business or its addressable market (a new platform, a category-defining product/partnership relative to the company's size).
- "significant" — meaningfully moves revenue or earnings.
- "incremental" — a minor positive.
- "negligible" — immaterial to the company's scale (e.g. a $5M deal for a $20B company; the SAME $5M deal is transformational for a $30M company). Scale it to the company.

COMPETING EXPLANATION (the real analyst's discipline — "is there a BETTER story for the SAME facts?"): propose the single strongest ALTERNATIVE explanation for the SAME observed evidence the thesis cites — a DIFFERENT cause for those same facts. HARD RULES: it must explain the SAME facts and introduce NO new unverified claims (this is NOT a generic bear case or a new bad-news story). Then name the DISCRIMINATOR: the single piece of information that would distinguish the thesis from this alternative — the fact that, once known, settles which reading is right. Example — thesis: "attendance up → structural recovery"; competing: "attendance up → one blockbuster window, no structural change"; discriminator: "whether attendance is broad across many films/months, or concentrated in one window." If the evidence genuinely admits no plausible alternative, set explanation to "No strong competing explanation — the evidence points one way" and discriminator to "".

Return ONLY valid JSON, no markdown:
{
  "status": "supported|mixed|contradicted|unsupported|insufficient",
  "points": [ {"evidence":"<specific fact with its number>","effect":"supports|contradicts|missing|neutral"} ],
  "summary": "<1-2 sentences: does the evidence support this thesis, and the single most important reason>",
  "logic": { "score": <0-10 reasoning validity>, "chain": ["<step 1 — a SHORT single stage, NOT 'A → B'>","<step 2>","<...>","<final stage = the price/outcome>"], "weakestLink": "<the single weakest or missing link in the chain>" },
  "materiality": "transformational|significant|incremental|negligible",
  "competing": { "explanation": "<the strongest alternative cause for the SAME facts>", "discriminator": "<the single fact that would distinguish the thesis from this alternative>" }
}`;

  const rawV = await runAI(prompt);
  if (!rawV) return NextResponse.json({ error: "AI is temporarily unavailable — the free model is rate-limited and the backup is out of credits. Try again shortly." }, { status: 502 });
  // Enforce the 3-state distinction (UNKNOWN ≠ CONTRADICTS, price ≠ contradiction) deterministically.
  // Deterministic guards: (1) UNKNOWN/price ≠ contradiction; (2) the computed magnitude floor — a target the
  // professional estimates don't support can't be "supported", and the math is always a visible point.
  const v = applyMagnitudeGuard(reconcileStatus(reconcilePoints(rawV, { thesis, price, target: _targetForMag })), mag);

  // Expose the extracted claims for testing/observability when the layer ran. Backend-only —
  // the UI ignores `_claims` (no chips in Phase 1).
  const extra = claimVerifyOn ? { _claims: extractedClaims, _claimEvidence: claimBlock } : {};

  // ── NEXUS-THESIS Phase 1 — the DETERMINISTIC scorecard (Evidence + Contradiction + Critical-Unknown).
  // Computed in code from the decomposed claims + their fetched sources (no LLM). Additive: it rides
  // alongside the existing verdict; same inputs → same scorecard. Fail-open (wrapped) so it can never
  // break the response.
  let scorecard: ReturnType<typeof buildScorecard> | null = null;
  try {
    // ONE source of truth: Evidence/Opposition/Critical-Unknown are scored from the SAME ▲▼ points shown to
    // the user (tiered by source in code), so the scorecard can never disagree with the displayed facts.
    const scored = pointsToClaims(v.points);
    // Did the engine actually RETRIEVE any real sourced fact (supports/missing) for this thesis? If not, the
    // verdict can't be "supported/partly-supported" — there's nothing to support it. Used below to force the
    // honest "Insufficient" when retrieval came back empty (MAG: only the computed magnitude point → must NOT
    // read "Partly supported").
    const hadRealPoints = scored.length > 0;
    // The scorecard must ALWAYS build (never fall back to the legacy box). If the LLM returned only neutral
    // points (no supports/missing — e.g. a fabricated core claim it left unclassified, or purely tangential
    // facts), seed one unverified load-bearing claim so the card renders as Unsupported/Insufficient, honestly.
    if (!scored.length) scored.push({ type: "thesis", raw: "No source found yet confirming the thesis's core claim", weight: 8, bestTierWeight: 0, bestSource: null, verified: false });
    const opposing: OpposingFact[] = [];
    // Primary: the Yahoo financials feed (revenueGrowth/grossMargins) — currently crumb-blocked → usually
    // null, so this rarely fires, but keep it: when it DOES return, hard numbers are the strongest signal.
    const rg = financials?.revenueGrowth;
    const gm = financials?.grossMargins;
    if (typeof rg === "number" && rg < 0) opposing.push({ text: `Revenue declining (${(rg * 100).toFixed(0)}% YoY)`, tierWeight: 0.45 });
    if (typeof gm === "number" && gm < 0) opposing.push({ text: `Negative gross margin (${(gm * 100).toFixed(0)}%)`, tierWeight: 0.45 });
    // Reliable fallback: derive fundamental headwinds from X-Ray (works on every ticker, unlike the blocked
    // financials feed). Skip any X-Ray item that just duplicates a hard-number opposing fact already added.
    if (!opposing.length) for (const o of xrayOpposingFundamentals(xray)) opposing.push(o);
    // Also count the genuine CONTRADICTING facts the LLM surfaced (a Q4 attendance drop, a cancelled deal) —
    // not just code-detected financials. Exclude pure PRICE-action "contradictions" (price ≠ a counter-fact,
    // per the constitution): drop a point only if it's price-language AND carries no fundamental term.
    const _priceOnly = /\b(stock|shares?|price)\b[^.]*\b(fell|drop|declin|slid|tumbl|sank|sell[- ]?off|pull(?:ed|s)?[- ]?back|down)\b/i;
    const _fundamental = /\b(revenue|margin|earnings|attendance|guidance|sales|deliveries|subscribers|production|grade|backlog|cash|debt|dilution|loss|profit|ebitda|units|orders|loan|impairment|recall|lawsuit|investigation)\b/i;
    for (const pt of v.points) {
      if (pt.effect !== "contradicts") continue;
      if (_priceOnly.test(pt.evidence) && !_fundamental.test(pt.evidence)) continue; // pure price action → not a contradiction
      opposing.push({ text: pt.evidence.replace(/\s*\([^)]*\)\s*$/, "").trim(), tierWeight: 0.6 });
    }
    if (scored.length) {
      scorecard = buildScorecard(scored, opposing);
      if (v.logic) scorecard.logic = v.logic; // §2.2 Logic pillar — judged on the smart tier, rides the verdict call
      // §2.3 Magnitude — deterministic band over (computed annualized move) × (judged materiality). Plausibility only.
      const _mg = buildMagnitude({ price, target: _targetForMag, thesis, materiality: v.materiality ?? null });
      if (_mg) scorecard.magnitude = _mg;
      // §5.1 Competing Explanation + discriminator — judged on the smart tier, rides the verdict call.
      if (v.competing && v.competing.explanation) scorecard.competing = v.competing;
      // Neutral context — facts the engine retrieved that neither back nor break the thesis. The old card
      // showed every fact; the scorecard dropped neutrals. Surface them as context so nothing is silently
      // hidden (the owner: "the old version always pulled up facts"). Strip the trailing source for brevity.
      const ctxFacts = v.points.filter((p) => p.effect === "neutral").map((p) => p.evidence.replace(/\s*\([^)]*\)\s*$/, "").trim()).filter(Boolean).slice(0, 3);
      if (ctxFacts.length) scorecard.context = ctxFacts;
      // §4 — re-derive the verdict from the FULL profile now that Logic + Magnitude are attached. The
      // scorecard verdict is deterministic (profile pattern-match), independent of the LLM `status`.
      scorecard.verdict = deriveVerdict(scorecard);
      // THIN-RETRIEVAL HONESTY: if NO real sourced fact was retrieved (no supports/missing/contradicts —
      // only the seeded placeholder and maybe the computed magnitude), we genuinely can't judge the thesis.
      // Force "Insufficient" — never "Partly supported" off arithmetic, never "Unsupported" (which implies we
      // looked and found the claim baseless; we simply found nothing either way). Constitution: thin → insufficient.
      if (!hadRealPoints && opposing.length === 0) {
        scorecard.verdict = "Insufficient — not enough sourced facts retrieved to judge this thesis yet.";
        scorecard.criticalUnknown = scorecard.criticalUnknown || "No sourced facts were found for the thesis's core claim — recheck when news or filings appear.";
      }
    }
  } catch { /* fail-open — the scorecard is additive */ }

  // ── CREDIBILITY GATE (deterministic) — the RECORDED status/strength must obey the same honesty as the
  // scorecard. A "contradicted/unsupported" verdict produces a damaging LOW strength (2.5 / 1.5), so it must
  // rest on GENUINE disconfirming evidence — never on thin or FAILED retrieval (the load-degraded mass-sweep
  // case: data sources rate-limited → no facts → the LLM guesses "contradicted"). When the deterministic
  // scorecard concluded "Insufficient" (no real sourced facts AND no opposing facts), force the verdict to
  // "insufficient" → strength null. A credible AI says "I can't judge this yet", it never guesses a confident
  // negative off data it didn't get. (insufficient is excluded from the brief's "contradicted" surfacing, so
  // this also stops the degraded-sweep flood from ever reaching the email.)
  if ((v.status === "contradicted" || v.status === "unsupported") && scorecard && /^insufficient/i.test(String(scorecard.verdict || ""))) {
    v.status = "insufficient";
  }

  // RETRIEVAL OBSERVABILITY (gated: body.debug===true) — the abstract truth-hardening tool. The dominant
  // accuracy failure is not classification but RETRIEVAL (the engine says "no source found" for facts it
  // simply didn't fetch). This exposes EXACTLY what each retrieval layer returned for ANY ticker, so a gap
  // can be diagnosed without guessing. Backend-only; the UI ignores `_debug`. Never cached as a verdict diff.
  const _debug = (body as { debug?: boolean }).debug === true ? {
    resolvedTicker: ticker, resolvedName, mining: { isMining: mining.isMining, commodity: mining.commodity }, biotech, crypto,
    analystMean: analyst.mean ?? null,
    newsQueries,
    allNews,
    newsEvidence: newsEvidence.map((n) => `${n.title}${n.source ? ` — ${n.source}` : ""}`),
    secLines,
    secCorroboration,
    hasXray: !!xray, hasFinancials: !!(financials && (financials.revenueGrowth != null || financials.grossMargins != null)),
  } : undefined;
  // Technicals for the client-side SETUP SCORE (decision-stack timing layer) — deterministic, $0. Daily
  // metrics (RSI / 50- & 200-day MA / 52-week range) so the 24h cache keeping them is fine; the client
  // combines them with the LIVE price + the user's buy target to score the entry.
  const technicals = { price: price ?? null, rsi: ta.rsi ?? null, rsiSignal: ta.rsiSignal ?? null, ma50: ta.ma50 ?? null, ma200: ta.ma200 ?? null, week52High: ta.week52High ?? null, week52Low: ta.week52Low ?? null };
  // Business (X-Ray) score for the decision strip's first gate — so it populates even when the client's
  // xrayCache is empty (a fresh Decide lookup). Sourced from the X-Ray we already gathered; falls back to
  // whatever the client passed. (This is the SCORE for the gate display only — the LLM still reasons from
  // the underlying fundamentals, never the score, per the evidence hierarchy.)
  // ONE BRAIN (Slice 2): prefer the CANONICAL X-Ray score the client already computed (the SEC-backed
  // /api/xray score shown on the card) over the lite gatherSignals/runXray score — they diverge (e.g. AMC
  // 4.0 on the card vs 5.0 from the lite path), and the card is the number the user sees. Every surface that
  // reads this businessScore (the Decide "Business" gate, the brief) now shows the SAME number as X-Ray.
  const _clientScore = parseFloat(String(body.xrayScore ?? ""));
  const businessScore = Number.isFinite(_clientScore) ? _clientScore : ((xray && typeof xray.score === "number") ? xray.score : null);
  // Asset type for the asset-aware Setup score (crypto ignores the 50/200-day MAs; miners/biotech keep them).
  const assetType = crypto ? "crypto" : mining.isMining ? "mining" : biotech ? "biotech" : "stock";
  // ── BRIEF SIGNALS — compact, deterministic recap for the morning email's per-holding texture + material
  // radar, built ENTIRELY from what we already gathered (no extra fetch, $0). The daily-brief sweep captures
  // this per ticker. day = overnight move; volX = today's volume vs avg; ma = price vs the 50-day; material =
  // the change-triggered events that actually warrant a look (dilution/offering, insider buy/sell).
  const briefSignals = (() => {
    const cur = price ?? null;
    const day = (cur != null && ta.prevClose && ta.prevClose > 0) ? Math.round(((cur - ta.prevClose) / ta.prevClose) * 1000) / 10 : null;
    const volX = (ta.avgVolume && ta.avgVolume > 0 && ta.currentVolume) ? Math.round((ta.currentVolume / ta.avgVolume) * 10) / 10 : null;
    const ma = (cur != null && ta.ma50 && ta.ma50 > 0) ? (cur >= ta.ma50 ? "above" : "below") : null;
    const near52 = (cur != null && ta.week52High && ta.week52Low && ta.week52High > ta.week52Low)
      ? Math.round(((cur - ta.week52Low) / (ta.week52High - ta.week52Low)) * 100) : null;
    // Material events from the structured filings (recent only — the brief is about what changed). Each Form 4
    // carries a classified signal; S-3/424B (and offering/shelf/convertible language) = dilution risk.
    const today = Date.now();
    const recent = (d: string) => { const t = Date.parse(d); return !isFinite(t) ? true : (today - t) <= 8 * 86400000; };
    const material: Array<{ kind: "dilution" | "offering_done" | "insider_buy" | "insider_sell" | "filing"; text: string; date: string }> = [];
    const newsTitles = (newsEvidence || []).map((n) => String(n?.title || "")).join(" · ");
    for (const s of (secSignals || [])) {
      if (!recent(s.date)) continue;
      const sum = s.summary || "";
      const offeringTopic = /^(S-3|S-1|424B)/i.test(s.form) || /offering|prospectus|shelf|convertible|at-the-market|registered direct|dilut/i.test(sum);
      const isF4 = /^4/.test(s.form) || /insider|form 4/i.test(sum);
      if (offeringTopic) {
        // CRITICAL accuracy gate (AMC false-positive, caught twice): never cry "dilution" on a bare offering
        // mention. A COMPLETED offering = overhang cleared (neutral/positive). A NEW raise = a registration
        // (S-3/S-1/424B) OR explicit new-issuance language. Anything ambiguous → stay SILENT, don't false-alarm.
        const completed = /\b(complet|closed|conclud|terminat|final tranche|fully (?:drawn|utiliz|subscrib)|wound down|expired)\b/i.test(sum)
          || (/\b(complet|closed|conclud|wraps?|finish)\w*/i.test(newsTitles) && /offering|raise|atm|at-the-market|notes/i.test(newsTitles));
        const newRaise = /^(S-3|S-1|424B)/i.test(s.form)
          || /\b(commenc|launch|announc|pric(?:e|ed|ing)|propos|enter(?:ed|ing)? into|will (?:sell|offer|issue)|to (?:sell|offer|issue)|public offering of|registered direct|convertible (?:senior )?notes)\b/i.test(sum);
        if (completed) material.push({ kind: "offering_done", text: sum || `${s.form} — offering completed; dilution overhang cleared`, date: s.date });
        else if (newRaise) material.push({ kind: "dilution", text: sum || `${s.form} filed — potential dilution`, date: s.date });
        // else: ambiguous offering mention → do NOT flag (avoids the false "dilution filing" the owner caught).
      } else if (isF4) {
        const buy = /purchase|bought|acquired|open-market/i.test(sum) || s.signal === "bullish";
        const sell = /sale|sold|disposed/i.test(sum) || s.signal === "bearish";
        if (buy && !sell) material.push({ kind: "insider_buy", text: sum, date: s.date });
        else if (sell && !buy) material.push({ kind: "insider_sell", text: sum, date: s.date });
      }
    }
    // Top recent headline(s) on the name — for the morning brief's "news on your names" section.
    const news = (newsEvidence || []).slice(0, 2).map((n) => (n && n.title ? String(n.title).trim() : "")).filter(Boolean);
    return { day, volX, ma, near52, sector: prof?.sector || null, news, material: material.slice(0, 3) };
  })();
  const responseObj = { ticker, ...v, ...extra, ...(scorecard ? { scorecard } : {}), technicals, businessScore, assetType, briefSignals, ...(_debug ? { _debug } : {}), checkedAt: new Date().toISOString() };
  // Cache the finished verdict so re-checks within the TTL are identical (and fast). Awaited so the
  // very next re-check reliably hits it; fail-open inside the helper. Debug requests skip the cache so
  // the heavy `_debug` payload never gets served to a normal user.
  if (!_debug) await writeVerdictCache(cacheKey, responseObj);

  // ── NEXUS Memory v1 — record this run's canonical signals into the GLOBAL facts ledger (the hive
  // mind: facts are the same for every user, stored once per ticker). Append-only, dedup-on-change,
  // FAIL-OPEN — a side-effect that must never affect the verdict. Only fresh (uncached) computes reach
  // here. Numbers come from the SAME gatherSignals bundle the verdict was built on, each tagged with its
  // source — so the shared ledger and the displayed analysis can never disagree. Gated on an
  // authenticated session (the route is auth-gated; this is belt-and-suspenders) but the row is GLOBAL.
  // TIME-CAPPED: the verdict is already computed + cached, so the memory writes can NEVER delay or hang
  // the user response. If the cap is hit, unfinished writes are dropped — dedup-on-change recovers them
  // next compute. Fully fail-open.
  await cap((async () => {
   try {
    const userId = sweepUserId || await getRequestUserId();
    if (userId) {
      const today = new Date().toISOString().slice(0, 10);
      const src = (k: string) => signals.sources[k]?.source ?? "Yahoo";
      const raw: (ObservationInput | null)[] = [
        price != null ? { signal_type: "price", numeric_value: price, value: { price }, source: "Yahoo", as_of: today } : null,
        financials.grossMargins != null ? { signal_type: "gross_margin", numeric_value: financials.grossMargins, value: { grossMargins: financials.grossMargins }, source: src("financials"), as_of: today } : null,
        financials.revenueGrowth != null ? { signal_type: "revenue_growth", numeric_value: financials.revenueGrowth, value: { revenueGrowth: financials.revenueGrowth }, source: src("financials"), as_of: today } : null,
        financials.netCash != null ? { signal_type: "net_cash", numeric_value: financials.netCash, value: { netCash: financials.netCash }, source: src("financials"), as_of: today } : null,
        analyst.mean != null ? { signal_type: "analyst_target", numeric_value: analyst.mean, value: { mean: analyst.mean, high: analyst.high, low: analyst.low }, source: src("analyst"), as_of: today } : null,
        ta.rsi != null ? { signal_type: "rsi", numeric_value: ta.rsi, value: { rsi: ta.rsi, signal: ta.rsiSignal }, source: src("technicals"), as_of: today } : null,
        earnings ? { signal_type: "next_earnings", numeric_value: null, value: { next_earnings: earnings }, source: src("earnings"), as_of: today } : null,
      ];
      const obs: ObservationInput[] = raw.filter((o): o is ObservationInput => o !== null);
      await recordSignalObservations(ticker, obs);

      // Slice B — PER-USER thesis evaluation history (private; powers thesis-evolution / "strength over
      // time"). Creates a snapshot when the thesis text is new/changed, appends this verdict linked to it.
      const { snapshotId } = await recordThesisEvaluation(userId, {
        ticker,
        thesisText: thesis,
        catalystText: body.catalyst ?? null,
        status: v.status,
        strengthScore: strengthFromVerdict(v),
        points: v.points,
        summary: v.summary,
        engineVersion: `tc-${CACHE_VERSION}`,
        // Conviction-Ledger contract (NEXUS-THESIS §8) — record the deterministic scorecard + the
        // load-bearing unknown so every decision is stored learnably (for the dual outcome/reasoning grade later).
        scorecard: scorecard ? { ...scorecard, price_at_eval: price ?? null } : (price ? { price_at_eval: price } : null),
        criticalUnknown: scorecard?.criticalUnknown ?? null,
      });

      // P1 write-path — when the user commits to a trade in Decide (a target is supplied), record the
      // FALSIFIABLE prediction it implies: "price reaches <target> by <horizon>". Horizon defaults to
      // 6 months (a thesis timeframe); NEXUS grades it later against admissible facts. Append-only,
      // deduped, fail-open. This is where Decide becomes the front door to the memory ledger.
      const targetNum = _targetForMag; // the stated thesis target — same one the magnitude graded
      if (targetNum && Number.isFinite(targetNum) && targetNum > 0) {
        const horizon = new Date(); horizon.setMonth(horizon.getMonth() + 6);
        await recordPrediction(userId, {
          ticker,
          metric: "price",
          direction: "reaches",
          threshold: targetNum,
          horizonDate: horizon.toISOString().slice(0, 10),
          basisPrice: price ?? null,
          rationale: thesis,
          thesisSnapshotId: snapshotId,
          source: "decide",
        });
      }
    }

    // ONE BRAIN — write verdict back to GLOBAL ticker memory so every surface knows the most recent
    // thesis-check outcome. AI output stored as labeled CONTEXT (24h TTL), never Tier-1 evidence.
    void writeTickerMemory(ticker, {
      lastVerdict: v.status,
      lastVerdictSummary: v.summary ? String(v.summary).slice(0, 200) : null,
    });
   } catch { /* fail-open — memory is a side-effect, never blocks the response */ }
  })(), 3500, undefined);

  return NextResponse.json(responseObj);
}
