import Anthropic from "@anthropic-ai/sdk";
import { enforceAiQuota } from "@/lib/ai-quota";
import { logUsage } from "@/lib/usage-log";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  gatherSignals,
  fetchRecentNews,
  fetchSecSignals,
  formatSecSignals,
  fetchTechnicalData,
  formatFinancialSnapshot,
  fetchCompanyDescription,
  fetchBitcoinPrice,
  fetchYahooProfile,
  formatXray,
  formatTechnical,
  buildInvestorContext,
  resolveResearchSymbol,
  buildMiningNewsQueries,
  fetchNewsEvidence,
  MINING_LENS_FRAME,
  classifyBiotech,
  buildBiotechNewsQueries,
  BIOTECH_LENS_FRAME,
  CRYPTO_LENS_FRAME,
  callCerebrasText,
  callGroqText,
  callGeminiText,
  readTickerMemory,
  writeTickerMemory,
  buildMemoryContext,
  type SecSignal,
  type InvestorProfile,
  formatFilingFacts,
} from "@/lib/market-context";
import { buildIntelEvidenceBlock, detectIntelAssetLens } from "@/lib/intel-evidence";
import { auditFigures } from "@/lib/verify-figures";
import { getJudgmentModel, autoDowngradeOnCreditDepletion } from "@/lib/ai-tier";
import { recordSmartSpend } from "@/lib/ai-spend";
import { loadTickerObservations } from "@/lib/ticker-context";
import { buildSignalBlock } from "@/lib/signal-labels";

export const maxDuration = 55;

// NOTE: use .nullish() (string | null | undefined) not .optional() — the client
// sends null (not undefined) for fields with no value, e.g. priorKnowledge when a
// ticker has no accumulated notes. .optional() rejects null and 400s the whole request.
const Body = z.object({
  ticker: z.string().min(1),
  thesis: z.string().nullish(),
  exitRule: z.string().nullish(),
  data: z.record(z.unknown()).nullish(),
  investorProfile: z.record(z.unknown()).nullish(),
  mode: z.enum(["intel", "xray"]).nullish(),
  priorKnowledge: z.string().nullish(),
});

export async function POST(request: Request) {
  // Bypass quota for the daily sweep (system action, no user session)
  const cronSecret = process.env.CRON_SECRET;
  const isCron = cronSecret && request.headers.get("x-cron-secret") === cronSecret;
  if (!isCron) { const _quota = await enforceAiQuota(); if (_quota) return _quota; }
  // Only log real user actions — cron sweeps have no session and would flood the feed as "anonymous".
  if (!isCron) void logUsage("intel");
  const hasGroq = !!process.env.GROQ_API_KEY;
  const hasAnthropic = !!process.env.ANTHROPIC_API_KEY;

  if (!hasGroq && !hasAnthropic) {
    return NextResponse.json(
      { error: "No AI provider configured. Add GROQ_API_KEY (free at console.groq.com) to your Vercel environment variables." },
      { status: 500 }
    );
  }

  const parsed = Body.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid Intel request" }, { status: 400 });
  }

  const { ticker: rawTicker, thesis, exitRule, data, investorProfile, mode = "intel", priorKnowledge } = parsed.data;
  // Resolve warrants/rights AND the right exchange listing (CAD/TSX tickers can collide with a
  // US security — use the position's currency/exchange to pick the Canadian symbol).
  const ticker = await resolveResearchSymbol(rawTicker, {
    currency: (data as Record<string, unknown>)?.currency as string | undefined,
    exchange: (data as Record<string, unknown>)?.exchange as string | undefined,
  }).catch(() => rawTicker.toUpperCase());

  // Start memory read early — runs in parallel with everything below; awaited lazily before evidence build.
  const memoryPromise = readTickerMemory(ticker);

  // Detect asset class — frontend sends isCrypto / isETF / isCommodity flags in the data object
  const isCrypto = !!(data as Record<string, unknown>)?.isCrypto;
  const isETF = !!(data as Record<string, unknown>)?.isETF;
  const isCommodity = !!(data as Record<string, unknown>)?.isCommodity;
  const isWarrant = !!(data as Record<string, unknown>)?.isWarrant;
  // Watchlist = a stock the investor does NOT own yet and is waiting to buy.
  const isWatchlist = !!(data as Record<string, unknown>)?.isWatchlist;
  // Authoritative X-Ray score exactly as the card displays it — keeps the brief consistent
  // with the UI (the route's own runXray can compute a different score than /api/xray).
  const xrayScoreLabel = ((data as Record<string, unknown>)?.xrayScore as string) || null;
  // Sector/industry (from Yahoo search — works for Canadian listings) so the AI knows what
  // the company actually does and never invents a business (e.g. calling an airline "oil & gas").
  const profSector = ((data as Record<string, unknown>)?.sector as string) || null;
  const profIndustry = ((data as Record<string, unknown>)?.industry as string) || null;
  const profName = ((data as Record<string, unknown>)?.name as string) || null;
  // Phase 3 (cache-aware, fallback-safe): the already-computed asset profile passed from the client's
  // X-Ray cache. Frames the brief by the right lens. Null when not yet X-Rayed → current behavior.
  const assetProfileLabel = (() => {
    const ap = (data as Record<string, unknown>)?.assetProfile as { label?: string } | null | undefined;
    return ap && typeof ap.label === "string" && ap.label.trim() ? ap.label.trim() : null;
  })();

  // For crypto: Yahoo Finance uses "XLM-USD" format for technical data
  const yahooTicker = isCrypto ? `${ticker}-USD` : ticker;

  const cap = <T>(p: Promise<T>, ms: number, fallback: T): Promise<T> =>
    Promise.race([p, new Promise<T>(resolve => setTimeout(() => resolve(fallback), ms))]);

  let sections: string[] = [];
  let evidenceNewsLines: string[] = [];
  let evidenceSecLines: string[] = [];
  let evidenceEarningsDate: string | null = null;
  let evidenceXrayBlock: string | null = null;
  let evidenceFinancialBlock: string | null = null;
  let evidenceTechnicalBlock: string | null = null;
  let evidenceAnalystTarget: string | null = null;
  let evidenceMarketDataBlock: string | null = null;
  // Hoisted so the NEXUS signal block (after all branches) can reference it regardless of path.
  let _taForSignal: import("@/lib/market-context").TechnicalData | null = null;
  let _cardPriceForSignal: number | null = null;
  let companyDescriptionForLens: string | null = null;

  if (isCrypto) {
    // --- CRYPTO PATH ---
    // Skip: SEC filings, earnings dates, analyst targets, stock fundamentals (irrelevant)
    // Use: news (searched by name for better results), technical data via XLM-USD format,
    //      and the rich CoinGecko market data sent from the frontend
    const cryptoData = data as Record<string, unknown>;
    const coinName = (cryptoData.name as string) || ticker;

    const [newsLines, ta] = await Promise.all([
      // Search by coin name for better news coverage (e.g. "Stellar" not just "XLM")
      cap(fetchRecentNews(coinName !== ticker ? coinName : yahooTicker), 3000, [] as string[]),
      cap(fetchTechnicalData(yahooTicker), 3000, { ma50:null, ma200:null, week52High:null, week52Low:null, avgVolume:null, currentVolume:null, beta:null, shortPercentOfFloat:null, floatShares:null, shortShares:null, daysToCover:null, rsi:null, rsiSignal:null, ma50Slope:null, prevClose:null }),
    ]);

    // Build crypto market data block from CoinGecko data sent by frontend
    const mktLines: string[] = [];
    if (cryptoData.marketCapRank)  mktLines.push(`Market cap rank: #${cryptoData.marketCapRank}`);
    if (cryptoData.marketCap)      mktLines.push(`Market cap: $${(Number(cryptoData.marketCap) / 1e9).toFixed(2)}B`);
    if (cryptoData.volume24h)      mktLines.push(`24h volume: $${(Number(cryptoData.volume24h) / 1e6).toFixed(0)}M`);
    if (cryptoData.change24h != null) mktLines.push(`24h change: ${Number(cryptoData.change24h) >= 0 ? "+" : ""}${Number(cryptoData.change24h).toFixed(1)}%`);
    if (cryptoData.change7d != null)  mktLines.push(`7d change: ${Number(cryptoData.change7d) >= 0 ? "+" : ""}${Number(cryptoData.change7d).toFixed(1)}%`);
    if (cryptoData.ath)            mktLines.push(`All-time high: $${cryptoData.ath}`);
    if (cryptoData.athPct != null) mktLines.push(`Distance from ATH: ${Number(cryptoData.athPct).toFixed(0)}%`);
    if (cryptoData.circulatingSupply) mktLines.push(`Circulating supply: ${Number(cryptoData.circulatingSupply).toLocaleString("en")}`);
    if (cryptoData.bullTarget)     mktLines.push(`Investor bull target: $${cryptoData.bullTarget}`);
    if (mktLines.length) {
      evidenceMarketDataBlock = mktLines.join("\n");
      sections.push(`CoinGecko market data:\n${evidenceMarketDataBlock}`);
    }

    evidenceNewsLines = newsLines;
    if (newsLines.length > 0) sections.push(`Recent headlines (dated YYYY-MM-DD, NEWEST FIRST — when two conflict on the same fact the more recent supersedes; a correction/update overrides the older report):\n${newsLines.map((h) => `- ${h}`).join("\n")}`);
    // Pass the live price so the technical block STATES where price sits vs each MA ("(price is above)")
    // — otherwise the model derives it and keeps confusing the 50/200 cross with price-vs-200-day.
    const cardPrice = (typeof (data as Record<string, unknown>)?.price === "number" ? ((data as Record<string, unknown>).price as number) : null) ?? ta.prevClose ?? null;
    const taBlock = formatTechnical(ta, cardPrice);
    evidenceTechnicalBlock = taBlock;
    if (taBlock) sections.push(`Technical levels (via Yahoo Finance ${yahooTicker}):\n${taBlock}`);

  } else if (isETF) {
    // --- ETF PATH ---
    // ETFs have no company fundamentals. Use: news + technicals (both work for ETFs)
    // plus the performance/risk metrics computed on the frontend (YTD/1Y returns,
    // volatility, trend, drawdown) passed in data.xrayMetrics.
    const etfData = data as Record<string, unknown>;
    const [newsLines, ta] = await Promise.all([
      cap(fetchRecentNews(ticker), 3000, [] as string[]),
      cap(fetchTechnicalData(ticker), 3000, { ma50:null, ma200:null, week52High:null, week52Low:null, avgVolume:null, currentVolume:null, beta:null, shortPercentOfFloat:null, floatShares:null, shortShares:null, daysToCover:null, rsi:null, rsiSignal:null, ma50Slope:null, prevClose:null }),
    ]);
    if (etfData.xrayMetrics) {
      evidenceMarketDataBlock = String(etfData.xrayMetrics);
      sections.push(`ETF performance & risk metrics:\n${etfData.xrayMetrics}`);
    }
    if (xrayScoreLabel) sections.push(`Plainview X-Ray score: ${xrayScoreLabel} — Plainview's proprietary 0-10 gauge.`);
    evidenceNewsLines = newsLines;
    if (newsLines.length > 0) sections.push(`Recent headlines (dated YYYY-MM-DD, NEWEST FIRST — when two conflict on the same fact the more recent supersedes; a correction/update overrides the older report):\n${newsLines.map((h) => `- ${h}`).join("\n")}`);
    // Pass the live price so the technical block STATES where price sits vs each MA ("(price is above)")
    // — otherwise the model derives it and keeps confusing the 50/200 cross with price-vs-200-day.
    const cardPrice = (typeof (data as Record<string, unknown>)?.price === "number" ? ((data as Record<string, unknown>).price as number) : null) ?? ta.prevClose ?? null;
    const taBlock = formatTechnical(ta, cardPrice);
    evidenceTechnicalBlock = taBlock;
    if (taBlock) sections.push(`Technical levels:\n${taBlock}`);

  } else if (isCommodity) {
    // --- COMMODITY / PHYSICAL METAL PATH ---
    // Physical silver, gold, etc. are NOT companies. Skip: SEC filings, earnings, analyst targets,
    // company fundamentals. Use: commodity-specific news + technicals (via the Yahoo ticker).
    const commodityData = data as Record<string, unknown>;
    const commodityName = (commodityData.name as string) || ticker;

    const [newsLines, ta] = await Promise.all([
      cap(fetchRecentNews(commodityName !== ticker ? commodityName : ticker), 3000, [] as string[]),
      cap(fetchTechnicalData(ticker), 3000, { ma50:null, ma200:null, week52High:null, week52Low:null, avgVolume:null, currentVolume:null, beta:null, shortPercentOfFloat:null, floatShares:null, shortShares:null, daysToCover:null, rsi:null, rsiSignal:null, ma50Slope:null, prevClose:null }),
    ]);

    sections.push(`ASSET TYPE: Physical commodity (${commodityName}). This is NOT a company — do NOT discuss SEC filings, earnings, P/E ratios, or company management. Focus on spot price, supply/demand, macro drivers (rates, dollar strength, inflation), and technical levels.`);
    if (xrayScoreLabel) sections.push(`Plainview X-Ray score: ${xrayScoreLabel}`);
    evidenceNewsLines = newsLines;
    if (newsLines.length > 0) sections.push(`Recent headlines (dated YYYY-MM-DD, NEWEST FIRST):\n${newsLines.map((h) => `- ${h}`).join("\n")}`);
    const cardPrice = (typeof commodityData?.price === "number" ? (commodityData.price as number) : null) ?? ta.prevClose ?? null;
    _taForSignal = ta; _cardPriceForSignal = cardPrice;
    const taBlock = formatTechnical(ta, cardPrice);
    evidenceTechnicalBlock = taBlock;
    if (taBlock) sections.push(`Technical levels:\n${taBlock}`);

  } else {
    // --- STOCK PATH ---
    // NEXUS step 3 slice 3: the financial facts (xray, earnings, technicals, analyst, financials) come
    // from the SAME canonical store thesis-check uses, so the two surfaces can't disagree. Intel keeps
    // its OWN news merge (ticker + company name) and SEC-signals path (persisted to ticker memory) — so
    // gatherSignals is asked for ONLY the overlapping fields (no wasted fetches), and news/SEC stay here.
    const [signals, newsLines, rawSecSignals] = await Promise.all([
      gatherSignals(ticker, {
        price: (data as Record<string, unknown>)?.price as number | null,
        only: ["xray", "earnings", "technicals", "analyst", "financials", "filingFacts"],
      }),
      cap(fetchRecentNews(ticker), 3000, [] as string[]),
      cap(fetchSecSignals(ticker), 4000, [] as SecSignal[]),
    ]);
    const { xray, earnings: earningsDate, technicals: ta, analyst: analystTargets, financials, filingFacts } = signals;
    const secLines = formatSecSignals(rawSecSignals);
    // Persist fresh SEC signals to ticker memory (fire-and-forget — non-blocking)
    if (rawSecSignals.length) {
      void writeTickerMemory(ticker, {
        secSignals: rawSecSignals.map(s => ({ ...s, storedAt: new Date().toISOString() })),
      });
    }

    // Always search by company name too — ticker-only search ("PNG.V", "FDY", "KEEL.V") often
    // returns noise or nothing; the name ("Kraken Robotics", "Keel Infrastructure") finds real stories.
    const xrayName = (xray as { name?: string } | null)?.name || null;
    const companyName = profName || xrayName || null;
    const baseSymbol = ticker.replace(/[.\-].*$/, "").toUpperCase();
    let nameNewsLines: string[] = [];
    if (companyName && companyName.toUpperCase() !== baseSymbol) {
      nameNewsLines = await fetchRecentNews(companyName).catch(() => [] as string[]);
    }
    // Merge ticker + name results, deduplicate by headline prefix, newest-first
    const allNewsLines = [...new Map([...newsLines, ...nameNewsLines].map(l => [l.slice(0, 40), l])).values()];

    // Prefer the fundamentals the X-Ray CARD already rendered (sent by the client) — they're
    // complete and authoritative. The route's own runXray can time out (4s) and miss them,
    // which made the brief wrongly say "fundamentals unavailable" for names like AMC.
    const clientMetrics = ((data as Record<string, unknown>)?.xrayMetrics as string) || null;
    if (clientMetrics) {
      evidenceXrayBlock = clientMetrics;
      sections.push(`X-Ray fundamentals (from the live X-Ray card):\n${clientMetrics}`);
    } else if (xray) {
      evidenceXrayBlock = formatXray(xray);
      sections.push(`Fundamental snapshot (SEC EDGAR + Yahoo Finance):\n${evidenceXrayBlock}`);
    }
    if (profSector || profIndustry) sections.push(`Company profile: ${[profSector, profIndustry].filter(Boolean).join(" · ")} (use this for what the company does — do NOT guess a different business).`);
    if (xrayScoreLabel) sections.push(`Plainview X-Ray score: ${xrayScoreLabel} (higher = healthier; see NEXUS signal block below for standing + trend).`);
    if (financials) { const fb = formatFinancialSnapshot(financials); evidenceFinancialBlock = fb; if (fb) sections.push(`Yahoo Finance financials:\n${fb}`); }
    evidenceEarningsDate = earningsDate;
    if (earningsDate) {
      const today = new Date().toISOString().slice(0, 10);
      const edNorm = String(earningsDate).slice(0, 10);
      const label = edNorm < today ? `Most recent earnings date (ALREADY REPORTED — do NOT preview this as upcoming)` : edNorm === today ? `Earnings TODAY (report may already be out — check the headlines above)` : `Next earnings date (upcoming — not yet reported)`;
      sections.push(`${label}: ${earningsDate}`);
    }
    evidenceNewsLines = allNewsLines;
    if (allNewsLines.length > 0) sections.push(`Recent headlines (dated YYYY-MM-DD, NEWEST FIRST — when two conflict on the same fact the more recent supersedes; a correction/update overrides the older report):\n${allNewsLines.map((h) => `- ${h}`).join("\n")}`);
    else sections.push("Recent headlines: NO NEWS COULD BE RETRIEVED — news sources may be temporarily unavailable. Do NOT interpret this as 'nothing is happening'; state that news was unavailable and base your brief on the other evidence below.");
    evidenceSecLines = secLines;
    if (secLines.length > 0) sections.push(`Recent SEC filings (last 30 days):\n${secLines.map((s) => `- ${s}`).join("\n")}`);
    const filingFactLines = formatFilingFacts(filingFacts);
    if (filingFactLines.length) sections.push(filingFactLines.join("\n"));
    // Pass the live price so the technical block STATES where price sits vs each MA ("(price is above)")
    // — otherwise the model derives it and keeps confusing the 50/200 cross with price-vs-200-day.
    const cardPrice = (typeof (data as Record<string, unknown>)?.price === "number" ? ((data as Record<string, unknown>).price as number) : null) ?? ta.prevClose ?? null;
    _taForSignal = ta; _cardPriceForSignal = cardPrice; // hoist for NEXUS signal block below
    const taBlock = formatTechnical(ta, cardPrice);
    evidenceTechnicalBlock = taBlock;
    if (taBlock) sections.push(`Technical levels:\n${taBlock}`);
    if (analystTargets.mean) {
      const highStr = analystTargets.high ? ` · high $${analystTargets.high.toFixed(2)}` : "";
      const staleNote = analystTargets.stale ? " ⚠ price already above consensus — target may be lagging recent upgrades" : "";
      evidenceAnalystTarget = `Analyst consensus: mean target $${analystTargets.mean.toFixed(2)}${highStr}${staleNote}`;
      sections.push(evidenceAnalystTarget);
    }
  }

  if (mode === "intel" && data && Object.keys(data).length > 0) {
    sections.push(`The investor's OWN position notes (their thesis, catalyst guess, exit rule, cost basis — this is THEIR personal view, which may be wrong; use it only to pressure-test against the objective evidence above, NEVER repeat it as fact or as the company's actual catalyst):\n${JSON.stringify(data, null, 2)}`);
  }

  // Merge server-side accumulated memory with any client-supplied prior knowledge.
  // Memory arrives from Supabase Storage (_ticker_memory/{TICKER}.json) — it holds classified
  // SEC signals, risk flags, and prior brief context so the AI doesn't start cold on repeat visits.
  const tickerMemory = await memoryPromise;
  const memoryCtx = tickerMemory ? buildMemoryContext(tickerMemory) : null;
  const fullPriorKnowledge = [memoryCtx, priorKnowledge ?? null].filter(Boolean).join("\n\n---\n\n") || null;

  if (fullPriorKnowledge) {
    sections.push(fullPriorKnowledge);
  }

  // ── NEXUS SIGNAL BLOCK — deterministic, $0, shared with thesis-check so every surface agrees.
  // Three dimensions: financial standing (score), business trend (observation log), price action
  // (MAs, slope, RSI, volume). Pre-labeled so the AI reports what the data shows rather than
  // defaulting to generic optimism. See lib/signal-labels.ts for the labeling logic.
  try {
    const obs = await loadTickerObservations(ticker);
    const scoreNum = xrayScoreLabel ? parseFloat(xrayScoreLabel) : null;
    const emptyTA: import("@/lib/market-context").TechnicalData = { ma50:null,ma200:null,week52High:null,week52Low:null,avgVolume:null,currentVolume:null,beta:null,shortPercentOfFloat:null,floatShares:null,shortShares:null,daysToCover:null,rsi:null,rsiSignal:null,ma50Slope:null,prevClose:null };
    const signalBlock = buildSignalBlock({
      score: Number.isFinite(scoreNum) ? scoreNum! : null,
      technicals: _taForSignal ?? emptyTA,
      currentPrice: _cardPriceForSignal,
      observations: obs,
    });
    if (signalBlock) sections.push(`NEXUS signal block (deterministic — context for the read, NOT standalone evidence for a specific claim):\n${signalBlock}`);
  } catch { /* fail-soft — non-critical */ }

  // Ground EVERY non-crypto brief in what the company actually does, so the model never
  // invents the business or its catalysts. This is the shared "company context" anchor.
  if (!isCrypto) {
    const [descRaw, btcPrice] = await Promise.all([
      cap(fetchCompanyDescription(ticker), 2500, null),
      cap(fetchBitcoinPrice(), 2500, null),
    ]);
    // Canadian/OTC listings have no US description — fall back to Yahoo's profile (right company).
    let desc = descRaw;
    if (!desc && /\.(TO|V|CN|NE)$/i.test(ticker)) {
      const prof = await cap(fetchYahooProfile(ticker), 2500, { sector: null, industry: null, name: null });
      if (prof.name || prof.sector) desc = `${prof.name || ticker}${prof.sector || prof.industry ? ` — ${[prof.sector, prof.industry].filter(Boolean).join(" / ")}` : ""}`;
    }
    if (desc) sections.unshift(`What ${ticker} actually does (ground everything in this — do not invent a different business or narrative): ${desc}`);
    companyDescriptionForLens = desc;
    // Ground crypto-exposed equities (miners, holders) in the REAL BTC price so the brief
    // never cites a stale one from memory (the "$91k" bug). Gated: the model uses it only if relevant.
    if (btcPrice) sections.push(`Live macro reference — current Bitcoin (BTC) spot price: $${Math.round(btcPrice).toLocaleString("en-US")}. Use this ONLY if ${ticker} is crypto-exposed (a miner, holder, or exchange); otherwise ignore it.`);
  }

  const assetLens = detectIntelAssetLens({
    isCrypto,
    isETF,
    isWatchlist,
    ticker,
    name: ((data as Record<string, unknown>)?.name as string) || null,
    sector: profSector,
    industry: profIndustry,
    description: companyDescriptionForLens,
  });

  const evidenceBlock = buildIntelEvidenceBlock({
    lens: assetLens,
    ticker,
    thesis,
    priorKnowledge: fullPriorKnowledge,
    earningsDate: evidenceEarningsDate,
    newsLines: evidenceNewsLines,
    secLines: evidenceSecLines,
    financialBlock: evidenceFinancialBlock,
    xrayBlock: evidenceXrayBlock,
    technicalBlock: evidenceTechnicalBlock,
    analystTarget: evidenceAnalystTarget,
    marketDataBlock: evidenceMarketDataBlock,
  });
  if (evidenceBlock) sections.unshift(evidenceBlock);

  // Asset-type lens: pull the targeted catalyst headlines that matter for the asset class
  // (drill/assay/resource for miners; trial/FDA readouts for biotech) and frame the brief
  // around those rather than general-equity metrics. Detect conservatively; low confidence
  // falls back to the general stock brief.
  const lensName = (((data as Record<string, unknown>)?.name as string) || ticker);
  const isMiningLens = assetLens === "mining";
  const isBiotechLens = !isMiningLens && !isCrypto && !isETF
    && classifyBiotech({ name: lensName, sector: profSector, industry: profIndustry, description: companyDescriptionForLens }).isBiotech;
  if (isMiningLens) {
    const miningNews = await cap(
      fetchNewsEvidence(buildMiningNewsQueries(lensName, ticker, null)),
      6000,
      [] as Awaited<ReturnType<typeof fetchNewsEvidence>>
    );
    if (miningNews.length) {
      sections.push(
        `Mining catalyst news (live drill/assay/resource/financing headlines — cite grades, intercepts, or financings ONLY as stated here):\n${miningNews
          .map((n) => `- "${n.title}"${n.source ? ` — ${n.source}` : ""}${n.ts ? ` (${new Date(n.ts).toISOString().slice(0, 10)})` : ""}`)
          .join("\n")}`
      );
    }
  } else if (isBiotechLens) {
    const bioNews = await cap(
      fetchNewsEvidence(buildBiotechNewsQueries(lensName, ticker)),
      6000,
      [] as Awaited<ReturnType<typeof fetchNewsEvidence>>
    );
    if (bioNews.length) {
      sections.push(
        `Biotech catalyst news (live trial/FDA/readout headlines — cite trial data, dates, or regulatory status ONLY as stated here):\n${bioNews
          .map((n) => `- "${n.title}"${n.source ? ` — ${n.source}` : ""}${n.ts ? ` (${new Date(n.ts).toISOString().slice(0, 10)})` : ""}`)
          .join("\n")}`
      );
    }
  }
  const lensFrame = isMiningLens ? `\n\n${MINING_LENS_FRAME}` : isBiotechLens ? `\n\n${BIOTECH_LENS_FRAME}` : "";
  // Frame the brief by the asset profile when the client supplied one (cache-aware, fallback-safe).
  if (assetProfileLabel) sections.unshift(`Asset profile: ${assetProfileLabel} Write the brief through THIS lens — emphasize the evidence that matters for this kind of asset and stage, and do not judge it as a generic company if it isn't one.`);

  // Anchor the model in real time. Without "today" it cannot tell that a claimed quarter/event
  // hasn't been reported yet (the TRX "Q3 2026 already reported" fabrication). Put it FIRST.
  const todayIso = new Date().toISOString().slice(0, 10);
  sections.unshift(`Today's date: ${todayIso}. Use this for every recency/timing judgement below.`);

  const liveSection = sections.length > 0 ? `\nLive data:\n${sections.join("\n\n")}` : "";
  const investorCtx = buildInvestorContext(investorProfile as InvestorProfile | null);

  // Shared structured brief format + anti-fabrication guardrail for intel-mode briefs.
  // Scannable (~110 words), labeled lines, and forbids inventing numbers or catalysts.
  const structuredBrief = (riskExamples: string, extraRule = "") => `Base the brief on OBJECTIVE evidence about the company itself (its own news, filings, fundamentals, technicals). Describe what the company actually IS and is doing — do NOT narrow it to the one storyline the investor happens to believe, and do not treat their personal catalyst guess as the company's reality.

Write EXACTLY this four-line labeled format, ~110 words total maximum. Put each label on its own line. Keep every line to ONE clean sentence (What changed may use two):
What changed: 1-2 sentences on the most material recent development specific to THIS company/fund. PRIORITIZE a hard, source-backed NUMBER (a reported figure from a company release/filing — e.g. "+21% revenue", "25.5M attendance", "$950M backlog", "Phase 3 met its primary endpoint") over a vague headline summary; if the live data contains a specific material figure, lead with it rather than a generic "stock rises on optimism" line. Preserve the exact number as given. A generic market/sector/"ADRs decline" headline that does not name this company does NOT count.
Risk: ONE concise sentence on the single biggest GENUINE risk right now — a business, execution, technical (overbought RSI), dilution, debt, or sector risk (${riskExamples}). Distance from an analyst target is NOT a risk — name a real one.
Next catalyst: ONE sentence naming the most relevant catalyst the COMPANY ITSELF drives or that lands on a date — next earnings (use the earnings date above if given), a product/guidance update, contract, or readout. A macro/regulatory event the company merely benefits from but does NOT control (a bill passing, a crypto-price move, a sector tailwind) is a CAVEAT, not a catalyst — do not present it as the catalyst unless it is genuinely the single biggest dated driver and is corroborated above. Do NOT default to the investor's personal catalyst guess. You MAY reference a recurring event ("next quarterly earnings") without inventing a precise date or figure. Use "No catalyst identified from available filings and news" ONLY as a last resort.
Thesis check: ONE sentence stating the BUSINESS or FUNDAMENTAL development that would prove the thesis WRONG — e.g. attendance growth stops translating into revenue, a permit is delayed, margins deteriorate, a partnership falls through, production guidance is cut. CRITICAL: do NOT use a price level or the exit rule here — a price stop is the user's mechanical risk control, NOT a business reason the thesis failed.

Rules: TEMPORAL VALIDITY (critical for trust): today's date is given at the top of the live data. NEVER state that the company "reported", "posted", "delivered", or "announced" results for a fiscal period unless a dated filing or headline in the facts actually shows it — and that source's date must be ON OR BEFORE today. A quarter or event whose reporting date would fall on/after today HAS NOT been reported yet: describe it as upcoming/expected (e.g. "Q3 results, expected ~August"), never as a confirmed result, and never attach a specific revenue/production/EPS figure to an unreported period. Many issuers use a non-calendar fiscal year, so a fiscal "Q3" may cover different calendar months and may not yet be filed even if the calendar quarter has passed — rely ONLY on an actual dated filing/headline in the facts to say a period reported, never on the calendar alone. Only cite specific numbers (prices, returns, cash, revenue, margins, EPS, analyst targets, dates, X-Ray score) that appear in the live data above or in a cited headline — NEVER recall or estimate them from memory. This includes the price of bitcoin, any other crypto, a commodity, or a market index: cite a Bitcoin price ONLY if a "Live macro reference" BTC price is given above and use that exact number — otherwise refer to it qualitatively (e.g. "current bitcoin levels") with no figure. When you cite the Plainview X-Ray score, use EXACTLY the value provided above — never round or invent a different one. Ignore broad market-wide or sector-wide headlines that do not specifically name or directly concern this company. HEADLINE DISCIPLINE: a headline confirms the QUALITATIVE event it states, but a specific figure (revenue/production/EPS/%, $ backlog) is only confirmed if a headline or filing EXPLICITLY contains that exact number — never infer, compute, or attach a number to an event from a headline that does not state it. Weight by publisher: a regulatory filing or recognized wire/financial outlet (Reuters, Bloomberg, company IR/PR, GlobeNewswire, Newswire) is reliable; a single headline from an unknown aggregator, blog, or content farm is WEAK — treat it as qualitative context, not as a verified hard financial fact, unless a filing or second source corroborates it.${extraRule} PRICE IS NOT PROOF OF DEMAND: a price rally, a new 52-week high, or a % gain reflects market OPTIMISM/sentiment — it does NOT by itself verify business demand, accelerating revenue, or customer adoption. Never write that a price move "reflects", "shows", "is driven by", or "confirms" accelerating demand/growth unless a filing or cited news source actually confirms that demand. When only the price move is evidenced, say the stock "rallied on optimism about X" — NOT "demand for X is accelerating". STALE-PRICE GUARD: do NOT state a specific CURRENT share price as a live figure (the card already shows the live price, and this brief may be read later after the price has moved) — describe price moves qualitatively ("rallied ~60% since entry", "near a 52-week high") rather than "has risen to $X". FORMATTING: always put a normal space between a number/unit and the next word ("$25.5M the company", "61% increase", "three-month") — never run a figure into the following word. Do not ask reflective or emotional questions, and do not restate their thesis. Write like an analyst, not a coach. NO CIRCULAR EVIDENCE (critical): any "Prior Intel brief summary" or Plainview memory context is PLAINVIEW'S OWN earlier writing — it carries ZERO evidentiary weight and must NEVER be the source of "What changed" or of any figure/number. Every claim and number in this brief must trace to the LIVE data above (news headlines, SEC filings, financials, technicals, analyst targets) — NOT to a prior brief. If the only support for a "development" is a previous Plainview brief (e.g. a quarterly result, a % production change, a catalyst outcome), it is NOT confirmed: omit it, or state it as still-expected — never repeat a prior brief's figure as though it were freshly reported. Write like an analyst, not a coach. SELF-CONSISTENCY (silently, before answering): re-read your four lines as an auditor — every figure must appear in the live data above; no two lines may contradict each other or today's date (e.g. don't say a quarter was "reported" on one line and "upcoming" on another); and "What changed" must not assert an event the catalyst/next-catalyst line treats as still in the future. Reconcile any conflict before returning.`;

  let prompt: string;
  if (mode === "xray" && isETF) {
    // ETF company-card brief (X-Ray tab)
    prompt = `You are Plainview, a sharp ETF analyst. Write a concise brief for the ETF ${ticker}.${liveSection}

Write 4 focused sentences — no fluff, no disclaimers:
1. What this ETF tracks or its strategy (index, sector, or theme) — one crisp sentence using the fund name.
2. Performance & trend: cite specific return numbers (YTD, 1-year) and whether it is in an uptrend or downtrend relative to its moving averages.
3. Risk profile: reference the annualized volatility and drawdown — is this a stable core holding or a volatile tactical position?
4. The bottom line: who is this ETF appropriate for, and what is the single biggest risk (sector concentration, volatility, rate sensitivity)?

Only cite numbers shown in the data above. Do NOT invent holdings, expense ratios, or yields that are not shown. If a Plainview X-Ray score is provided above, you may reference it exactly as given.`;
  } else if (mode === "xray") {
    // Stock company-card brief (X-Ray tab) — THE ANALYST'S TAKE. It sits beneath a deterministic facts
    // summary the user has ALREADY read (business, score, revenue, margin, cash, EPS, trend, short float),
    // so its job is JUDGMENT, not a re-listing of those numbers. Lead with what the evidence MEANS.
    prompt = `You are Plainview, a sharp financial analyst writing a short interpretive read on ${ticker} for an investor who has ALREADY seen the raw facts directly above this — the business, the Plainview X-Ray score, revenue, margin, net cash, EPS, the trend, and short interest. Your job is to make SENSE of those facts: a clear judgment, not a re-listing.${liveSection}

HARD RULES:
- Do NOT open with, or write any sentence whose main job is, restating the score, revenue, margin, net cash, or EPS. They are already on screen. Reference a figure only when it directly powers a point.
- Be CONSISTENT with the evidence — do not re-derive facts it already states. The "Technical levels" block says exactly where the price sits relative to each moving average (e.g. "200-day MA: $1.90 (price is above)") AND, separately, the 50-day-vs-200-day structure. Use BOTH verbatim: never claim the price is above/below a moving average differently than stated, and treat a 50-vs-200 cross as nuance about the longer-term setup, NOT as a contradiction of where the price actually trades.
- If signals genuinely conflict (e.g. overbought yet the 50-day still under the 200-day), say so in one plain clause AND tell the reader which signal dominates right now — never leave two opposing statements for the reader to reconcile.
- Write plainly. Short sentences, one idea each. No run-on conditionals, no hype, no disclaimers.
- Never invent a fact, holding, insider transaction, or percentage that is not explicitly in the evidence above.

Cover this in four short sentences:
1. The setup — read the technicals as ONE coherent picture (momentum/RSI, the 50/200-day structure, volume, squeeze potential from short interest vs days-to-cover) and say what it means.
2. The catalyst — the single most important thing actually moving the story now: a named recent news item or SEC filing. If nothing material is in the evidence, say the news tape is quiet.
3. The bull case — the one specific thing that would make this worth owning.
4. The bear case — the single biggest thing that could break it.${lensFrame}`;
  } else if (isWatchlist) {
    // Watchlist entry-timing brief — they don't own it yet; they're waiting for an entry.
    const wd = data as Record<string, unknown>;
    const buyTarget = wd?.buyTarget != null ? `$${Number(wd.buyTarget).toFixed(2)}` : "not set";
    const analystT = wd?.analystTarget != null ? `$${Number(wd.analystTarget).toFixed(2)}` : "n/a";
    const curP = wd?.price != null ? `$${Number(wd.price).toFixed(2)}` : "n/a";
    prompt = `You are Plainview, a disciplined analyst. ${ticker} is on the investor's WATCHLIST — they do NOT own it yet and are waiting for an entry. Current price ${curP} · their buy-at target ${buyTarget} · analyst target ${analystT}.${investorCtx ? `\n\n${investorCtx}` : ""}

Why they're watching it: ${thesis || "No note written."}
${liveSection}

Write a scannable ENTRY-TIMING brief in EXACTLY this four-line labeled format, ~110 words max. Put each label on its own line:
What changed: 1-2 sentences on what GENUINELY changed for the business — a contract, backlog change, SEC filing, insider buy/sell, dilution, guidance, partnership, or a real sector shift. Cite the specific headline or filing. A price move on its own is NOT a change.
Setup status: Begin with ONE word — Improving, Unchanged, or Weakening — then one clause of justification. This is a WATCHLIST (the investor is waiting to BUY), so judge the BUY case: Improving = the thesis strengthened (new positive development) OR price is pulling back toward the buy-at target on healthy profit-taking (entry getting closer); Weakening = the thesis is genuinely deteriorating (a real break, not a dip) OR it keeps rallying further ABOVE the target so the entry is slipping away; Unchanged = neither.
Why waiting: ONE sentence on the concrete reason they have NOT bought yet — how far the current price sits above the buy-at target and analyst target, plus any momentum gate (e.g. RSI overbought). IF the name shows strong upward momentum (uptrend + outperforming) AND a near-term catalyst, add a short clause noting the pullback may not come — so a starter position now vs waiting for the full entry is worth weighing. Frame this as position SIZING, not chasing.
Next catalyst: ONE sentence naming the next event that could move the setup, and whether the intended entry is still BEFORE it. If none is identifiable, write "No catalyst identified from available filings and news."

Rules: Only cite numbers that appear in the live data above or a cited headline — never recall or estimate from memory. Ignore broad market-wide headlines not specific to this company. This is a PRE-PURCHASE triage — help them decide whether to keep waiting, take a closer look now, or that the setup has changed. Do not restate their thesis. Write like an analyst, not a coach.${lensFrame}`;
  } else if (isETF) {
    // ETF intel brief (portfolio Intel) — structured
    prompt = `You are Plainview, a disciplined ETF analyst. Write a scannable position brief for the ETF ${ticker}.${investorCtx ? `\n\n${investorCtx}` : ""}

Their thesis: ${thesis || "None written."}
Their exit rule: ${exitRule || "None written."}
${liveSection}

${structuredBrief("sector concentration, volatility, rate sensitivity, or a technical extreme", " Do NOT invent holdings, expense ratios, or yields not shown in the data.")}`;
  } else if (isCrypto) {
    // Crypto intel brief — structured
    prompt = `You are Plainview, a disciplined crypto analyst. Write a scannable position brief for ${ticker}.${investorCtx ? `\n\n${investorCtx}` : ""}

Their thesis: ${thesis || "None written."}
Their exit rule: ${exitRule || "None written."}
${liveSection}

${structuredBrief("liquidity, regulatory risk, correlation to BTC, or a momentum extreme (24h/7d move, distance from ATH)")}\n\n${CRYPTO_LENS_FRAME}`;
  } else {
    // Stock intel brief — structured
    prompt = `You are Plainview, a disciplined equity analyst. Write a scannable position brief for ${ticker}.${investorCtx ? `\n\n${investorCtx}` : ""}

Their thesis: ${thesis || "None written."}
Their exit rule: ${exitRule || "None written."}
${liveSection}

${structuredBrief("an RSI/technical extreme, stretched valuation, elevated debt, or share dilution")}${lensFrame}`;
  }

  // Helper: write brief summary + identity fields to ticker memory (fire-and-forget), then return.
  // Only for stock/ETF paths — crypto tickers aren't in SEC EDGAR so memory is less useful.
  // Admissible evidence set for the figure-provenance check: SOURCED facts ONLY. Deliberately
  // EXCLUDES the investor's own position notes and prior-brief/ticker memory — those are the exact
  // contamination sources that leak un-sourced numbers (the FDY "$30M placement"). A figure in the
  // brief that doesn't trace back to this set is "unverified". See lib/verify-figures.ts.
  const admissibleEvidence = [
    evidenceXrayBlock,
    evidenceFinancialBlock,
    evidenceTechnicalBlock,
    evidenceAnalystTarget,
    evidenceMarketDataBlock,
    evidenceNewsLines.join("\n"),
    evidenceSecLines.join("\n"),
  ].filter(Boolean).join("\n");

  const returnBrief = (brief: string) => {
    let figureAudit: ReturnType<typeof auditFigures> | null = null;
    let finalBrief = brief;
    try {
      figureAudit = auditFigures(brief, admissibleEvidence);
      if (figureAudit.unverified.length > 0) {
        console.log(`[figure-audit] ${ticker}: ${figureAudit.unverified.length}/${figureAudit.total} unverified →`,
          figureAudit.unverified.map((f) => f.raw).join(", "));
      }
    } catch { /* never let the audit break the brief */ }

    void writeTickerMemory(ticker, {
      briefSummary: brief.slice(0, 600),
      ...(profSector ? { sector: profSector } : {}),
      ...(profIndustry ? { industry: profIndustry } : {}),
      ...(assetProfileLabel ? { assetProfile: assetProfileLabel } : {}),
      ...(evidenceXrayBlock ? { xraySummary: evidenceXrayBlock.slice(0, 400) } : {}),
      ...(companyDescriptionForLens ? { businessSummary: companyDescriptionForLens.slice(0, 400) } : {}),
    });
    return NextResponse.json({ ticker, brief: finalBrief, _figureAudit: figureAudit });
  };

  // FREE CASCADE FIRST — Cerebras→Groq→Gemini at $0. Anthropic is the emergency-only fallback.
  if (process.env.CEREBRAS_API_KEY) {
    try {
      const brief = await callCerebrasText(prompt);
      if (brief && brief.trim()) return returnBrief(brief);
    } catch {
      // fall through to Groq
    }
  }
  if (hasGroq) {
    try {
      const brief = await callGroqText(prompt);
      if (brief && brief.trim()) return returnBrief(brief);
    } catch {
      // fall through to Gemini
    }
  }
  if (process.env.GEMINI_API_KEY) {
    try {
      const brief = await callGeminiText(prompt);
      if (brief && brief.trim()) return returnBrief(brief);
    } catch {
      // fall through to Anthropic
    }
  }

  // Anthropic fallback — only fires when all free providers failed.
  if (hasAnthropic) {
    try {
      const smartModel = await getJudgmentModel();
      const model = smartModel || "claude-haiku-4-5-20251001";
      const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY!, timeout: 15000 });
      const response = await anthropic.messages.create({
        model,
        max_tokens: 700,
        temperature: 0.3,
        messages: [{ role: "user", content: prompt }],
      });
      const brief = response.content
        .filter((b) => b.type === "text")
        .map((b) => (b as unknown as { text: string }).text)
        .join("\n");
      if (brief && brief.trim()) {
        if (smartModel) void recordSmartSpend(smartModel, response.usage?.input_tokens || 0, response.usage?.output_tokens || 0);
        return returnBrief(brief);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const lowCredits = msg.toLowerCase().includes("credit balance is too low");
      if (lowCredits) void autoDowngradeOnCreditDepletion();
      return NextResponse.json(
        {
          ticker,
          error: lowCredits
            ? "AI credits depleted — switched to free mode automatically."
            : msg,
        },
        { status: lowCredits ? 402 : 502 }
      );
    }
  }

  return NextResponse.json({ ticker, error: "Analysis unavailable." }, { status: 502 });
}
