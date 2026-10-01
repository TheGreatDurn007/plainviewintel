import Anthropic from "@anthropic-ai/sdk";
import { enforceAiQuota } from "@/lib/ai-quota";
import { logUsage } from "@/lib/usage-log";
import { getJudgmentModel } from "@/lib/ai-tier";
import { NextResponse } from "next/server";
import {
  gatherSignals,
  readTickerMemory,
  writeTickerMemory,
  buildMemoryContext,
  formatTechnical,
  buildInvestorContext,
  resolveResearchSymbol,
  stripThinkBlocks,
  callCerebrasText,
  callGroqText,
  callGeminiText,
  type InvestorProfile,
  type SignalBundle,
  formatFilingFacts,
} from "@/lib/market-context";
import { buildSignalBlock } from "@/lib/signal-labels";
import { loadTickerObservations, type TickerObservation } from "@/lib/ticker-context";

export const maxDuration = 55;

type SideInput = {
  ticker: string;
  name?: string;
  price?: number | string | null;
  xrayScore?: string | number | null;
  liveSignals?: string | null;
  thesis?: string | null;
  catalyst?: string | null;
  analystTarget?: number | string | null;
  currency?: string | null;
  exchange?: string | null;
  thesisStatus?: string | null; // stored thesis-check verdict (supported/mixed/contradicted/unsupported)
};

type Scores = { thesis: number | null; catalyst: number | null; momentum: number | null; risk: number | null; opportunity: number | null };
type Verdict = {
  fromTarget: number | null;
  intoTarget: number | null;
  fromRead: string;
  intoRead: string;
  verdict: string;
  lean: string; // "reallocate" | "stay" | "split" | "tooclose"
  fromScores: Scores;
  intoScores: Scores;
};

const cap = <T>(p: Promise<T>, ms: number, fallback: T): Promise<T> =>
  Promise.race([p, new Promise<T>((r) => setTimeout(() => r(fallback), ms))]);


function num(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function avg(vals: (number | null)[]): number | null {
  const valid = vals.filter((v): v is number => v !== null);
  return valid.length ? valid.reduce((a, b) => a + b, 0) / valid.length : null;
}

function sideBlock(
  label: string,
  s: SideInput,
  g: SignalBundle,
  price: number | null,
  observations: TickerObservation[],
  tickerMemory: Awaited<ReturnType<typeof readTickerMemory>> | null,
): string {
  const lines: string[] = [`=== ${label}: ${s.ticker}${s.name ? ` (${s.name})` : ""} ===`];
  if (price) lines.push(`Current price: $${price}`);
  // Description: use what gatherSignals fetched; fall back to profile for foreign listings with no SEC blurb.
  const descToUse = g.description || (g.profile.name ? `${g.profile.name}${g.profile.sector ? ` — ${g.profile.sector}` : ""}` : null);
  if (descToUse) lines.push(`What it does: ${descToUse}`);
  if (s.xrayScore) lines.push(`Plainview X-Ray score: ${s.xrayScore} (proprietary 0-10 financial-health gauge — use exactly as given)`);
  if (s.liveSignals) lines.push(`Live momentum: ${s.liveSignals}`);
  const taBlock = formatTechnical(g.technicals as Parameters<typeof formatTechnical>[0], price);
  if (taBlock) lines.push(`Technicals: ${taBlock}`);
  const analystMean = num(g.analyst.mean) ?? num(s.analystTarget);
  if (analystMean) {
    const staleNote = g.analyst.stale ? " — ⚠ price above consensus, target may be lagging recent upgrades" : "";
    lines.push(`Analyst consensus: $${analystMean.toFixed(2)}${g.analyst.high ? ` (high $${g.analyst.high.toFixed(2)})` : ""}${staleNote}`);
  }
  if (g.earnings) lines.push(`Next earnings: ${g.earnings}`);
  if (g.baseNews.length) lines.push(`Recent headlines: ${g.baseNews.slice(0, 3).join(" | ")}`);
  const ffLines = formatFilingFacts(g.filingFacts);
  if (ffLines.length) lines.push(ffLines.join("\n"));
  // NEXUS hive-mind context — ticker memory + deterministic signal labels (same as thesis-check + intel).
  if (tickerMemory) { const mc = buildMemoryContext(tickerMemory); if (mc) lines.push(mc); }
  const scoreNum = (() => { const n = parseFloat(String(s.xrayScore ?? "")); return Number.isFinite(n) ? n : null; })();
  const signalBlock = buildSignalBlock({ score: scoreNum, technicals: g.technicals, currentPrice: price, observations });
  if (signalBlock) lines.push(`NEXUS signal block (deterministic — context for the AI, NOT standalone claim evidence):\n${signalBlock}`);
  if (s.thesis) lines.push(`Investor's thesis: ${s.thesis}`);
  if (s.catalyst) lines.push(`Investor's noted catalyst: ${s.catalyst}`);
  if (s.thesisStatus) lines.push(`Plainview Thesis-Check verdict (evidence vs the stated thesis): ${s.thesisStatus.toUpperCase()} — weigh this into the thesis score; a Contradicted/Unsupported thesis should pull the thesis score down, a Supported one up.`);
  return lines.join("\n");
}

function extractVerdict(raw: string): Verdict | null {
  let cleaned = stripThinkBlocks(raw).replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start >= 0 && end > start) cleaned = cleaned.slice(start, end + 1);
  try {
    const j = JSON.parse(cleaned) as Record<string, unknown>;
    const parseScores = (o: unknown): Scores => {
      const s = (o || {}) as Record<string, unknown>;
      return { thesis: num(s.thesis), catalyst: num(s.catalyst), momentum: num(s.momentum), risk: num(s.risk), opportunity: num(s.opportunity) };
    };
    const fromScores = parseScores(j.fromScores);
    const intoScores = parseScores(j.intoScores);
    let lean = String(j.lean || "neutral").toLowerCase();
    const validLeans = ["reallocate", "stay", "split", "tooclose", "neutral"];
    if (!validLeans.includes(lean)) lean = "neutral";
    const fromAvg = avg([fromScores.thesis, fromScores.catalyst, fromScores.momentum, fromScores.risk, fromScores.opportunity]);
    const intoAvg = avg([intoScores.thesis, intoScores.catalyst, intoScores.momentum, intoScores.risk, intoScores.opportunity]);
    if (fromAvg !== null && intoAvg !== null) {
      const diff = intoAvg - fromAvg;
      if (lean === "reallocate" && diff < -1) lean = "stay";
      else if (lean === "stay" && diff > 2) lean = "reallocate";
    }
    return {
      fromTarget: num(j.fromTarget),
      intoTarget: num(j.intoTarget),
      fromRead: String(j.fromRead || ""),
      intoRead: String(j.intoRead || ""),
      verdict: String(j.verdict || ""),
      lean,
      fromScores,
      intoScores,
    };
  } catch {
    return null;
  }
}

async function runAI(prompt: string): Promise<Verdict | null> {
  // FREE CASCADE FIRST — Cerebras→Groq→Gemini at $0. Anthropic is the emergency-only fallback.
  if (process.env.CEREBRAS_API_KEY) {
    try { const out = await callCerebrasText(prompt); const v = extractVerdict(out); if (v) return v; } catch { /* fall through */ }
  }
  if (process.env.GROQ_API_KEY) {
    try { const out = await callGroqText(prompt); const v = extractVerdict(out); if (v) return v; } catch { /* fall through */ }
  }
  if (process.env.GEMINI_API_KEY) {
    try { const out = await callGeminiText(prompt); const v = extractVerdict(out); if (v) return v; } catch { /* fall through */ }
  }
  // Anthropic fallback — only fires when all free providers failed.
  if (process.env.ANTHROPIC_API_KEY) {
    try {
      const smart = await getJudgmentModel();
      const model = smart || "claude-haiku-4-5-20251001";
      const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: 30000 });
      const res = await anthropic.messages.create({ model, max_tokens: 800, temperature: 0, messages: [{ role: "user", content: prompt }] });
      const raw = res.content.filter((b) => b.type === "text").map((b) => (b as unknown as { text: string }).text).join("");
      const v = extractVerdict(raw);
      if (v) return v;
    } catch { /* all providers exhausted */ }
  }
  return null;
}

export async function POST(request: Request) {
  const _quota = await enforceAiQuota(); if (_quota) return _quota;
  void logUsage("opportunity");
  let body: { from?: SideInput; into?: SideInput; freedCapital?: number; sharesToSell?: number; realizedPnl?: number; investorProfile?: InvestorProfile | null };
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Invalid request" }, { status: 400 }); }

  const fromIn = body.from, intoIn = body.into;
  if (!fromIn?.ticker || !intoIn?.ticker) return NextResponse.json({ error: "Both a FROM holding and an INTO ticker are required." }, { status: 400 });

  // Resolve each side to the right exchange listing (CAD/TSX tickers can collide with a US security).
  const [fromTicker, intoTicker] = await Promise.all([
    resolveResearchSymbol(fromIn.ticker, { currency: fromIn.currency, exchange: fromIn.exchange }).catch(() => fromIn.ticker.toUpperCase()),
    resolveResearchSymbol(intoIn.ticker, { currency: intoIn.currency, exchange: intoIn.exchange }).catch(() => intoIn.ticker.toUpperCase()),
  ]);
  const fromPrice = num(fromIn.price);
  const intoPrice = num(intoIn.price);
  const freedCapital = num(body.freedCapital);
  const realizedPnl = num(body.realizedPnl);

  // ONE BRAIN: gatherSignals is the canonical signal source, same as thesis-check + intel.
  // Parallel-load observations + ticker memory for both sides so the signal block and hive-mind
  // context are ready to inject without blocking the fetch round-trip.
  const [fromG, intoG, fromObs, intoObs, fromMem, intoMem] = await Promise.all([
    gatherSignals(fromTicker, { price: fromPrice, name: fromIn.name ?? null }),
    gatherSignals(intoTicker, { price: intoPrice, name: intoIn.name ?? null }),
    loadTickerObservations(fromTicker).catch(() => [] as TickerObservation[]),
    loadTickerObservations(intoTicker).catch(() => [] as TickerObservation[]),
    readTickerMemory(fromTicker).catch(() => null),
    readTickerMemory(intoTicker).catch(() => null),
  ]);
  const btc = fromG.btc ?? intoG.btc; // gatherSignals fetches BTC on each side; use whichever resolved

  const investorCtx = buildInvestorContext(body.investorProfile ?? null);
  const sellNote = freedCapital
    ? `The investor would free up ~$${Math.round(freedCapital).toLocaleString("en-US")} by trimming ${fromTicker}${realizedPnl != null ? `, realizing a ${realizedPnl >= 0 ? "GAIN" : "LOSS"} of $${Math.abs(Math.round(realizedPnl)).toLocaleString("en-US")} on the shares sold` : ""}, and redeploy it into ${intoTicker}.`
    : "";

  const prompt = `You are Plainview, a disciplined investing analyst. The investor is weighing an OPPORTUNITY-COST decision: move capital out of one holding and into another. Judge whether the capital would work harder in the destination — reasoned from the evidence, NOT a forced answer. Saying "stay" is valid if the holding's setup is genuinely stronger.${investorCtx ? `\n\n${investorCtx}` : ""}

${sellNote}

${sideBlock("FROM (sell/trim)", fromIn, fromG, fromPrice, fromObs, fromMem)}

${sideBlock("INTO (buy)", intoIn, intoG, intoPrice, intoObs, intoMem)}
${btc ? `\nLive macro reference — current Bitcoin (BTC) spot: $${Math.round(btc).toLocaleString("en-US")} (use ONLY if a side is crypto-exposed; never cite a crypto price from memory).` : ""}

Weigh BOTH sides on the signals that matter — realistic 12-18 month upside, trend and relative strength, X-Ray health, the next real catalyst, and whether each thesis is strengthening or weakening. Analyst consensus is ONE input, not a ceiling (analysts lag high-short-interest/momentum/retail names) — let the evidence set the targets. Account for the realized gain/loss noted above as a real cost of switching.

CALIBRATE YOUR CONFIDENCE to how lopsided the evidence actually is. Both holdings carry risk — name the destination's single biggest risk too, never imply the buy is risk-free. When both names have genuine merit, say the move "moderately favors" one side rather than that capital "works significantly harder"; reserve strong, decisive language for cases that are genuinely one-sided. If it is close, use lean "tooclose" or "split" and say so plainly.

SCORE EACH SIDE so the investor can SEE why one wins — this is the most important part. This is an OPPORTUNITY comparison (best use of capital), NOT just "which is the better company". Raw upside % is only one input; do NOT let it decide the lean by itself. Rate each side 1-10 on:
- thesis: how well the evidence supports the thesis / underlying business quality.
- catalyst: strength AND nearness of the next real catalyst. CRITICAL: an ongoing OPERATIONAL catalyst counts — for a producer, things like rising production, a mine/capacity expansion, an economic-study update, or recurring earnings with operating leverage to the commodity ARE catalysts. Do NOT score catalyst low or say "no catalyst" just because there is no single binary event.
- momentum: trend + relative strength.
- risk: downside/quality risk where 10 = LOWEST risk (safest), 1 = highest risk.
Then give each side an "opportunity" score 0-100: your risk-adjusted overall rating that nets the realistic upside against thesis, catalyst, momentum and risk. The LEAN MUST FOLLOW the opportunity scores, not the raw upside %.

VERDICT must use analyst language and EXPOSE the trade-off: when you favor the lower-upside side, state explicitly WHICH factors outweighed the other side's upside (e.g. "PNG's nearer catalyst and stronger thesis outweigh AMC's higher raw upside"). Say the favored side "may offer a more favorable risk-adjusted setup because [factors]" — do NOT predict it "will" or is "likely to" generate higher returns (that is a confidence level you have not calculated).

Return ONLY valid JSON, no markdown:
{
  "fromTarget": <realistic 12-18mo price target for ${fromTicker}, a sober number (usually ~1-2.5x its price), grounded in its signals>,
  "intoTarget": <realistic 12-18mo price target for ${intoTicker}, same basis>,
  "fromRead": "<one sentence: ${fromTicker}'s setup right now — trend, catalyst, thesis health>",
  "intoRead": "<one sentence: ${intoTicker}'s setup right now>",
  "fromScores": { "thesis": <1-10>, "catalyst": <1-10>, "momentum": <1-10>, "risk": <1-10, 10=lowest risk>, "opportunity": <0-100> },
  "intoScores": { "thesis": <1-10>, "catalyst": <1-10>, "momentum": <1-10>, "risk": <1-10, 10=lowest risk>, "opportunity": <0-100> },
  "verdict": "<2-3 sentences in analyst language: which side is the better USE OF CAPITAL given the scores and the switching cost, and WHY (name the factors that outweigh raw upside). Recommend staying if that is what the evidence supports>",
  "lean": "<one of: reallocate | stay | split | tooclose — must match which side has the higher opportunity score>"
}
Only cite numbers present in the data above; never invent prices or recall them from memory.`;

  const v = await runAI(prompt);
  if (!v) return NextResponse.json({ error: "AI is temporarily unavailable — the free model is rate-limited and the backup is out of credits. Try again shortly." }, { status: 502 });

  const fromUpside = v.fromTarget && fromPrice ? Math.round(((v.fromTarget - fromPrice) / fromPrice) * 100) : null;
  const intoUpside = v.intoTarget && intoPrice ? Math.round(((v.intoTarget - intoPrice) / intoPrice) * 100) : null;

  // ONE BRAIN — write the opportunity-cost read back to GLOBAL ticker memory for both sides.
  // Stored as labeled AI context (24h TTL), never Tier-1 evidence.
  if (v.intoRead) void writeTickerMemory(intoTicker, { lastVerdict: `opp-cost: ${v.lean}`, lastVerdictSummary: v.intoRead.slice(0, 200) });
  if (v.fromRead) void writeTickerMemory(fromTicker, { lastVerdict: `opp-cost: ${v.lean}`, lastVerdictSummary: v.fromRead.slice(0, 200) });

  return NextResponse.json({
    from: { ticker: fromTicker, price: fromPrice, target: v.fromTarget, upside: fromUpside, read: v.fromRead, analyst: num(fromG.analyst.mean) ?? num(fromIn.analystTarget), scores: v.fromScores, thesisStatus: fromIn.thesisStatus || null },
    into: { ticker: intoTicker, price: intoPrice, target: v.intoTarget, upside: intoUpside, read: v.intoRead, analyst: num(intoG.analyst.mean) ?? num(intoIn.analystTarget), scores: v.intoScores, thesisStatus: intoIn.thesisStatus || null },
    verdict: v.verdict,
    lean: v.lean,
  });
}
