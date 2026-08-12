import Anthropic from "@anthropic-ai/sdk";
import { enforceAiQuota } from "@/lib/ai-quota";
import { autoDowngradeOnCreditDepletion } from "@/lib/ai-tier";
import { logUsage } from "@/lib/usage-log";
import { NextResponse } from "next/server";
import {
  fetchEarningsDate,
  fetchRecentNews,
  fetchSecFilings,
  fetchAnalystTarget,
  fetchTechnicalData,
  fetchFinancialSnapshot,
  formatFinancialSnapshot,
  fetchCompanyDescription,
  fetchBitcoinPrice,
  fetchYahooProfile,
  runXray,
  fetchEtfMetrics,
  formatXray,
  formatTechnical,
  buildInvestorContext,
  resolveResearchSymbol,
  stripThinkBlocks,
  callCerebrasText,
  callGeminiText,
  classifyMining,
  classifyBiotech,
  MINING_LENS_FRAME,
  BIOTECH_LENS_FRAME,
  CRYPTO_LENS_FRAME,
  type InvestorProfile,
} from "@/lib/market-context";
import type { XrayResult, } from "@/types";
import type { TechnicalData } from "@/lib/market-context";

export const maxDuration = 55; // DeepSeek R1 reasoning needs headroom; Vercel hobby cap = 60s

type AnalysisResult = {
  catalyst: string;
  thesis: string;
  exit: string;
  takeProfit?: string;
  bearCase: string;
  buyInTarget?: number | null;
  realisticTarget?: number | null;
  bullCaseTarget?: number | null;
};

function buildPrompt(
  ticker: string,
  name: string | undefined,
  context: string,
  xray: XrayResult | null,
  earningsDate: string | null,
  newsLines: string[],
  secLines: string[],
  analystMean?: number | null,
  analystHigh?: number | null,
  taBlock?: string,
  currentPrice?: number | null,
  investorProfile?: InvestorProfile | null,
  financials?: import("@/lib/market-context").FinancialSnapshot | null,
  etfBlock?: string | null,
  isWatchlist?: boolean,
  lensFrame?: string | null,
): string {
  const sections: string[] = [];

  if (lensFrame) {
    // Asset-type lens (mining/biotech): tells the model NOT to judge a pre-revenue developer on
    // earnings/margins, and what the real catalysts are. Leads so it frames everything correctly.
    sections.push(lensFrame);
  }

  if (etfBlock) {
    // ETF: performance/risk profile replaces company fundamentals
    sections.push(`ETF profile (exchange-traded fund — no company fundamentals):\n${etfBlock}`);
  } else if (xray) {
    sections.push(`Fundamental snapshot (SEC EDGAR + Yahoo Finance):\n${formatXray(xray)}`);
  }
  if (!etfBlock && financials) {
    const finBlock = formatFinancialSnapshot(financials);
    if (finBlock) sections.push(`Yahoo Finance financials (authoritative for non-SEC filers):\n${finBlock}`);
  }
  if (earningsDate) {
    sections.push(`Next earnings date: ${earningsDate}`);
  }
  if (newsLines.length > 0) {
    sections.push(`Recent headlines (dated YYYY-MM-DD, NEWEST FIRST):\n${newsLines.map((h) => `- ${h}`).join("\n")}\nRECENCY RULE: these are time-ordered. When two headlines conflict ON THE SAME FACT, the more recent one supersedes — treat a correction, restatement, or update as overriding the older report. Weight the newest material facts most heavily; do not cite a stale figure as if it were current.`);
  }
  if (secLines.length > 0) {
    sections.push(`Recent SEC filings (last 30 days):\n${secLines.map((s) => `- ${s}`).join("\n")}`);
  }
  if (taBlock) {
    sections.push(`Technical levels (Yahoo Finance):\n${taBlock}`);
  }
  if (analystMean) {
    const highStr = analystHigh ? ` · high $${analystHigh.toFixed(2)}` : "";
    sections.push(`Analyst consensus: mean target $${analystMean.toFixed(2)}${highStr}`);
  } else {
    sections.push(`Analyst consensus: No third-party analyst target was retrievable for this ticker (common for small-cap TSX/OTC names). Generate your buyInTarget, realisticTarget, and bullCaseTarget independently from the fundamentals, production profile, technicals, comparable companies, and the thesis — do NOT anchor these numbers near the current price or default to a trivial premium. Reason from the evidence.`);
  }

  const liveSection = sections.length > 0
    ? `\nLive data — ground your analysis in these real numbers and current events:\n${sections.join("\n\n")}`
    : "";

  const investorCtx = buildInvestorContext(investorProfile);
  // The "thesis" field is framed differently for a watchlist (not owned yet) vs a holding.
  const thesisInstruction = isWatchlist
    ? "A FALSIFIABLE thesis for a WATCHLIST name the investor does NOT own yet — a BET, not a news recap. MAXIMUM 2 sentences. Sentence 1: THE CLAIM — what you expect the stock to do over the next 6-18 months and the single specific DRIVER (lead with the most compelling number: contract value, backlog, revenue figure, cash). Sentence 2: THE INVALIDATION — the concrete condition that proves the thesis WRONG (guidance miss, permit denial, a key metric falling below a stated level, catalyst slipping past a date). Specific enough that a fact-checker could later mark it supported or contradicted. Do NOT state any entry price, dollar discount, or percentage — the buy target is shown separately. NEVER reference the investor's average cost or P&L. No boilerplate openings. Write in FIRST PERSON SINGULAR — 'I expect…', 'My bet is…'."
    : "A FALSIFIABLE investment thesis — a BET, not a recap. MAXIMUM 2 sentences. Sentence 1: THE CLAIM — what you expect the stock to do over the next 6-18 months and the single specific DRIVER (lead with the most compelling number: contract value, backlog, revenue figure, cash). Sentence 2: THE INVALIDATION — the concrete condition that proves the thesis WRONG (guidance miss, permit denial, a metric falling below a stated level, dilution). Specific enough that a fact-checker could later mark it supported or contradicted. NEVER reference the investor's average cost, entry price, or P&L. No boilerplate openings. Write in FIRST PERSON SINGULAR — 'I expect…', 'My bet is…'.";
  return `You are Plainview, a disciplined investing research assistant.${investorCtx ? `\n\n${investorCtx}` : ""}

Do NOT reference any "Plainview score", "X-Ray score", or numeric health score (e.g. "a score of 5/10") in any field — reason only from the underlying fundamentals and events.

GROUND EVERY NUMBER you cite — prices, targets, financials, and especially bitcoin/crypto/commodity/index levels — in the Live data or context provided above. NEVER state a specific market price for bitcoin, another stock, a commodity, or an index from memory; a live Bitcoin price is provided above when relevant — use only that. If you reference such an asset and no live number is given, describe it qualitatively (e.g. "current bitcoin levels") with no figure.

Analyze ${ticker}${name ? ` (${name})` : ""} for this investor.
${etfBlock ? `\nNOTE: ${ticker} is an ETF (exchange-traded fund), not a single company — it has no revenue, earnings, margins, or balance sheet. Base the thesis on its strategy/holdings, diversification, and the performance & risk profile above; base the catalyst on a macro or sector driver; base the bear case on sector, concentration, or broad-market risk. Do NOT reference company financials or call it "undervalued/overlooked" based on a financial-health score.\n` : ""}${lensFrame ? `\nASSET-TYPE NOTE: judge ${ticker} strictly through the lens above — it is a pre-revenue developer, NOT an operating producer/commercial company. Do NOT make quarterly earnings, an "earnings beat", revenue growth, or "production growth" the catalyst or the thesis (it has no meaningful operating earnings yet). The catalyst MUST be a project/pipeline milestone: for a miner — a resource update, PEA/PFS/DFS study, drill/assay results, permit, financing/offtake, or strategic partnership; for a biotech — a trial readout, PDUFA/FDA decision, or pivotal data. The re-rating comes from DE-RISKING the project/pipeline (and, for miners, the underlying commodity price), not from earnings. Quarterly earnings are at most a minor checkpoint, never the thesis.\n` : ""}
${context}
${liveSection}

Return ONLY valid JSON — no markdown, no explanation, no code blocks. Exactly this structure:
{
  "catalyst": "One sentence naming the single most important upcoming catalyst that the COMPANY ITSELF drives or that lands on a specific date — its next earnings, a product launch, contract award, trial/data readout, or guidance update. DATE DISCIPLINE: name a specific earnings/event DATE only if one is explicitly given above (e.g. a 'Next earnings date' line) — and quote it EXACTLY; if NO date is provided, write 'its next quarterly earnings' with NO day, and NEVER invent, guess, or copy an example calendar date. CRITICAL: a macro or regulatory event the company merely benefits from but does NOT control (a bill passing, rate cuts, a sector tailwind, a crypto-price move) is a CAVEAT or tailwind, NOT a catalyst — only name it if it is genuinely the single biggest dated driver AND it is corroborated in the data above. Do NOT restate the investor's own catalyst guess unless the news/filings corroborate it. Never say 'continued growth'.",
  "thesis": "${thesisInstruction}",
  "exit": "One or two sentences — the DOWNSIDE protection ONLY: a hard stop-loss price or drawdown threshold tied to the thesis breaking. Concrete price or percentage. Do NOT put take-profit levels here.",
  "takeProfit": "One or two sentences on how to manage the UPSIDE — reasoned from the WHOLE picture, not a fixed formula. Weigh the live signals together: the trend and relative strength, momentum/RSI, short interest, recent catalysts and news, and whether the thesis looks to be strengthening or weakening. Let that judgement drive the plan. If the trend is strong and the thesis is intact or improving, lean toward letting the winner run — scale out gradually as it climbs toward and beyond the realistic and bull-case targets, trailing a stop rather than cutting early; if momentum is fading or the thesis is breaking down, be readier to take gains. TWO firm rules, both simply arithmetic: (1) a trim level only counts as taking profit if it is ABOVE the current price — never describe selling below where the stock trades now as taking profit, and do NOT anchor a trim to an analyst figure that sits below the current price; (2) for a held position, a sale below the investor's average cost is a loss — so for an underwater name that is still working (strong trend, catalyst intact), it is often right to simply HOLD for the recovery and note where you'd START trimming once back above cost, rather than mechanically cutting. If no position is held yet (a watchlist or considering name), reason from the current price UPWARD toward the targets. CONSISTENCY: any price level you name here MUST equal the realisticTarget or bullCaseTarget you return in this same JSON — never introduce a third number; if you'd rather not pin a figure, refer to them as 'the realistic target' and 'the bull case' instead. Be specific to THIS position's actual signals — if the evidence says hold or add, say so.",
  "bearCase": "Two sentences: the honest pre-mortem. What specific scenario would make this position a mistake in 6 months, and what risk do most bulls underweight? CRITICAL anti-confirmation-bias rule: do NOT validate the investor's thesis if the evidence does not support it. If their stated thesis or price target is detached from the data — a target far above any grounded estimate, or a narrative the fundamentals/news/filings do not back — say so plainly and explain why it is unsupported, rather than reinforcing it. The evidence is the ground truth; their thesis is a hypothesis you are testing, not a fact to confirm.",
  "buyInTarget": <number — compute per the rules below; do NOT output 14.50 or any placeholder>,
  "realisticTarget": <number — compute per the rules below for THIS ticker's price; never copy an example>,
  "bullCaseTarget": <number — compute per the rules below; never copy an example>
}
IMPORTANT: buyInTarget, realisticTarget and bullCaseTarget must be computed from THIS company's actual current price and signals. Do NOT echo any example number. Sanity-check: realisticTarget should normally be within ~1-2.5x the current price (a target far below the current price is almost always wrong unless the stock is genuinely collapsing).

buyInTarget rules: Use the 50-day MA, nearest support (52wk low, prior base), or a 10-15% discount to current price as the entry. Always return a number — never null unless the ticker has no price data at all.
realisticTarget rules: YOUR OWN grounded 12-18 month target, formed by WEIGHING all the evidence — fundamentals, technicals, the specific catalyst, short interest, the trend and relative strength, and recent news — into a number you can defend. Analyst consensus, if provided, is ONE input to weigh and sanity-check against — NOT a ceiling and NOT a leash. Analysts frequently lag or underrate high-short-interest, high-momentum, or retail-driven names, so if the live evidence genuinely supports a target above (or below) consensus, set it there and let the thesis explain why. By definition this is the SOBER 12-18 month expectation, not the moonshot: it usually lands within roughly 1-2.5x the current price. If your reasoning points materially higher than that, that upside is the BULL case — put it in bullCaseTarget and keep realisticTarget at the realistic level (it must stay below the bull case). Ground it in the SIGNALS, not in deference to analysts. Always return a number.
bullCaseTarget rules: Project 12-18 months and let the THESIS and the live SIGNALS set the level, not a mechanical multiple and not analyst consensus (treat consensus as a floor, not a ceiling). Actively weigh the short interest, the trend, and relative strength provided above: a high-short-interest name in a strong uptrend with a real demand catalyst (e.g. a record-box-office or earnings inflection) has genuine squeeze/re-rate upside and the bull case should reflect that — often a move back toward its prior trading range or 52-week high, which can be well above 3x a depressed price. For a steadier name, 1.5-3x current is a reasonable range. Always return a number that genuinely reflects the upside the thesis and signals imply — do not low-ball it out of caution.`;
}

function extractJson(raw: string): AnalysisResult | null {
  let cleaned = stripThinkBlocks(raw);
  cleaned = cleaned.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start >= 0 && end > start) cleaned = cleaned.slice(start, end + 1);
  try {
    return JSON.parse(cleaned) as AnalysisResult;
  } catch {
    const extract = (key: string) => {
      const m = cleaned.match(new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`));
      return m ? m[1].replace(/\\"/g, '"') : null;
    };
    const extractNum = (key: string): number | null => {
      // Handle both numeric (14.50) and quoted ("14.50") values
      const m = cleaned.match(new RegExp(`"${key}"\\s*:\\s*"?(\\d+(?:\\.\\d+)?)"?`));
      return m ? parseFloat(m[1]) : null;
    };
    const catalyst = extract("catalyst");
    const thesis = extract("thesis");
    if (!catalyst && !thesis) return null;
    return {
      catalyst: catalyst || "Unable to determine — review manually.",
      thesis: thesis || "Unable to generate — review manually.",
      exit: extract("exit") || "Unable to generate — review manually.",
      takeProfit: extract("takeProfit") || "",
      bearCase: extract("bearCase") || "Unable to generate — review manually.",
      buyInTarget: extractNum("buyInTarget"),
      realisticTarget: extractNum("realisticTarget"),
      bullCaseTarget: extractNum("bullCaseTarget"),
    };
  }
}

function applyPriceTargetFallbacks(
  result: AnalysisResult,
  currentPrice: number | null,
  ta: TechnicalData,
  analystMean?: number | null,
): void {
  if (!currentPrice) return;
  // Reject obviously-broken targets (e.g. the model copied the prompt's example $16/$28 onto a
  // $142 stock): a realistic 12-18mo target below ~40% of the current price is almost never real,
  // and a bull case below the current price is incoherent. Null them so the fallbacks recompute.
  if (result.realisticTarget && result.realisticTarget < currentPrice * 0.4) result.realisticTarget = null;
  if (result.bullCaseTarget && result.bullCaseTarget < currentPrice) result.bullCaseTarget = null;
  if (!result.buyInTarget || result.buyInTarget <= 0) {
    // Prefer 50-day MA if it's below current price (natural support), else 15% discount
    const ma50Below = ta.ma50 && ta.ma50 < currentPrice ? ta.ma50 : null;
    result.buyInTarget = ma50Below ?? Math.round(currentPrice * 0.85 * 100) / 100;
  }
  if (!result.bullCaseTarget || result.bullCaseTarget <= 0) {
    // Prefer 20% above 52wk high (breakout bull case), else 75% upside from current
    const breakout = ta.week52High && ta.week52High > currentPrice ? Math.round(ta.week52High * 1.2 * 100) / 100 : null;
    result.bullCaseTarget = breakout ?? Math.round(currentPrice * 1.75 * 100) / 100;
  }
  // Realistic target: anchor to analyst consensus when we have it (the most grounded forward
  // number), else a sober ~1.25x current. This is what the Decide verdict measures upside against,
  // so it must NOT be the moonshot.
  if (!result.realisticTarget || result.realisticTarget <= 0) {
    result.realisticTarget = (analystMean && analystMean > 0)
      ? Math.round(analystMean * 100) / 100
      : Math.round(currentPrice * 1.25 * 100) / 100;
  }
  // Guardrail: a "realistic" target above the bull case is incoherent — cap it.
  if (result.realisticTarget && result.bullCaseTarget && result.realisticTarget > result.bullCaseTarget) {
    result.realisticTarget = result.bullCaseTarget;
  }
}

async function callGroq(prompt: string): Promise<AnalysisResult> {
  // TEMPERATURE 0 — deterministic decoding. A "should I buy" draft is a JUDGMENT, not a creative
  // writing exercise: the same ticker + same facts must yield the SAME thesis/target every press, not
  // a slot machine (.70 → .85 → .60). Variety here reads as guessing and destroys trust. (Same
  // doctrine as thesis-check, which is already temp 0.)
  const models = [
    { id: "deepseek-r1-distill-qwen-32b", maxTokens: 4096, temperature: 0 },
    { id: "qwen-qwq-32b", maxTokens: 4096, temperature: 0 },
    { id: "llama-3.3-70b-versatile", maxTokens: 1024, temperature: 0 },
    { id: "llama-3.1-8b-instant", maxTokens: 1024, temperature: 0 },
  ];

  let lastError = "No models tried";
  for (const { id, maxTokens, temperature } of models) {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: id,
        messages: [{ role: "user", content: prompt }],
        max_tokens: maxTokens,
        temperature,
      }),
    });

    if (res.status === 404 || res.status === 400) {
      const err = await res.text();
      lastError = `${id}: ${err.slice(0, 80)}`;
      continue;
    }
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Groq ${res.status}: ${err.slice(0, 200)}`);
    }

    const data = await res.json() as { choices: { message: { content: string } }[] };
    const raw = data?.choices?.[0]?.message?.content || "";
    const result = extractJson(raw);
    if (!result) { lastError = `${id} returned unparseable response`; continue; }
    return result;
  }
  throw new Error(`Groq: ${lastError}`);
}

async function callGemini(prompt: string): Promise<AnalysisResult> {
  const raw = await callGeminiText(prompt, 0); // temp 0 — deterministic (see callGroq)
  const result = extractJson(raw);
  if (!result) throw new Error("Gemini returned unparseable response");
  return result;
}

async function callCerebras(prompt: string): Promise<AnalysisResult> {
  const raw = await callCerebrasText(prompt, 0); // temp 0 — deterministic (see callGroq)
  const result = extractJson(raw);
  if (!result) throw new Error("Cerebras returned unparseable response");
  return result;
}

async function callAnthropic(prompt: string): Promise<AnalysisResult> {
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });
  const response = await anthropic.messages.create({
    model: "claude-3-5-haiku-latest",
    max_tokens: 1024,
    temperature: 0, // deterministic — same ticker+facts → same draft
    messages: [{ role: "user", content: prompt }],
  });
  const raw = response.content
    .filter((b) => b.type === "text")
    .map((b) => (b as unknown as { text: string }).text)
    .join("");
  const result = extractJson(raw);
  if (!result) throw new Error("Anthropic returned unparseable response");
  return result;
}

export async function POST(request: Request) {
  const _quota = await enforceAiQuota(); if (_quota) return _quota;
  void logUsage("analyze");
  const hasGroq = !!process.env.GROQ_API_KEY;
  const hasAnthropic = !!process.env.ANTHROPIC_API_KEY;

  if (!hasGroq && !hasAnthropic) {
    return NextResponse.json(
      { error: "No AI provider configured. Add GROQ_API_KEY (free at console.groq.com) to your Vercel environment variables." },
      { status: 500 }
    );
  }

  let body: {
    ticker: string;
    name?: string;
    price?: string;
    avgCost?: string;
    status?: string;
    existingThesis?: string;
    existingExit?: string;
    existingCatalyst?: string;
    liveSignals?: string;
    analystTarget?: number | string | null;
    currency?: string | null;
    exchange?: string | null;
    investorProfile?: InvestorProfile | null;
    priorKnowledge?: string | null;
    isCrypto?: boolean;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const { ticker: rawTicker, name, price, avgCost, status = "hold", existingThesis = "", existingExit = "", existingCatalyst = "", liveSignals = "", analystTarget: clientAnalystRaw, currency, exchange, investorProfile, priorKnowledge, isCrypto = false } = body;
  const clientAnalyst = clientAnalystRaw != null && clientAnalystRaw !== "" && Number.isFinite(Number(clientAnalystRaw)) ? Number(clientAnalystRaw) : null;
  // Resolve warrants/rights AND the right exchange listing (CAD/TSX tickers can collide with a
  // US security, so use currency/exchange to pick the Canadian symbol — e.g. USA → USA.TO).
  if (!rawTicker) return NextResponse.json({ error: "Ticker required" }, { status: 400 });
  const ticker = await resolveResearchSymbol(rawTicker, { currency, exchange }).catch(() => rawTicker.toUpperCase());

  const [xray, earningsDate, newsLines, newsLinesByName, secLines, analystTargets, ta, financials, etf, companyDesc, btcPrice, profile] = await Promise.all([
    runXray(ticker),
    fetchEarningsDate(ticker),
    fetchRecentNews(ticker),
    // For crypto, also fetch news by the coin's full name (e.g. "Hedera Hashgraph" for HBAR, "Stellar"
    // for XLM). Searching only the raw ticker symbol ("HBAR") misses most relevant headlines — the
    // network name is what journalists write about, not the symbol.
    (isCrypto && name && name !== rawTicker) ? fetchRecentNews(name).catch(() => [] as string[]) : Promise.resolve([] as string[]),
    fetchSecFilings(ticker),
    fetchAnalystTarget(ticker, price ? parseFloat(price) : null),
    fetchTechnicalData(ticker),
    fetchFinancialSnapshot(ticker),
    fetchEtfMetrics(ticker).catch(() => null), // null for non-ETFs → stock path unchanged
    fetchCompanyDescription(ticker).catch(() => null),
    fetchBitcoinPrice().catch(() => null),
    fetchYahooProfile(ticker).catch(() => ({ sector: null, industry: null, name: null })), // sector/industry for the asset lens
  ]);
  // Always search by BOTH ticker AND company name — the name search consistently surfaces more
  // relevant headlines. Ticker-only ("KEEL.V", "PNG.V", "FDY") often returns nothing or noise;
  // name-based ("Keel Infrastructure", "Kraken Robotics") hits the actual stories journalists write.
  // Best available company name: Yahoo profile → X-Ray result → client-sent name.
  const profileName = profile.name || (xray as { name?: string } | null)?.name || name || null;
  let nameNewsLines: string[] = newsLinesByName; // crypto already fetched this in the Promise.all
  if (!isCrypto && profileName && profileName.toUpperCase() !== rawTicker.replace(/[.\-].*$/, "").toUpperCase()) {
    nameNewsLines = await fetchRecentNews(profileName).catch(() => [] as string[]);
  }
  // Merge ticker + name results, deduplicate by headline prefix, newest-first
  const allNewsLines = [...new Map([...newsLines, ...nameNewsLines].map(l => [l.slice(0, 40), l])).values()];

  // Canadian/OTC listings have no US description feed — fall back to Yahoo's profile so the
  // AI still grounds in the RIGHT company (not a same-ticker US security).
  let companyDescResolved = companyDesc;
  if (!companyDescResolved && (profile.name || profile.sector)) {
    companyDescResolved = `${profile.name || name || rawTicker}${profile.sector || profile.industry ? ` — ${[profile.sector, profile.industry].filter(Boolean).join(" / ")}` : ""}`;
  }

  // ASSET LENS: judge the thesis/catalyst by the RIGHT yardstick. A development-stage miner or a
  // clinical-stage biotech must NOT be framed on quarterly earnings/"production growth" — its catalysts
  // are project/pipeline milestones. We detect the type and inject the matching lens (the same frames
  // the thesis-checker uses), so generation is asset-aware too — not just verification.
  const lensId = { name: name || profile.name || rawTicker, sector: profile.sector, industry: profile.industry, description: companyDescResolved };
  const mining = classifyMining(lensId);
  const biotech = !mining.isMining ? classifyBiotech(lensId) : { isBiotech: false };
  // Crypto gets the CRYPTO_LENS_FRAME (regulatory/ETF/ISO 20022/adoption-focused) — same frame the
  // thesis-checker uses. Without this, the AI falls back on stock-style earnings/fundamentals language,
  // producing empty "no SEC filing" briefs for perfectly active networks like HBAR or XLM.
  const lensFrame = !etf ? (isCrypto ? CRYPTO_LENS_FRAME : mining.isMining ? MINING_LENS_FRAME : biotech.isBiotech ? BIOTECH_LENS_FRAME : null) : null;

  const currentPrice = price ? parseFloat(price) : null;
  const avg = avgCost ? parseFloat(avgCost) : null;
  const pnlPct = avg && avg > 0 && currentPrice ? ((currentPrice - avg) / avg) * 100 : null;
  const taBlock = formatTechnical(ta, currentPrice);

  const context = [
    companyDescResolved ? `What ${ticker} actually does (ground the thesis, catalyst and exit in this — do NOT invent a different business or narrative): ${companyDescResolved}` : null,
    btcPrice ? `Live macro reference — current Bitcoin (BTC) spot price: $${Math.round(btcPrice).toLocaleString("en-US")}. Use this ONLY if ${ticker} is crypto-exposed (a miner, holder, or exchange); otherwise ignore it. Never cite any crypto/commodity/index price from memory.` : null,
    price ? `Current price: $${price}` : null,
    liveSignals ? `Live momentum signals (exactly as shown on the X-Ray card — weigh these in the take-profit/exit reasoning): ${liveSignals}` : null,
    avg && avg > 0 ? `Investor's average cost: $${avg.toFixed(2)}${pnlPct != null ? ` (currently ${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(0)}% — ${pnlPct >= 0 ? "in profit" : "underwater, below cost"})` : ""}. Note for the take-profit plan: a sale below this cost is a loss, not a gain — weigh the live signals (trend, short interest, momentum, catalysts) to decide whether to hold for recovery or trim into strength.` : null,
    `Position status: ${status.toUpperCase()}`,
    existingCatalyst ? `Investor's noted catalyst: ${existingCatalyst}` : null,
    existingThesis ? `Investor's existing thesis: ${existingThesis}` : null,
    existingExit ? `Investor's existing exit rule: ${existingExit}` : null,
    priorKnowledge ? `\n${priorKnowledge}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  // Resolve analyst consensus: the route's own fetch first, else the value the client already
  // has from its X-Ray lookup (the analyze-route source is often empty for the same ticker).
  const analystMean = (analystTargets.mean ?? null) || clientAnalyst;
  // If the consensus looks stale (price already above it), surface that in the context so the
  // AI naturally discounts the number rather than treating it as a ceiling or reliable target.
  const analystStaleLine = analystTargets.stale && analystMean
    ? `Note: analyst consensus ($${analystMean.toFixed(2)}) may be lagging — the stock is currently trading above it. Treat it as a floor, not a ceiling, and weigh recent momentum and catalysts more heavily when setting price targets.`
    : null;
  const contextWithStale = analystStaleLine ? context + "\n" + analystStaleLine : context;
  const prompt = buildPrompt(ticker, etf?.name || name, contextWithStale, xray, earningsDate, allNewsLines, secLines, analystMean, analystTargets.high, taBlock || undefined, currentPrice, investorProfile, financials, etf?.block || null, status === "watchlist", lensFrame);

  const analystTarget = analystMean;

  // Cerebras first (free + fast + generous) — absorbs load so Groq/Gemini don't rate-limit.
  if (process.env.CEREBRAS_API_KEY) {
    try {
      const result = await callCerebras(prompt);
      applyPriceTargetFallbacks(result, currentPrice, ta, analystTarget);
      return NextResponse.json({ ...result, analystTarget });
    } catch {
      // fall through to Groq
    }
  }

  if (hasGroq) {
    try {
      const result = await callGroq(prompt);
      applyPriceTargetFallbacks(result, currentPrice, ta, analystTarget);
      return NextResponse.json({ ...result, analystTarget });
    } catch {
      // ANY Groq failure (rate-limit, timeout, auth) falls through to the next provider.
    }
  }

  // Gemini (free) — catches Groq rate-limits so analysis keeps working without paid credits.
  if (process.env.GEMINI_API_KEY) {
    try {
      const result = await callGemini(prompt);
      applyPriceTargetFallbacks(result, currentPrice, ta, analystTarget);
      return NextResponse.json({ ...result, analystTarget });
    } catch {
      // fall through to Anthropic
    }
  }

  if (hasAnthropic) {
    try {
      const result = await callAnthropic(prompt);
      applyPriceTargetFallbacks(result, currentPrice, ta, analystTarget);
      return NextResponse.json({ ...result, analystTarget });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const lowCredits = msg.toLowerCase().includes("credit balance is too low");
      if (lowCredits) void autoDowngradeOnCreditDepletion();
      return NextResponse.json(
        {
          error: lowCredits
            ? "AI credits depleted — switched to free mode automatically."
            : `Analysis failed: ${msg}`,
        },
        { status: lowCredits ? 402 : 502 }
      );
    }
  }

  return NextResponse.json({ error: "Analysis unavailable." }, { status: 502 });
}
