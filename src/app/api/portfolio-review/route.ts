import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@supabase/supabase-js";
import { enforceAiQuota } from "@/lib/ai-quota";
import { autoDowngradeOnCreditDepletion } from "@/lib/ai-tier";
import { logUsage } from "@/lib/usage-log";
import { getRequestUserId } from "@/lib/nexus-memory";
import { NextResponse } from "next/server";
import {
  fetchEarningsDate,
  fetchRecentNews,
  fetchNewsForTicker,
  fetchSecFilings,
  runXray,
  formatXrayLine,
  buildInvestorContext,
  callCerebrasText,
  callGroqText,
  callGeminiText,
} from "@/lib/market-context";
import { loadPositionTrajectory, deriveDrawdownTrend, deriveSituation, trajectoryLine } from "@/lib/ticker-context";

export const maxDuration = 55;

type PositionSummary = {
  ticker: string;
  name?: string;
  pnl?: number | null;
  thesis?: string;
  exit?: string;
  takeProfit?: string;
  status?: string;
  catalyst?: string;
  thesisStatus?: string;
  nexusStatus?: string | null;
  nexusDelta?: number | null;
  concentration?: number | null;
  perf5d?: number | null;
  perf1mo?: number | null;
  perf3mo?: number | null;
  sentimentBull?: number | null;
  sentimentPosts?: number | null;
  xrayScore?: number | null;
};

type WatchSummary = {
  ticker: string;
  name?: string;
  thesis?: string;
};

type CatalystSummary = {
  title: string;
  date?: string;
  impact?: string;
};

// ── Shared review cache (Supabase Storage) ──────────────────────────────────────────────────────────
// The portfolio review must be STABLE: pressing "Regenerate" 5× in 10s should return the SAME answer (not
// 5 different LLM takes), and it should only re-cost when the PORTFOLIO actually changes or a day passes.
// Cache the finished review keyed by the portfolio COMPOSITION (tickers + thesis/exit/catalyst, NOT live
// prices) so a price tick never re-keys it, with a 24h TTL (daily refresh). Same pattern as thesis-check.
const PR_CACHE_TTL = 24 * 60 * 60 * 1000;
const PR_CACHE_VERSION = "v3"; // v3: date-aware prompt, filters past catalysts
const PR_BUCKET = "plainview-state";
function prHash(s: string): string { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return (h >>> 0).toString(36); }
function prStorage() { return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } }); }
async function prReadCache(key: string): Promise<(Record<string, unknown> & { _ts?: number }) | null> {
  try { const { data, error } = await prStorage().storage.from(PR_BUCKET).download(key); if (error || !data) return null; return JSON.parse(await data.text()); } catch { return null; }
}
async function prWriteCache(key: string, obj: Record<string, unknown>): Promise<void> {
  try { const blob = new Blob([JSON.stringify({ ...obj, _ts: Date.now() })], { type: "application/json" }); await prStorage().storage.from(PR_BUCKET).upload(key, blob, { upsert: true, contentType: "application/json" }); } catch { /* fail-open */ }
}

export async function POST(request: Request) {
  let body: {
    positions?: PositionSummary[];
    watchlist?: WatchSummary[];
    catalysts?: CatalystSummary[];
    triggeredExits?: string[];
    approachingExits?: string[];
    totalValueCad?: number;
    profile?: { goal?: number; currency?: string; deadline?: string; riskLevel?: string } | null;
    refresh?: boolean;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const { positions = [], watchlist = [], catalysts = [], triggeredExits = [], approachingExits = [], totalValueCad, profile } = body;

  // Composition key: only the STABLE, user-edited fields (holdings + thesis/exit/catalyst + goal). Live
  // pnl/perf/sentiment are deliberately EXCLUDED so a price tick can't invalidate the daily review.
  const _userId = await getRequestUserId().catch(() => null);
  const _compo = JSON.stringify({
    p: positions.map((p) => [String(p.ticker || "").toUpperCase(), p.thesis || "", p.exit || "", p.takeProfit || "", p.catalyst || "", p.status || "", p.nexusStatus || "", p.nexusDelta ?? ""]).sort(),
    w: watchlist.map((w) => String(w.ticker || "").toUpperCase()).sort(),
    g: profile?.goal ?? "", r: profile?.riskLevel ?? "", c: profile?.currency ?? "",
  });
  const cacheKey = `_pr-cache/${PR_CACHE_VERSION}/${_userId || "anon"}_${prHash(_compo)}.json`;
  // A re-press within the TTL (and same composition) returns the SAME review — no LLM call, no slot machine.
  // An explicit refresh:true bypasses the daily TTL, but a 60s debounce still kills rapid-fire regenerate.
  const cached = await prReadCache(cacheKey);
  if (cached && typeof cached._ts === "number") {
    const age = Date.now() - cached._ts;
    if ((!body.refresh && age < PR_CACHE_TTL) || (body.refresh && age < 60_000)) {
      return NextResponse.json({ ...cached, _cached: true });
    }
  }

  // Only a real (uncached) review calls the LLM, so only that counts against the daily AI cap.
  const _quota = await enforceAiQuota(); if (_quota) return _quota;
  void logUsage("portfolio");
  const hasGroq = !!process.env.GROQ_API_KEY;
  const hasAnthropic = !!process.env.ANTHROPIC_API_KEY;

  if (!hasGroq && !hasAnthropic) {
    return NextResponse.json(
      { error: "No AI provider configured. Add GROQ_API_KEY (free at console.groq.com) to your Vercel environment variables." },
      { status: 500 }
    );
  }
  // Write-through: every successful provider path returns via this, so the verdict is cached once + reused.
  const respond = async (review: string) => {
    const obj = { review, generatedAt: new Date().toISOString(), positionCount: positions.length };
    await prWriteCache(cacheKey, obj);
    return NextResponse.json(obj);
  };

  // Gather unique tickers — positions first (more important), then watchlist
  const posTickers = [...new Set(positions.map((p) => p.ticker.toUpperCase()))];
  const watchTickers = [...new Set(watchlist.map((w) => w.ticker.toUpperCase()))].filter(
    (t) => !posTickers.includes(t)
  );
  const allTickers = [...posTickers, ...watchTickers];
  // Cap X-Ray at 8 (SEC companyfacts can be slow); fetch earnings + news for all
  const xrayTickers = allTickers.slice(0, 8);

  const secTickers = posTickers.slice(0, 4); // cap at 4 to stay well within timeout

  // Fetch all live data in parallel
  const [xrayResults, earningsResults, newsResults, secResults] = await Promise.all([
    Promise.allSettled(xrayTickers.map((t) => runXray(t))),
    Promise.allSettled(allTickers.map((t) => fetchEarningsDate(t))),
    Promise.allSettled(posTickers.slice(0, 6).map((t) => fetchRecentNews(t))),
    Promise.allSettled(secTickers.map((t) => fetchSecFilings(t))),
  ]);

  const xrayMap = new Map(
    xrayTickers.map((t, i) => [t, xrayResults[i].status === "fulfilled" ? xrayResults[i].value : null])
  );
  const earningsMap = new Map(
    allTickers.map((t, i) => [t, earningsResults[i].status === "fulfilled" ? earningsResults[i].value : null])
  );
  // Build initial news map, then top up each ticker with company-name news using xray name.
  // This surfaces real headlines for small-cap/Canadian names where ticker-based search misses.
  const rawNewsMap = new Map(
    posTickers.slice(0, 6).map((t, i) => [t, newsResults[i].status === "fulfilled" ? (newsResults[i].value ?? []) : []])
  );
  const newsMap = new Map(await Promise.all(
    [...rawNewsMap.entries()].map(async ([t, lines]) => {
      const xrayName = (xrayMap.get(t) as { name?: string } | null)?.name || null;
      const merged = xrayName ? await fetchNewsForTicker(t, xrayName).catch(() => lines) : lines;
      return [t, merged] as [string, string[]];
    })
  ));
  const secMap = new Map(
    secTickers.map((t, i) => [
      t,
      secResults[i].status === "fulfilled" ? (secResults[i].value ?? []) : [],
    ])
  );

  // Slice 1 (ONE-BRAIN.md) — per-user position trajectory, so the review reads STATE + DIRECTION, not a
  // static snapshot. Derived from the daily P&L history the sweep logs; degrades gracefully before history
  // exists (leans on 3mo momentum). Fail-soft.
  const _posTraj = _userId ? await loadPositionTrajectory(_userId).catch(() => ({})) : {};

  // Build rich position lines
  const positionLines = positions
    .map((p) => {
      const parts: string[] = [`- ${p.ticker}${p.name ? ` (${p.name})` : ""}`];
      if (p.pnl != null) parts.push(`${p.pnl >= 0 ? "+" : ""}${p.pnl.toFixed(1)}% P/L`);
      if (p.concentration != null) parts.push(`${p.concentration}% of portfolio`);
      if (p.perf5d != null || p.perf1mo != null || p.perf3mo != null)
        parts.push(`perf: 5d ${p.perf5d != null ? (p.perf5d >= 0 ? "+" : "") + p.perf5d + "%" : "n/a"} / 1mo ${p.perf1mo != null ? (p.perf1mo >= 0 ? "+" : "") + p.perf1mo + "%" : "n/a"} / 3mo ${p.perf3mo != null ? (p.perf3mo >= 0 ? "+" : "") + p.perf3mo + "%" : "n/a"}`);
      {
        const dd = deriveDrawdownTrend((_posTraj as Record<string, Array<{ d: string; pnl: number }>>)[p.ticker.toUpperCase()], p.pnl ?? null);
        const sit = deriveSituation(dd, p.perf3mo ?? null, p.pnl ?? null);
        parts.push(`traj: ${trajectoryLine(dd, p.pnl ?? null, p.perf1mo ?? null, p.perf3mo ?? null, sit)}`);
      }
      if (p.sentimentBull != null && p.sentimentPosts) parts.push(`StockTwits ${p.sentimentBull}% bullish (${p.sentimentPosts} posts)`);
      if (p.xrayScore != null) parts.push(`X-Ray ${p.xrayScore.toFixed(1)}/10`);
      if (p.status && p.status !== "hold") parts.push(`status: ${p.status}`);
      if (p.thesis) parts.push(`thesis: ${p.thesis}`);
      if (p.thesisStatus) parts.push(`thesis-check verdict: ${p.thesisStatus.toUpperCase()}`);
      if (p.nexusStatus || p.nexusDelta != null) parts.push(`NEXUS trend: ${p.nexusStatus || "tracked"}${p.nexusDelta != null ? ` (${p.nexusDelta >= 0 ? "+" : ""}${p.nexusDelta} vs last check)` : ""}`);
      if (p.exit) parts.push(`exit rule: ${p.exit}`);
      if (p.takeProfit) parts.push(`take-profit plan: ${p.takeProfit}`);
      else parts.push(`take-profit plan: NONE SET`);
      if (p.catalyst) parts.push(`catalyst: ${p.catalyst}`);
      return parts.join(" | ");
    })
    .join("\n");

  const watchLines = watchlist
    .map((w) => `- ${w.ticker}${w.name ? ` (${w.name})` : ""}${w.thesis ? `: ${w.thesis}` : ""}`)
    .join("\n");

  const catalystLines = catalysts
    .map((c) => `- ${c.title}${c.date ? ` (${c.date})` : ""}${c.impact ? ` — ${c.impact} impact` : ""}`)
    .join("\n");

  // Build fundamentals block — one line per ticker with score, key metrics, earnings date
  const fundamentalLines = xrayTickers
    .map((t) => {
      const xray = xrayMap.get(t);
      if (!xray) return null;
      const earnings = earningsMap.get(t) ?? null;
      return `- ${formatXrayLine(t, xray, earnings)}`;
    })
    .filter(Boolean)
    .join("\n");

  // Build recent news block for top positions
  const newsLines = posTickers
    .slice(0, 6)
    .map((t) => {
      const headlines = newsMap.get(t) ?? [];
      if (!headlines.length) return null;
      return `${t}: ${headlines.slice(0, 3).join(" | ")}`;
    })
    .filter(Boolean)
    .join("\n");

  const secLines = secTickers
    .map((t) => {
      const filings = secMap.get(t) ?? [];
      if (!filings.length) return null;
      return `${t}: ${filings.join(" | ")}`;
    })
    .filter(Boolean)
    .join("\n");

  const liveSection = [
    fundamentalLines ? `LIVE FUNDAMENTALS (SEC EDGAR + Yahoo Finance):\n${fundamentalLines}` : null,
    newsLines ? `RECENT NEWS:\n${newsLines}` : null,
    secLines ? `RECENT SEC FILINGS (last 30 days):\n${secLines}` : null,
  ]
    .filter(Boolean)
    .join("\n\n");

  const alertSection = [
    triggeredExits.length ? `⚠ EXIT RULES TRIGGERED NOW: ${triggeredExits.join(", ")} — pre-set sell targets hit. Investor must act.` : null,
    approachingExits.length ? `APPROACHING EXIT RUNGS: ${approachingExits.join(", ")} — within 10% of pre-set target.` : null,
    totalValueCad ? `Total portfolio value: C$${totalValueCad.toLocaleString("en")}` : null,
    profile ? `Investor profile: ${profile.riskLevel || "Aggressive"} risk, goal C$${profile.goal?.toLocaleString("en") || "?"} by ${profile.deadline || "?"}` : null,
  ].filter(Boolean).join("\n");

  const noPositionPrompt = `The investor has no positions yet. Write 3 sentences: (1) acknowledge they are starting fresh with no holdings, (2) suggest what type of position to research first given a growth/pre-catalyst style, (3) warn them about the single biggest mistake new investors make — chasing recent winners. Be direct and specific.`;

  const investorCtx = buildInvestorContext(profile ? { goal: profile.goal, currency: profile.currency, deadline: profile.deadline, riskLevel: profile.riskLevel, totalValue: totalValueCad, positionCount: positions.length } : null);
  const todayStr = new Date().toISOString().slice(0, 10);
  const prompt = positions.length === 0 ? noPositionPrompt : `You are Plainview's portfolio analyst — direct, data-driven, and honest. Today is ${todayStr}.${investorCtx ? `\n\n${investorCtx}` : ""}

Write a portfolio health review for this investor using the live data below.

${alertSection ? `ALERTS:\n${alertSection}\n` : ""}HOLDINGS (with live P/L, portfolio %, 5d/1mo/3mo performance, sentiment, X-Ray score, thesis, exit rule, take-profit plan):
${positionLines}

WATCHLIST (considering buying):
${watchLines || "None."}

UPCOMING CATALYSTS (ignore any with dates before today ${todayStr} — they already happened):
${catalystLines || "None listed."}

${liveSection ? `${liveSection}\n` : ""}Write exactly 5 sentences. Each must reference specific tickers and real numbers from the data above:
1. Portfolio health snapshot — lead with the biggest winner AND biggest loser by P/L%. For EACH, do NOT stop at the static P/L: read its "traj:" line and state the SITUATION and direction using the numbers — a loser whose drawdown is narrowing on positive 3-month momentum is RECOVERING/REBOUNDING (not just "your worst"); a flat-or-deepening loser is still bleeding. Note concentration if any single position is above 20% of the portfolio.
2. Thesis verdict — name the one position whose thesis is most clearly STRENGTHENING and the one most clearly WEAKENING right now, and say which it is. Judge by whether live performance, sentiment, news, and X-Ray score confirm or contradict the stated thesis — not by price alone. A stock can be up while its thesis weakens (price ran ahead of the story) or down while its thesis strengthens (fundamentals improving into weakness). Where a position carries a Plainview thesis-check verdict (Supported / Mixed / Contradicted / Unsupported), treat that as the authoritative evidence-vs-thesis read and stay CONSISTENT with it — don't call a Contradicted thesis healthy. Where a position shows a NEXUS trend (strengthening/weakening with a delta vs last check), stay CONSISTENT with its direction — don't call a position weakening if NEXUS shows it strengthening, or vice versa.
3. Most important catalyst or earnings date coming up — name it specifically.
4. One specific action the investor should take THIS WEEK — be explicit (trim, add, set a limit order, re-read the thesis, nothing).
5. The biggest unmanaged risk — prioritize any winning position (up >25%) with NO take-profit plan set, then any position with no exit rule, then concentration/correlation/sentiment extremes. Name the ticker and the specific gap.

OBJECTIVITY — trajectory cuts BOTH ways; never cheerlead, never doom-frame, never invent a trend (use only the "traj:" numbers). A RECOVERING/REBOUNDING loser is STILL flagged if it is overbought, diluting, or its thesis is Contradicted — state the recovery AND the risk ("the bounce is real, the entry isn't"). An EXTENDED winner (large 3-month gain) is never called "safe" — flag the extension and any missing take-profit. The same facts must read the same here as on every other surface.

Be blunt. No cheerleading. Name tickers. Use numbers. End with the hardest decision the investor is avoiding.`;

  // Cerebras first (free + fast + generous). On ANY failure fall through to Groq → Gemini → Claude.
  if (process.env.CEREBRAS_API_KEY) {
    try {
      const review = await callCerebrasText(prompt);
      if (review && review.trim()) return await respond(review);
    } catch {
      // fall through to Groq
    }
  }
  if (hasGroq) {
    try {
      const review = await callGroqText(prompt);
      if (review && review.trim()) return await respond(review);
    } catch {
      // fall through to Gemini
    }
  }

  // Gemini (free) — fallback when Groq is rate-limited.
  if (process.env.GEMINI_API_KEY) {
    try {
      const review = await callGeminiText(prompt);
      if (review && review.trim()) return await respond(review);
    } catch {
      // fall through to Anthropic
    }
  }

  if (hasAnthropic) {
    try {
      const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY!, timeout: 20000 });
      const response = await anthropic.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 600,
        messages: [{ role: "user", content: prompt }],
      });
      const review = response.content
        .filter((b) => b.type === "text")
        .map((b) => (b as unknown as { text: string }).text)
        .join("\n");
      return await respond(review);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const lowCredits = msg.toLowerCase().includes("credit balance is too low");
      if (lowCredits) void autoDowngradeOnCreditDepletion();
      return NextResponse.json(
        {
          error: lowCredits
            ? "AI credits depleted — switched to free mode automatically."
            : msg,
        },
        { status: lowCredits ? 402 : 502 }
      );
    }
  }

  return NextResponse.json({ error: "Analysis unavailable." }, { status: 502 });
}
