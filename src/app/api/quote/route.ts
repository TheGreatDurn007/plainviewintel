import { NextResponse } from "next/server";
import { fetchRSI, fetchEarningsDate, fetchTechnicalData, fetchShortInterest } from "@/lib/market-context";
import { fetchFinnhubPriceTarget, fetchFinnhubMetrics } from "@/lib/finnhub";

function finite(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function positiveFinite(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36 Plainview/1.0",
  Accept: "application/json,text/plain,*/*",
};

/** Price + basic info from v8/chart — same endpoint used by /api/prices (proven reliable) */
async function chartData(symbol: string) {
  for (const host of ["query1", "query2"]) {
    try {
      const res = await fetch(
        `https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1d&includePrePost=true`,
        // PRICE — the only fast-moving field. Short shared cache: 100 concurrent users = 1 upstream
        // fetch per 30s, not 100. Still effectively live for a research tool.
        { headers: HEADERS, next: { revalidate: 30 } }
      );
      if (!res.ok) continue;
      const json = await res.json();
      const meta = json?.chart?.result?.[0]?.meta;
      if (!meta) continue;
      return {
        symbol: String(meta.symbol || symbol).toUpperCase(),
        name: (meta.longName || meta.shortName || null) as string | null,
        currency: (meta.currency || "USD") as string,
        marketState: (meta.marketState || null) as string | null,
        price: positiveFinite(meta.regularMarketPrice),
        preMarketPrice: positiveFinite(meta.preMarketPrice),
        postMarketPrice: positiveFinite(meta.postMarketPrice),
        previousClose:
          positiveFinite(meta.previousClose) ??
          positiveFinite(meta.chartPreviousClose),
        changePercent: finite(meta.regularMarketChangePercent),
      };
    } catch { /* try next host */ }
  }
  return null;
}

/**
 * Compute MA50, MA200, 52-week high/low from 1-year chart data.
 * Same v8/chart endpoint that already works reliably for RSI — no separate API needed.
 */
async function chartTechnicals(symbol: string) {
  for (const host of ["query1", "query2"]) {
    try {
      const res = await fetch(
        `https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1y&interval=1d`,
        // TECHNICALS (1y daily bars) — only change once a day after close. Cache 2h; this also dedupes
        // the chartTechnicals + computedBeta fetches, which hit the same URL.
        { headers: HEADERS, next: { revalidate: 7200 } }
      );
      if (!res.ok) continue;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const json: any = await res.json();
      const result = json?.chart?.result?.[0];
      if (!result) continue;
      const q = result?.indicators?.quote?.[0] ?? {};
      const rawC: unknown[] = q.close ?? [], rawH: unknown[] = q.high ?? [], rawL: unknown[] = q.low ?? [], rawV: unknown[] = q.volume ?? [];
      const closes: number[] = [], highs: number[] = [], lows: number[] = [], volumes: number[] = [];
      const fin = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
      for (let k = 0; k < rawC.length; k++) {
        if (fin(rawC[k]) && fin(rawH[k]) && fin(rawL[k]) && fin(rawV[k])) { closes.push(rawC[k] as number); highs.push(rawH[k] as number); lows.push(rawL[k] as number); volumes.push(rawV[k] as number); }
      }
      if (!closes.length) continue;
      const avg = (arr: number[], n: number) => arr.length >= n ? arr.slice(-n).reduce((a, b) => a + b, 0) / n : null;
      const avgVol30 = avg(volumes, 30);
      const currentVol = volumes.length ? volumes[volumes.length - 1] : null;

      // ── Volume-by-price (high-volume nodes) ─────────────────────────────────
      // The prices where the MOST shares actually changed hands are the levels the market truly
      // defends — more credible than any moving average. Bucket the 1y closes into price bins weighted
      // by that day's volume; the heaviest bins are the high-volume nodes. Uses the RAW (index-aligned)
      // close+volume arrays so each day's volume lands on its own day's price.
      const volumeNodes: number[] = (() => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const rc: any[] = q.close ?? [], rv: any[] = q.volume ?? [];
        const pairs: [number, number][] = [];
        for (let i = 0; i < rc.length; i++) {
          if (Number.isFinite(rc[i]) && Number.isFinite(rv[i]) && rc[i] > 0 && rv[i] > 0) pairs.push([rc[i], rv[i]]);
        }
        if (pairs.length < 30) return [];
        const ps = pairs.map(p => p[0]);
        const lo = Math.min(...ps), hi = Math.max(...ps);
        if (hi <= lo) return [];
        const N = 24, binW = (hi - lo) / N;
        const bins = new Array(N).fill(0);
        for (const [px, vol] of pairs) { const b = Math.min(N - 1, Math.max(0, Math.floor((px - lo) / binW))); bins[b] += vol; }
        const ranked = bins.map((v, i) => ({ v, price: lo + (i + 0.5) * binW, i })).sort((a, b) => b.v - a.v);
        const nodes: { price: number; i: number }[] = [];
        for (const r of ranked) {
          if (nodes.some(n => Math.abs(n.i - r.i) <= 1)) continue; // merge adjacent bins into one node
          nodes.push({ price: r.price, i: r.i });
          if (nodes.length >= 3) break;
        }
        return nodes.map(n => Math.round(n.price * 100) / 100);
      })();
      // Trailing returns (trading days ≈ 21/mo) — used for Trend Strength + Relative Strength.
      const last = closes[closes.length - 1];
      const retPct = (d: number): number | null => { const i = closes.length - 1 - d; return i >= 0 && closes[i] > 0 ? (last - closes[i]) / closes[i] * 100 : null; };

      const ma50now  = avg(closes, 50);
      const ma200now = avg(closes, 200);

      // ── ATR (14-day) ────────────────────────────────────────────────────────
      // True Range = max(high-low, |high-prevClose|, |low-prevClose|)
      // ATR14 = simple average of the last 14 TRs — sizes the buy zone to actual volatility.
      let atr14: number | null = null;
      if (highs.length >= 15 && lows.length >= 15) {
        const trs: number[] = [];
        const start = Math.max(closes.length - 15, 1);
        for (let i = start; i < closes.length; i++) {
          const h = highs[i] ?? closes[i], l = lows[i] ?? closes[i], pc = closes[i - 1];
          trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
        }
        if (trs.length >= 14) atr14 = trs.slice(-14).reduce((a, b) => a + b, 0) / 14;
      }

      // ── MA50 slope ──────────────────────────────────────────────────────────
      // Compare MA50 now vs MA50 fourteen trading days ago.
      // Positive → rising (MA50 is support); Negative → falling (MA50 is resistance).
      let ma50Slope: number | null = null;
      if (closes.length >= 64) {
        const ma50_14d_ago = avg(closes.slice(0, -14), 50);
        if (ma50now && ma50_14d_ago && ma50_14d_ago > 0) {
          ma50Slope = (ma50now - ma50_14d_ago) / ma50_14d_ago; // e.g. 0.023 = +2.3%/14d
        }
      }

      // ── Swing lows (last 60 trading days) ───────────────────────────────────
      // A swing low = a daily low that is lower than the 2 days before AND 2 days after it.
      // Returns up to 3 recent swing lows, sorted descending (nearest first), as price levels.
      // These are real demand zones where buyers actually stepped in — more reliable than a MA.
      const swingLows: number[] = [];
      if (lows.length >= 5) {
        const lookback = lows.slice(-60);
        for (let i = 2; i < lookback.length - 2; i++) {
          const v = lookback[i];
          if (v < lookback[i-1] && v < lookback[i-2] && v < lookback[i+1] && v < lookback[i+2]) {
            swingLows.push(v);
          }
        }
        // Keep 3 most recent (highest index = most recent), deduplicate within 1%
        swingLows.reverse();
        const deduped: number[] = [];
        for (const sl of swingLows) {
          if (!deduped.some(d => Math.abs(d - sl) / sl < 0.01)) deduped.push(sl);
          if (deduped.length >= 3) break;
        }
        swingLows.length = 0;
        swingLows.push(...deduped);
      }

      return {
        ma50:          ma50now,
        ma200:         ma200now,
        week52High:    highs.length   ? Math.max(...highs) : null,
        week52Low:     lows.length    ? Math.min(...lows)  : null,
        avgVolume:     avgVol30,
        currentVolume: currentVol,
        ret1mo:        retPct(21),
        ret3mo:        retPct(63),
        atr14,
        ma50Slope,
        swingLows,
        volumeNodes,
      };
    } catch { /* try next host */ }
  }
  return { ma50: null, ma200: null, week52High: null, week52Low: null, avgVolume: null, currentVolume: null, ret1mo: null, ret3mo: null, atr14: null, ma50Slope: null, swingLows: [] as number[], volumeNodes: [] as number[] };
}

/** SPY 3-month return — the market benchmark for Relative Strength. Cached hourly (shared). */
async function fetchSpyReturn(): Promise<number | null> {
  for (const host of ["query1", "query2"]) {
    try {
      const res = await fetch(
        `https://${host}.finance.yahoo.com/v8/finance/chart/SPY?range=6mo&interval=1d`,
        { headers: HEADERS, next: { revalidate: 3600 } }
      );
      if (!res.ok) continue;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const json: any = await res.json();
      const closes: number[] = (json?.chart?.result?.[0]?.indicators?.quote?.[0]?.close ?? [])
        .filter((v: unknown): v is number => typeof v === "number" && Number.isFinite(v));
      if (closes.length < 64) continue;
      const last = closes[closes.length - 1], prior = closes[closes.length - 1 - 63];
      if (prior > 0) return (last - prior) / prior * 100;
    } catch { /* try next */ }
  }
  return null;
}

/** Single-module quoteSummary fetch — uses Next.js 5-min cache to avoid Yahoo rate limits */
async function fetchModule(symbol: string, modules: string) {
  for (const host of ["query1", "query2"]) {
    try {
      const res = await fetch(
        `https://${host}.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=${modules}`,
        // FUNDAMENTALS (analyst targets, beta, float) — change only on filings/estimate updates. Cache 12h.
        { headers: HEADERS, next: { revalidate: 43200 } }
      );
      if (!res.ok) continue;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const json: any = await res.json();
      const result = json?.quoteSummary?.result?.[0];
      if (!result) continue;
      return result;
    } catch { /* try next host */ }
  }
  return null;
}

/** Analyst targets + float shares (used to compute short % from FINRA data) */
async function analystData(symbol: string) {
  const result = await fetchModule(symbol, "financialData,defaultKeyStatistics");
  if (!result) return null;
  const fd = result.financialData || {};
  const ks = result.defaultKeyStatistics || {};
  return {
    targetMeanPrice: positiveFinite(fd.targetMeanPrice?.raw),
    targetLowPrice:  positiveFinite(fd.targetLowPrice?.raw),
    targetHighPrice: positiveFinite(fd.targetHighPrice?.raw),
    numberOfAnalystOpinions: finite(fd.numberOfAnalystOpinions?.raw),
    floatShares: positiveFinite(ks.floatShares?.raw),
  };
}

/** Beta + short float from defaultKeyStatistics module */
async function statsData(symbol: string) {
  const result = await fetchModule(symbol, "defaultKeyStatistics");
  if (!result) return null;
  const ks = result.defaultKeyStatistics || {};
  return {
    beta: finite(ks.beta?.raw),
    shortPercentOfFloat: finite(ks.shortPercentOfFloat?.raw),
  };
}

/** Compute beta by correlating daily returns against SPY over 1 year */
async function computedBeta(symbol: string): Promise<number | null> {
  if (symbol === "SPY") return 1.0;
  const fetchCloses = async (sym: string): Promise<number[]> => {
    for (const host of ["query1", "query2"]) {
      try {
        const res = await fetch(
          `https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=1y&interval=1d`,
          { headers: HEADERS, next: { revalidate: 7200 } } // beta from 1y daily closes — cache 2h
        );
        if (!res.ok) continue;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const json: any = await res.json();
        const closes: unknown[] = json?.chart?.result?.[0]?.indicators?.quote?.[0]?.close ?? [];
        return closes.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
      } catch { /* try next */ }
    }
    return [];
  };
  const [stockCloses, spyCloses] = await Promise.all([fetchCloses(symbol), fetchCloses("SPY")]);
  const len = Math.min(stockCloses.length, spyCloses.length) - 1;
  if (len < 30) return null;
  const stockRet = Array.from({ length: len }, (_, i) => (stockCloses[i + 1] - stockCloses[i]) / stockCloses[i]);
  const spyRet   = Array.from({ length: len }, (_, i) => (spyCloses[i + 1]   - spyCloses[i])   / spyCloses[i]);
  const meanSpy = spyRet.reduce((a, b) => a + b, 0) / len;
  const varSpy  = spyRet.reduce((s, r) => s + (r - meanSpy) ** 2, 0) / len;
  if (varSpy === 0) return null;
  const meanStock = stockRet.reduce((a, b) => a + b, 0) / len;
  const cov = stockRet.reduce((s, r, i) => s + (r - meanStock) * (spyRet[i] - meanSpy), 0) / len;
  return Math.round((cov / varSpy) * 100) / 100;
}

/** Next earnings date from calendarEvents module */
async function earningsData(symbol: string): Promise<string | null> {
  const result = await fetchModule(symbol, "calendarEvents");
  if (!result) return null;
  const earningsDates: { raw: number }[] = result.calendarEvents?.earnings?.earningsDate ?? [];
  const now = Date.now() / 1000;
  const next = earningsDates.map((d) => d.raw).filter((ts) => ts > now - 86400).sort((a, b) => a - b)[0];
  return next ? new Date(next * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : null;
}

/** v7/quote fallback — more reliable for 52-week range, beta when v10 fails */
async function v7QuoteData(symbol: string) {
  for (const host of ["query1", "query2"]) {
    try {
      const res = await fetch(
        `https://${host}.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(symbol)}`,
        // 52-week range / beta / short float — slow-moving. Cache 1h.
        { headers: HEADERS, next: { revalidate: 3600 } }
      );
      if (!res.ok) continue;
      const json = await res.json();
      const q = json?.quoteResponse?.result?.[0];
      if (!q) continue;
      return {
        fiftyTwoWeekLow: positiveFinite(q.fiftyTwoWeekLow),
        fiftyTwoWeekHigh: positiveFinite(q.fiftyTwoWeekHigh),
        beta: finite(q.beta),
        shortPercentOfFloat: finite(q.shortPercentOfFloat),
        targetMeanPrice: positiveFinite(q.targetMeanPrice),
        targetLowPrice: positiveFinite(q.targetLowPrice),
        targetHighPrice: positiveFinite(q.targetHighPrice),
        numberOfAnalystOpinions: finite(q.numberOfAnalystOpinions),
      };
    } catch { continue; }
  }
  return null;
}

/** Try the bare ticker first, then Canadian exchange suffixes if no price found */
async function resolveSymbol(raw: string): Promise<string> {
  // Warrants: brokerages use .WS / .WT; Yahoo varies per listing (-WT, W suffix, etc.)
  const wm = raw.match(/^([A-Z]+)[.\-](WS|WT|WR|RT)$/i);
  if (wm) {
    const b = wm[1].toUpperCase();
    for (const c of [`${b}-WT`, `${b}W`, `${b}WT`, `${b}-WS`]) {
      const d = await chartData(c);
      if (d?.price) return c;
    }
  }
  const chart = await chartData(raw);
  if (chart?.price) return raw;
  // Strip any existing suffix before trying Canadian variants
  const base = raw.replace(/\.(TO|V|CN|NE|TSX)$/i, "");
  for (const suffix of [".TO", ".NE", ".V", ".CN"]) {
    const candidate = base + suffix;
    if (candidate === raw) continue;
    const c = await chartData(candidate);
    if (c?.price) return candidate;
  }
  return raw; // fall back to original even if no price
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const rawSymbol = (url.searchParams.get("symbol") || "").trim().toUpperCase();
  if (!rawSymbol) return NextResponse.json({ error: "Missing symbol" }, { status: 400 });
  // Optional: investor's recorded analyst target — used as a SECONDARY nudge to the Buy Zone
  // (Yahoo's analyst feed is often crumb-blocked). Technical support stays primary.
  const userAnalyst = (() => { const a = parseFloat(url.searchParams.get("analyst") || ""); return Number.isFinite(a) && a > 0 ? a : null; })();

  // Auto-resolve Canadian exchange suffix if bare ticker has no price
  const symbol = await resolveSymbol(rawSymbol);

  try {
    const [chart, analyst, taData, nextEarningsDate, rsiData, v7fb, tech, betaCalc, shortInt, spyRet3mo, finnTarget, finnMetrics] = await Promise.all([
      chartData(symbol),
      analystData(symbol),
      fetchTechnicalData(symbol),
      fetchEarningsDate(symbol),
      fetchRSI(symbol),
      v7QuoteData(symbol),
      chartTechnicals(symbol),
      computedBeta(symbol),
      fetchShortInterest(rawSymbol),
      fetchSpyReturn(),
      // Finnhub — unblocked second source for the fields Yahoo's crumb block costs us (analyst targets,
      // beta). Key-gated: null when FINNHUB_API_KEY is unset, so behaviour is unchanged without it.
      fetchFinnhubPriceTarget(symbol),
      fetchFinnhubMetrics(symbol),
    ]);

    if (!chart) {
      return NextResponse.json({ error: `No data for "${symbol}"` }, { status: 404 });
    }

    const price      = chart.postMarketPrice ?? chart.preMarketPrice ?? chart.price ?? null;
    const ma50       = tech?.ma50       ?? null;
    const ma200      = tech?.ma200      ?? null;
    const atr14      = tech?.atr14      ?? null;
    const ma50Slope  = tech?.ma50Slope  ?? null;   // +ve = rising support, -ve = falling resistance
    const swingLows  = tech?.swingLows  ?? [];
    const rsi        = rsiData.rsi;

    // Resolve short % of float once — reused by entry logic and the response below.
    const shortPercentVal: number | null = (() => {
      if (shortInt.shortPctFloat != null) return shortInt.shortPctFloat;
      const fromYahoo = taData?.shortPercentOfFloat ?? v7fb?.shortPercentOfFloat ?? null;
      if (fromYahoo !== null) return fromYahoo;
      const floatShares = analyst?.floatShares ?? null;
      if (shortInt.shortShares && floatShares && floatShares > 0) return shortInt.shortShares / floatShares;
      return null;
    })();

    // TA-based entry zone — computed server-side so the client can use it directly.
    // Step 1: pick the price anchor from MA structure + RSI + MA slope (the "where").
    // MA slope matters: a rising MA50 is genuine support; a falling MA50 is resistance in disguise.
    let suggestedEntry: number | null = null;
    let entryReason = "";
    const ma50Rising  = ma50Slope !== null && ma50Slope > 0.005;   // rising >0.5%/14d
    const ma50Falling = ma50Slope !== null && ma50Slope < -0.005;  // falling >0.5%/14d
    const slopeTag    = ma50Slope !== null
      ? (ma50Rising ? ` (MA50 rising ↑)` : ma50Falling ? ` (MA50 falling ↓ — use as target, not firm support)` : ` (MA50 flat)`)
      : "";

    if (price && ma50) {
      const pctAboveMa50 = (price - ma50) / ma50;
      if (rsi !== null && rsi >= 70) {
        // Overbought — wait for MA50 only if it's rising (actual support). If falling, go deeper.
        suggestedEntry = ma50Rising ? ma50 : (ma200 ?? ma50);
        entryReason = `RSI overbought (${rsi.toFixed(0)}) — wait for pullback to ${ma50Rising ? `MA50 $${ma50.toFixed(2)}` : `MA200 $${(ma200 ?? ma50).toFixed(2)}`}${slopeTag}`;
      } else if (pctAboveMa50 > 0.08) {
        // Extended above MA50 — use MA50 as entry only if it's rising support
        if (ma50Rising) {
          suggestedEntry = ma50;
          entryReason = `${(pctAboveMa50*100).toFixed(0)}% above MA50 — pullback to rising MA50 ($${ma50.toFixed(2)}) is the entry${slopeTag}`;
        } else {
          // Falling MA50 — look for the nearest swing low or MA200 instead
          const swingFloor = swingLows.find(sl => sl < price * 0.97);
          suggestedEntry = swingFloor ?? ma200 ?? ma50;
          entryReason = `${(pctAboveMa50*100).toFixed(0)}% above MA50${slopeTag} — extended on a declining trend; target ${swingFloor ? `swing low $${swingFloor.toFixed(2)}` : ma200 ? `MA200 $${ma200.toFixed(2)}` : `MA50 $${ma50.toFixed(2)}`}`;
        }
      } else if (pctAboveMa50 >= -0.05) {
        suggestedEntry = price;
        entryReason = `Price near MA50${slopeTag} — ${ma50Rising ? "technically sound entry zone" : ma50Falling ? "caution: MA50 declining — wait for stabilisation" : "entry zone, monitor slope"}`;
      } else if (ma200 && price > ma200) {
        suggestedEntry = ma200;
        entryReason = `Below MA50${slopeTag} — MA200 ($${ma200.toFixed(2)}) is the next support`;
      } else {
        // Below both MAs — nearest swing low is the most reliable level
        const swingFloor = swingLows.find(sl => sl <= price * 1.05);
        suggestedEntry = swingFloor ?? price;
        entryReason = `Below both MAs — ${swingFloor ? `recent swing low $${swingFloor.toFixed(2)} is the nearest demand zone` : "if thesis intact, current price may be the entry"}`;
      }
    } else if (tech?.week52Low && price) {
      suggestedEntry = Math.round(tech.week52Low * 1.1 * 100) / 100;
      entryReason = `No MA data — 10% above 52wk low as conservative anchor`;
    }

    // Step 2: layer in supporting factors that change an entry decision — all from
    // data already fetched above (no extra API calls). Each only appears when relevant.
    if (suggestedEntry !== null && price) {
      const factors: string[] = [];

      // Earnings proximity — binary risk before a print (most decision-relevant)
      if (nextEarningsDate) {
        const t = Date.parse(nextEarningsDate);
        if (Number.isFinite(t)) {
          const days = Math.ceil((t - Date.now()) / 86400000);
          if (days >= 0 && days <= 10) factors.push(`⚠ earnings in ${days}d — binary risk`);
        }
      }

      // Relative volume — conviction (accumulation) vs. fade
      const relVol = (tech?.currentVolume && tech?.avgVolume && tech.avgVolume > 0)
        ? tech.currentVolume / tech.avgVolume : null;
      if (relVol !== null) {
        if (relVol >= 1.5) factors.push(`vol ${relVol.toFixed(1)}× avg (elevated)`);
        else if (relVol <= 0.6) factors.push(`vol ${relVol.toFixed(1)}× avg (light)`);
      }

      // 52-week range position — how extended the entry is
      const week52High = tech?.week52High ?? v7fb?.fiftyTwoWeekHigh ?? null;
      if (week52High && week52High > 0) {
        const pctFromHigh = (week52High - price) / week52High * 100;
        if (pctFromHigh <= 5) factors.push(`near 52wk high — extended`);
        else if (pctFromHigh >= 40) factors.push(`${pctFromHigh.toFixed(0)}% below 52wk high — deep value zone`);
      }

      // Short interest — squeeze potential / crowded-short volatility
      if (shortPercentVal !== null && shortPercentVal >= 0.15) {
        factors.push(`short float ${(shortPercentVal*100).toFixed(0)}% — squeeze/volatility risk`);
      }

      if (factors.length) entryReason += ` · ${factors.join(' · ')}`;
    }

    // ── Deterministic Buy Zone ──────────────────────────────────────────────
    // Objective tiers from technical support + analyst consensus ONLY — no AI,
    // no invented valuation. Answers "where would I buy?" as a range, not a
    // false-precise single point.
    type BuyZone = {
      aggressive: [number, number] | null;
      ideal: [number, number] | null;
      deepValue: number | null;
      setup: string;
      patience: string;
      belowSupport?: boolean;
      confidence?: "high" | "medium" | "low";
      reason: string;
    };
    let buyZone: BuyZone | null = null;
    {
      const analystMean = analyst?.targetMeanPrice ?? v7fb?.targetMeanPrice ?? finnTarget?.mean ?? null;
      const analystLow  = analyst?.targetLowPrice  ?? v7fb?.targetLowPrice  ?? finnTarget?.low  ?? null;
      const w52Low      = tech?.week52Low ?? v7fb?.fiftyTwoWeekLow ?? null;
      const r2 = (x: number) => Math.round(x * 100) / 100;

      // PRIMARY anchor — MA slope now determines whether MA50 is usable as support.
      // A falling MA50 is resistance, not support; fall through to MA200 or swing lows.
      let techAnchor: number | null = null;
      const usedAnchors: string[] = [];
      const ma50Slope_ = tech?.ma50Slope ?? null;
      const ma50Rising_ = ma50Slope_ !== null && ma50Slope_ > 0.005;
      const swingLows_ = tech?.swingLows ?? [];

      if (ma50 != null && ma50 > 0 && ma50Rising_) {
        techAnchor = ma50;
        usedAnchors.push(`MA50 $${ma50.toFixed(2)} ↑`);
      } else if (ma50 != null && ma50 > 0 && !ma50Rising_) {
        // Declining MA50 — prefer the nearest swing low below price, or MA200
        const swingBelow = swingLows_.find(sl => sl < (price ?? Infinity));
        if (swingBelow) {
          techAnchor = swingBelow;
          usedAnchors.push(`swing low $${swingBelow.toFixed(2)} (MA50 declining)`);
        } else if (ma200 != null && ma200 > 0) {
          techAnchor = ma200;
          usedAnchors.push(`MA200 $${ma200.toFixed(2)} (MA50 declining)`);
        } else {
          techAnchor = ma50;
          usedAnchors.push(`MA50 $${ma50.toFixed(2)} ↓ (flat/declining)`);
        }
      } else if (ma200 != null && ma200 > 0){ techAnchor = ma200;      usedAnchors.push(`MA200 $${ma200.toFixed(2)}`); }
      else if (w52Low)                      { techAnchor = w52Low*1.15; usedAnchors.push(`15% above 52wk low $${w52Low.toFixed(2)}`); }
      else if (price)                       { techAnchor = price*0.82;  usedAnchors.push("~18% below current"); }

      // SECONDARY: analyst consensus only NUDGES the zone (≤10%), never drives it.
      let idealCenter: number | null = techAnchor;
      const analystAnchor = userAnalyst ?? analystMean;
      if (techAnchor && analystAnchor != null && analystAnchor > 0) {
        const ANALYST_WEIGHT = 0.3;
        const blended = techAnchor * (1 - ANALYST_WEIGHT) + analystAnchor * ANALYST_WEIGHT;
        const maxNudge = techAnchor * 0.10;
        idealCenter = Math.max(techAnchor - maxNudge, Math.min(techAnchor + maxNudge, blended));
        usedAnchors.push(`analyst $${analystAnchor.toFixed(2)} (nudge)`);
      }

      if (idealCenter && price) {
        // ── ATR-calibrated zone width ───────────────────────────────────────
        // Instead of a fixed ±4% for every stock, size the zone by how much the
        // stock actually moves day-to-day. A 0.5 ATR band is tighter on stable
        // names (MSFT ~$2 ATR → ±0.5%) and wider on volatile ones (AAOI ~$8 ATR → ±4.5%).
        // Fallback to ±4% only when ATR is unavailable.
        const atr = tech?.atr14 ?? null;
        const halfBand = atr && idealCenter > 0
          ? Math.min(Math.max(atr * 0.5, idealCenter * 0.02), idealCenter * 0.08) // clamp 2–8%
          : idealCenter * 0.04;

        const idealLow  = idealCenter - halfBand;
        const idealHigh = idealCenter + halfBand;
        const aggLow    = idealHigh;
        const aggHigh   = idealCenter + halfBand * 2.5;  // aggressive = 1–2.5× ATR above ideal

        // ── Deep Value = the deepest STRONG support that actually gets tested (never a forced haircut) ──
        // We look at the levels traders genuinely buy: tested swing lows, the 200-day average, and the
        // 50%/61.8% Fibonacci retracements of the 52-week range. We take the DEEPEST of those (the real
        // bargain) — but it must be a genuine discount (≥5% below the ideal-low), otherwise it's just the
        // ideal zone again. When no strong level qualifies, we drop to the 52-week low as the capitulation
        // backstop. Labelled by its true source + the honest % drop, so reachability is never hidden.
        const fibRange = (tech?.week52High && w52Low && tech.week52High > w52Low) ? (tech.week52High - w52Low) : null;
        const fib50  = fibRange ? (tech!.week52High as number) - fibRange * 0.5   : null;
        const fib618 = fibRange ? (tech!.week52High as number) - fibRange * 0.618 : null;
        const volNodes_ = tech?.volumeNodes ?? [];
        const strong: { price: number; label: string }[] = [];
        for (const sl of swingLows_) if (sl < idealLow && sl > 0) strong.push({ price: sl, label: `swing low $${sl.toFixed(2)}` });
        for (const vn of volNodes_) if (vn < idealLow && vn > 0) strong.push({ price: vn, label: `high-volume shelf $${vn.toFixed(2)}` });
        if (ma200 != null && ma200 > 0 && ma200 < idealLow)   strong.push({ price: ma200,  label: `MA200 $${ma200.toFixed(2)}` });
        if (fib618 != null && fib618 > 0 && fib618 < idealLow) strong.push({ price: fib618, label: `61.8% retracement $${fib618.toFixed(2)}` });
        if (fib50  != null && fib50  > 0 && fib50  < idealLow) strong.push({ price: fib50,  label: `50% retracement $${fib50.toFixed(2)}` });
        const deepestStrong = strong.length ? strong.reduce((a, b) => (b.price < a.price ? b : a)) : null;
        let dvLevel: { price: number; label: string } | null = null;
        if (deepestStrong && deepestStrong.price <= idealLow * 0.95) dvLevel = deepestStrong;       // a real discount
        else if (w52Low != null && w52Low > 0 && w52Low < idealLow)  dvLevel = { price: w52Low, label: `52-week low $${w52Low.toFixed(2)}` };
        else if (deepestStrong)                                       dvLevel = deepestStrong;       // shallow, but it's all we have
        let deepValue: number;
        if (dvLevel) {
          deepValue = dvLevel.price;
          const dropPct = price ? Math.round((price - deepValue) / price * 100) : null;
          usedAnchors.push(`${dvLevel.label} (deep value${dropPct != null && dropPct > 0 ? `, −${dropPct}%` : ""})`);
        } else {
          // No real support below at all (price at multi-year lows) — mark a measured estimate AS an
          // estimate rather than faking a level.
          deepValue = idealLow * 0.90;
          usedAnchors.push(`est. floor $${r2(deepValue)} (no firm support below)`);
        }

        // ── Confluence: a level is credible when MULTIPLE independent methods agree on it ──
        // Case logic: JPM's deep value lands where MA200 + a swing low + a Fib retracement all cluster
        // within ~2% → "high confidence, 3 methods agree". A lone swing low with nothing near it →
        // "low confidence, single method". Abstract: scores any anchor from whatever real levels exist.
        const fib382c = fibRange ? (tech!.week52High as number) - fibRange * 0.382 : null;
        const allLevels: { p: number; src: string }[] = [];
        for (const sl of swingLows_) if (sl > 0) allLevels.push({ p: sl, src: "swing low" });
        for (const vn of volNodes_) if (vn > 0) allLevels.push({ p: vn, src: "volume shelf" });
        if (ma50   != null && ma50   > 0) allLevels.push({ p: ma50,   src: "MA50" });
        if (ma200  != null && ma200  > 0) allLevels.push({ p: ma200,  src: "MA200" });
        if (fib382c != null && fib382c > 0) allLevels.push({ p: fib382c, src: "38.2% Fib" });
        if (fib50  != null && fib50  > 0) allLevels.push({ p: fib50,  src: "50% Fib" });
        if (fib618 != null && fib618 > 0) allLevels.push({ p: fib618, src: "61.8% Fib" });
        if (w52Low != null && w52Low > 0) allLevels.push({ p: w52Low, src: "52-week low" });
        const confluenceAt = (target: number): string[] => {
          const tol = Math.max(target * 0.02, (tech?.atr14 ?? 0) * 0.5); // ~2% of the level, or half an ATR
          return [...new Set(allLevels.filter(l => Math.abs(l.p - target) <= tol).map(l => l.src))];
        };
        const dvSrcs = confluenceAt(deepValue);
        const idealSrcs = confluenceAt(idealCenter);
        const maxConfluence = Math.max(dvSrcs.length, idealSrcs.length);
        const confidence: "high" | "medium" | "low" = maxConfluence >= 3 ? "high" : maxConfluence >= 2 ? "medium" : "low";
        // Surface the strongest cluster in the reason so the user sees WHY a level is trustworthy.
        const bestCluster = dvSrcs.length >= idealSrcs.length ? dvSrcs : idealSrcs;
        const confluenceNote = bestCluster.length >= 2 ? `${bestCluster.join(" + ")} cluster here (${bestCluster.length}-method support)` : null;

        // ── Self-check invariant: a buy target can never sit above the current price ──
        // You can always buy at market, so a "buy zone" above the price is meaningless. When price is
        // below the ENTIRE support structure (a collapsed / deeply-oversold name like CAN at $0.32 with
        // support at $0.76), the technical model doesn't apply — flag it so the UI says so honestly
        // instead of inventing an above-price zone. Bands are also capped at the price for display.
        const belowSupport = price != null && price > 0 && price < deepValue;

        // Setup = where the current price sits relative to the buy bands.
        let setup: string;
        if (belowSupport)            setup = "Below support";
        else if (price > aggHigh * 1.10)  setup = "Overextended";
        else if (price > aggHigh)    setup = "Approaching";
        else if (price >= idealLow)  setup = "In Buy Zone";
        else if (price >= deepValue) setup = "Below Ideal — value";
        else                          setup = "Deep Value";

        // Patience = how far above the nearest buy band (aggressive high).
        let patience: string;
        if (belowSupport)            patience = "n/a";
        else if (price <= aggHigh)   patience = "Low";
        else if ((price - aggHigh) / aggHigh <= 0.15) patience = "Medium";
        else                          patience = "High";

        // Cap every displayed band at the current price — never show a target above where it trades.
        const cap = (x: number) => (price != null && price > 0 && x > price) ? price : x;

        buyZone = {
          aggressive: [r2(cap(aggLow)), r2(cap(aggHigh))],
          ideal: [r2(cap(idealLow)), r2(cap(idealHigh))],
          deepValue: r2(cap(deepValue)),
          setup,
          patience,
          belowSupport,
          confidence,
          reason: belowSupport
            ? `Trading below all support (nearest ${usedAnchors[0] || "support"}) — deeply oversold or in structural decline; no reliable technical entry above. Treat as a thesis/catalyst call.`
            : (usedAnchors.length ? `Anchored to ${usedAnchors.join(" + ")}${confluenceNote ? ` · ${confluenceNote}` : ""}` : "Technical support"),
        };
      }
    }

    const resolvedBeta = taData?.beta ?? v7fb?.beta ?? finnMetrics?.beta ?? betaCalc ?? null;

    // ── Momentum & risk signals (deterministic, for the market-context strip) ──
    // Trend Strength: MA structure + RSI + 3-month return.
    let trendStrength: { label: string; tone: "good" | "warn" | "bad" } | null = null;
    if (price && (ma50 != null || ma200 != null)) {
      let s = 0;
      if (ma50 != null && price > ma50) s++;
      if (ma200 != null && price > ma200) s++;
      if (ma50 != null && ma200 != null && ma50 > ma200) s++;
      if (rsi != null) { if (rsi > 55) s++; else if (rsi < 45) s--; }
      if (tech?.ret3mo != null) { if (tech.ret3mo > 5) s++; else if (tech.ret3mo < -5) s--; }
      trendStrength = { label: s >= 3 ? "Strong" : s <= 0 ? "Weak" : "Neutral", tone: s >= 3 ? "good" : s <= 0 ? "bad" : "warn" };
    }

    // Relative Strength vs the market (SPY) over 3 months.
    let relativeStrength: { label: string; tone: "good" | "warn" | "bad" } | null = null;
    if (tech?.ret3mo != null && spyRet3mo != null) {
      const diff = tech.ret3mo - spyRet3mo;
      // Short, fixed vocabulary (≤7 chars) so the value never wraps inside its context-grid cell on any ticker.
      relativeStrength = { label: diff > 5 ? "Leading" : diff < -5 ? "Lagging" : "In line", tone: diff > 5 ? "good" : diff < -5 ? "bad" : "warn" };
    }

    // Catalyst / event risk: earnings proximity + RSI extreme + short interest + beta.
    let catalystRisk: { label: string; tone: "good" | "warn" | "bad" } | null = null;
    {
      const daysToEarnings = (() => {
        if (!nextEarningsDate) return null;
        const t = Date.parse(nextEarningsDate);
        return Number.isFinite(t) ? Math.ceil((t - Date.now()) / 86400000) : null;
      })();
      const shortPct = shortPercentVal != null ? shortPercentVal * 100 : null;
      let high = false, med = false;
      if (daysToEarnings != null && daysToEarnings >= 0 && daysToEarnings <= 10) high = true;
      if (rsi != null && (rsi >= 78 || rsi <= 22)) high = true;
      if (shortPct != null && shortPct >= 20) high = true;
      if (daysToEarnings != null && daysToEarnings > 10 && daysToEarnings <= 35) med = true;
      if (rsi != null && (rsi >= 70 || rsi <= 30)) med = true;
      if (shortPct != null && shortPct >= 10) med = true;
      if (resolvedBeta != null && resolvedBeta >= 1.6) med = true;
      catalystRisk = { label: high ? "High" : med ? "Medium" : "Low", tone: high ? "bad" : med ? "warn" : "good" };
    }

    // ── Short-interest squeeze metrics (for the strip) ──
    // Source: stockanalysis.com (short shares + % of float + days-to-cover, all exchanges).
    const floatSharesVal = analyst?.floatShares ?? null;
    const shortSharesVal = shortInt.shortShares ?? (shortPercentVal != null && floatSharesVal ? shortPercentVal * floatSharesVal : null);
    const daysToCover = shortInt.daysToCover
      ?? ((shortSharesVal && tech?.avgVolume && tech.avgVolume > 0) ? Math.round(shortSharesVal / tech.avgVolume * 10) / 10 : null);

    return NextResponse.json({
      ...chart,
      fiftyTwoWeekLow:         tech?.week52Low           ?? v7fb?.fiftyTwoWeekLow         ?? null,
      fiftyTwoWeekHigh:        tech?.week52High          ?? v7fb?.fiftyTwoWeekHigh        ?? null,
      ma50,
      ma200,
      targetMeanPrice:         analyst?.targetMeanPrice  ?? v7fb?.targetMeanPrice         ?? finnTarget?.mean ?? null,
      targetLowPrice:          analyst?.targetLowPrice   ?? v7fb?.targetLowPrice          ?? finnTarget?.low  ?? null,
      targetHighPrice:         analyst?.targetHighPrice  ?? v7fb?.targetHighPrice         ?? finnTarget?.high ?? null,
      numberOfAnalystOpinions: analyst?.numberOfAnalystOpinions ?? v7fb?.numberOfAnalystOpinions ?? null,
      beta:                    resolvedBeta,
      shortPercentOfFloat: shortPercentVal,
      // Volume from chart data — works for all stocks including small caps
      avgVolume:     tech?.avgVolume     ?? taData?.avgVolume     ?? null,
      currentVolume: tech?.currentVolume ?? taData?.currentVolume ?? null,
      nextEarningsDate:        nextEarningsDate ?? null,
      rsi,
      rsiSignal:               rsiData.rsiSignal,
      suggestedEntry,
      entryReason,
      buyZone,
      atr14,
      ma50Slope,
      swingLows,
      trendStrength,
      relativeStrength,
      catalystRisk,
      daysToCover,
      shortShares: shortSharesVal,
      floatShares: floatSharesVal,
      resolvedSymbol: symbol !== rawSymbol ? symbol : null, // tells client a suffix was added
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
