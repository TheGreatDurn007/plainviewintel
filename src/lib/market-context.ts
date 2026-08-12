/**
 * Shared data-fetching helpers for AI routes.
 * All sources are free and require no user API keys.
 */

import { createClient } from "@supabase/supabase-js";
import { fetchYahooXray } from "@/lib/yahoo";
import type { XrayResult } from "@/types";
import { form4Action, buildForm4Insight, form4PurchaseSummary, shortTitle } from "./form4-insight";
import type { Form4Role, Form4Insight, Form4Parsed } from "./form4-insight";

const YF_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36 Plainview/1.0",
  Accept: "application/json,text/plain,*/*",
};

// ---------------------------------------------------------------------------
// Data fetchers
// ---------------------------------------------------------------------------

/** Next upcoming earnings date as a human-readable string, e.g. "July 14, 2025" */
// ── Finnhub — FREE fallback (60 calls/min) for the data Yahoo's crumb-gated quoteSummary blocks: the
// upcoming earnings DATE (no other free source has it) and basic fundamentals (revenue growth, margins).
// Key = FINNHUB_API_KEY. NO key → every call returns null immediately and makes NO request (clean no-op).
// Fail-open everywhere. (FMP was tried first but gutted its free tier — every endpoint is now paid-only.)
const FINNHUB_BASE = "https://finnhub.io/api/v1";
function finnhubSymbol(ticker: string): string { return ticker.replace(/\..*$/, "").toUpperCase(); }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function finnhubGet(path: string): Promise<any | null> {
  const key = process.env.FINNHUB_API_KEY; if (!key) return null;
  try {
    const sep = path.includes("?") ? "&" : "?";
    const res = await fetch(`${FINNHUB_BASE}${path}${sep}token=${key}`, { next: { revalidate: 3600 } });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}
async function finnhubEarningsDate(ticker: string): Promise<string | null> {
  // The earnings calendar needs an explicit date range — without from/to it returns nothing, and the next
  // print can be a couple months out. Window: today → +120 days.
  const from = new Date().toISOString().slice(0, 10);
  const to = new Date(Date.now() + 120 * 86400000).toISOString().slice(0, 10);
  const j = await finnhubGet(`/calendar/earnings?symbol=${encodeURIComponent(finnhubSymbol(ticker))}&from=${from}&to=${to}`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cal: any[] = Array.isArray(j?.earningsCalendar) ? j.earningsCalendar : [];
  const today = new Date().toISOString().slice(0, 10);
  const upcoming = cal.map((e) => e?.date).filter((d): d is string => typeof d === "string" && d >= today).sort()[0];
  if (!upcoming) return null;
  const d = new Date(upcoming + "T00:00:00Z");
  if (isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
}
async function finnhubFinancials(ticker: string): Promise<FinancialSnapshot> {
  const empty: FinancialSnapshot = { totalCash: null, totalDebt: null, netCash: null, operatingCashflow: null, grossMargins: null, revenueGrowth: null };
  const j = await finnhubGet(`/stock/metric?symbol=${encodeURIComponent(finnhubSymbol(ticker))}&metric=all`);
  const m = j?.metric; if (!m) return empty;
  const num = (v: unknown) => (typeof v === "number" && isFinite(v)) ? v : null;
  const gm = num(m.grossMarginTTM);          // Finnhub returns margins as a PERCENT (e.g. 45.4)
  const rg = num(m.revenueGrowthTTMYoy);      // percent
  return { ...empty, grossMargins: gm != null ? gm / 100 : null, revenueGrowth: rg != null ? rg / 100 : null };
}

export async function fetchEarningsDate(ticker: string): Promise<string | null> {
  const y = await yahooEarningsDate(ticker);
  if (y) return y;
  return finnhubEarningsDate(ticker); // Finnhub fallback — the real upcoming date Yahoo's crumb-block hides
}
async function yahooEarningsDate(ticker: string): Promise<string | null> {
  try {
    const res = await fetch(
      `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(ticker)}?modules=calendarEvents`,
      { headers: YF_HEADERS, next: { revalidate: 3600 } }
    );
    if (!res.ok) return null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const json: any = await res.json();
    const earningsDates: { raw: number }[] =
      json?.quoteSummary?.result?.[0]?.calendarEvents?.earnings?.earningsDate ?? [];
    const now = Date.now() / 1000;
    const upcoming = earningsDates
      .map((d) => d.raw)
      .filter((ts) => ts > now - 86400)
      .sort((a, b) => a - b)[0];
    if (!upcoming) return null;
    return new Date(upcoming * 1000).toLocaleDateString("en-US", {
      month: "long",
      day: "numeric",
      year: "numeric",
    });
  } catch {
    return null;
  }
}

export type AnalystTargets = {
  mean: number | null;
  high: number | null;
  low: number | null;
  /** true when price has already surpassed consensus — target is likely stale/lagging */
  stale?: boolean;
  /** number of independent sources that agreed (1 = Yahoo only, 2 = confirmed by StockAnalysis) */
  sources?: number;
};

export type TechnicalData = {
  ma50: number | null;
  ma200: number | null;
  week52High: number | null;
  week52Low: number | null;
  avgVolume: number | null;
  currentVolume: number | null;
  beta: number | null;
  shortPercentOfFloat: number | null;
  floatShares: number | null;
  shortShares: number | null;
  daysToCover: number | null;
  rsi: number | null;
  rsiSignal: "overbought" | "oversold" | "neutral" | null;
  /** MA50 slope over last 14 trading days: (ma50_now - ma50_14d_ago) / ma50_14d_ago */
  ma50Slope: number | null;
  /** Prior session close — for the daily brief's day-change %. */
  prevClose: number | null;
};

function computeRSI(closes: number[], period = 14): number | null {
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff; else losses -= diff;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(diff, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-diff, 0)) / period;
  }
  if (avgLoss === 0) return 100;
  return Math.round((100 - 100 / (1 + avgGain / avgLoss)) * 10) / 10;
}

type ChartTA = { rsi: number | null; rsiSignal: TechnicalData["rsiSignal"]; ma50Slope: number | null; ma50: number | null; ma200: number | null; week52High: number | null; week52Low: number | null };
async function fetchRSIFromChart(ticker: string): Promise<ChartTA> {
  const NULL: ChartTA = { rsi: null, rsiSignal: null, ma50Slope: null, ma50: null, ma200: null, week52High: null, week52Low: null };
  try {
    // 1y daily history → RSI(14) + MA50 + MA200 + 52-week range, ALL from the crumb-FREE chart endpoint.
    // (The quoteSummary fields for the MAs / 52-week high are crumb-gated and frequently blocked, which
    // left the Setup Score blind to trend/extension — this is the reliable source the X-Ray path uses.)
    const res = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=1y&interval=1d`,
      { headers: YF_HEADERS, next: { revalidate: 300 } }
    );
    if (!res.ok) return NULL;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const json: any = await res.json();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rawCloses: unknown[] = json?.chart?.result?.[0]?.indicators?.quote?.[0]?.close ?? [];
    const closes = rawCloses.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
    if (!closes.length) return NULL;
    const avg = (arr: number[], n: number) => arr.length >= n ? arr.slice(-n).reduce((a, b) => a + b, 0) / n : null;
    const ma50 = avg(closes, 50);
    const ma200 = avg(closes, 200);
    const week52High = Math.max(...closes);
    const week52Low = Math.min(...closes);
    const rsi = computeRSI(closes);
    const rsiSignal: TechnicalData["rsiSignal"] = rsi == null ? null : rsi >= 70 ? "overbought" : rsi <= 30 ? "oversold" : "neutral";
    // MA50 slope: MA50 now vs MA50 14 trading days ago.
    let ma50Slope: number | null = null;
    const ma50Ago = closes.length >= 64 ? avg(closes.slice(0, -14), 50) : null;
    if (ma50 !== null && ma50Ago !== null && ma50Ago > 0) ma50Slope = (ma50 - ma50Ago) / ma50Ago;
    return { rsi, rsiSignal, ma50Slope, ma50, ma200, week52High, week52Low };
  } catch {
    return NULL;
  }
}

export type ShortInterestData = {
  shortShares: number | null;
  shortPctFloat: number | null;   // fraction, e.g. 0.0913 = 9.13% of float
  daysToCover: number | null;
  shortPriorMonth: number | null; // prior-month short shares (for trend)
};

/**
 * One-line business description — what the company actually does. Grounds every AI brief so
 * it never invents the business (e.g. framing Canaan as "a CLARITY-Act bet" instead of a
 * chip + bitcoin-mining-hardware maker). Free, keyless, from stockanalysis.com. Skipped for
 * Canadian-suffixed tickers (.TO etc.) where the bare symbol could collide with a US company.
 */
export async function fetchCompanyDescription(ticker: string): Promise<string | null> {
  if (/\.(TO|V|CN|NE|TSX)$/i.test(ticker)) return null;
  try {
    const sym = ticker.replace(/\..*$/, "");
    const res = await fetch(
      `https://stockanalysis.com/api/symbol/s/${encodeURIComponent(sym)}/overview`,
      { headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" }, next: { revalidate: 86400 } }
    );
    if (!res.ok) return null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data: any = await res.json();
    const desc = String(data?.data?.description || "").trim();
    if (!desc) return null;
    // Keep ~2 sentences so it grounds without bloating the prompt.
    return desc.length > 340 ? desc.slice(0, 340).replace(/\s+\S*$/, "") + "…" : desc;
  } catch { return null; }
}

/**
 * Live Bitcoin spot price (USD) from CoinGecko — free, keyless. Used to GROUND any
 * crypto-exposed equity (miners like CAN/MARA/RIOT, holders like MSTR) so the AI cites
 * the real BTC level instead of a stale one from training memory (the "$91k" bug).
 * Cached 10 min. Returns null on any failure (the prompt's no-hallucination guardrail
 * then keeps the AI from inventing a number).
 */
export async function fetchBitcoinPrice(): Promise<number | null> {
  try {
    const res = await fetch(
      "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd",
      { headers: { Accept: "application/json" }, next: { revalidate: 600 } }
    );
    if (!res.ok) return null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data: any = await res.json();
    const px = Number(data?.bitcoin?.usd);
    return Number.isFinite(px) && px > 0 ? px : null;
  } catch { return null; }
}

/**
 * Short interest — stockanalysis.com /statistics (free, keyless, covers ALL US
 * exchanges incl. NYSE). Gives short shares, short % of float, days-to-cover, and
 * prior-month short shares. Replaces Nasdaq (Nasdaq-listed only — missed AMC/NOK)
 * and Yahoo defaultKeyStatistics (crumb-blocked 401).
 */
export async function fetchShortInterest(ticker: string): Promise<ShortInterestData> {
  const empty: ShortInterestData = { shortShares: null, shortPctFloat: null, daysToCover: null, shortPriorMonth: null };
  // US-only source — skip Canadian-suffixed tickers so the stripped symbol doesn't collide with a US security.
  if (/\.(TO|V|CN|NE)$/i.test(ticker)) return empty;
  try {
    const res = await fetch(
      `https://stockanalysis.com/api/symbol/s/${encodeURIComponent(ticker.replace(/\..*$/, ""))}/statistics`,
      { headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" }, next: { revalidate: 86400 } }
    );
    if (!res.ok) return empty;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data: any = await res.json();
    const rows: { id: string; hover?: string; value?: string }[] = data?.data?.shortSelling?.data ?? [];
    if (!rows.length) return empty;
    const num = (id: string): number | null => {
      const row = rows.find(r => r.id === id);
      if (!row) return null;
      const n = Number(String(row.hover ?? row.value ?? "").replace(/[^0-9.\-]/g, ""));
      return Number.isFinite(n) ? n : null;
    };
    const pctFloat = num("shortFloat"); // expressed as a percent number (e.g. 9.131)
    const dtc = num("shortRatio");
    return {
      shortShares: num("shortInterest"),
      shortPctFloat: pctFloat != null ? pctFloat / 100 : null,
      daysToCover: dtc != null ? Math.round(dtc * 10) / 10 : null,
      shortPriorMonth: num("shortPriorMonth"),
    };
  } catch { return empty; }
}

/** Technical levels from Yahoo Finance: MAs, 52wk range, volume, beta, RSI(14) */
export async function fetchTechnicalData(ticker: string): Promise<TechnicalData> {
  const empty: TechnicalData = { ma50: null, ma200: null, week52High: null, week52Low: null, avgVolume: null, currentVolume: null, beta: null, shortPercentOfFloat: null, floatShares: null, shortShares: null, daysToCover: null, rsi: null, rsiSignal: null, ma50Slope: null, prevClose: null };
  try {
    const [summaryRes, rsiData, shortInt] = await Promise.all([
      fetch(
        `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(ticker)}?modules=summaryDetail,defaultKeyStatistics`,
        { headers: YF_HEADERS, next: { revalidate: 300 } }
      ).catch(() => null),
      fetchRSIFromChart(ticker),
      fetchShortInterest(ticker),
    ]);
    if (!summaryRes?.ok) return { ...empty, ...rsiData, shortPercentOfFloat: shortInt.shortPctFloat, shortShares: shortInt.shortShares, daysToCover: shortInt.daysToCover };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const json: any = await summaryRes.json();
    const sd = json?.quoteSummary?.result?.[0]?.summaryDetail;
    const ks = json?.quoteSummary?.result?.[0]?.defaultKeyStatistics;
    return {
      ...rsiData, // chart-derived rsi/ma50/ma200/52w (reliable, crumb-free) — overridden below by quoteSummary when it IS available
      ma50:          sd?.fiftyDayAverage?.raw      ?? rsiData.ma50      ?? null,
      ma200:         sd?.twoHundredDayAverage?.raw ?? rsiData.ma200     ?? null,
      week52High:    sd?.fiftyTwoWeekHigh?.raw     ?? rsiData.week52High ?? null,
      week52Low:     sd?.fiftyTwoWeekLow?.raw      ?? rsiData.week52Low  ?? null,
      avgVolume:     sd?.averageVolume?.raw         ?? null,
      currentVolume: sd?.volume?.raw               ?? null,
      prevClose:     sd?.previousClose?.raw         ?? null,
      beta:                ks?.beta?.raw                    ?? null,
      shortPercentOfFloat: shortInt.shortPctFloat ?? (() => {
        const direct = ks?.shortPercentOfFloat?.raw ?? ks?.shortPercentSharesOut?.raw ?? null;
        if (direct !== null) return direct;
        const sharesShort = ks?.sharesShort?.raw ?? null;
        const floatShares = ks?.floatShares?.raw ?? null;
        return (sharesShort && floatShares && floatShares > 0) ? sharesShort / floatShares : null;
      })(),
      floatShares: ks?.floatShares?.raw ?? null,
      shortShares: shortInt.shortShares,
      daysToCover: shortInt.daysToCover,
    };
  } catch {
    return empty;
  }
}

/** RSI(14) only — lightweight, used by quote route for Decide tool */
export async function fetchRSI(ticker: string): Promise<{ rsi: number | null; rsiSignal: TechnicalData["rsiSignal"] }> {
  return fetchRSIFromChart(ticker);
}

export type FinancialSnapshot = {
  totalCash: number | null;
  totalDebt: number | null;
  netCash: number | null;
  operatingCashflow: number | null;
  grossMargins: number | null;
  revenueGrowth: number | null;
};

function fmtMoney(n: number | null): string | null {
  if (n === null || !Number.isFinite(n)) return null;
  const abs = Math.abs(n);
  if (abs >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `$${(n / 1e3).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}

/**
 * Yahoo Finance financialData module — cash, debt, operating cash flow, margins.
 * Works for stocks that don't file with SEC (Canadian, foreign listings).
 */
export async function fetchFinancialSnapshot(ticker: string): Promise<FinancialSnapshot> {
  const y = await yahooFinancialSnapshot(ticker);
  // Yahoo's financialData is crumb-gated and usually blocked (everything null) → fall back to FMP, then
  // merge so any non-null from either source wins.
  if (y.grossMargins != null || y.revenueGrowth != null || y.operatingCashflow != null || y.netCash != null) return y;
  const f = await finnhubFinancials(ticker);
  return {
    totalCash: y.totalCash ?? f.totalCash,
    totalDebt: y.totalDebt ?? f.totalDebt,
    netCash: y.netCash ?? f.netCash,
    operatingCashflow: y.operatingCashflow ?? f.operatingCashflow,
    grossMargins: y.grossMargins ?? f.grossMargins,
    revenueGrowth: y.revenueGrowth ?? f.revenueGrowth,
  };
}
async function yahooFinancialSnapshot(ticker: string): Promise<FinancialSnapshot> {
  const empty: FinancialSnapshot = { totalCash: null, totalDebt: null, netCash: null, operatingCashflow: null, grossMargins: null, revenueGrowth: null };
  try {
    const res = await fetch(
      `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(ticker)}?modules=financialData`,
      { headers: YF_HEADERS, next: { revalidate: 3600 } }
    );
    if (!res.ok) return empty;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const json: any = await res.json();
    const fd = json?.quoteSummary?.result?.[0]?.financialData;
    if (!fd) return empty;
    const totalCash = fd.totalCash?.raw ?? null;
    const totalDebt = fd.totalDebt?.raw ?? null;
    return {
      totalCash,
      totalDebt,
      netCash: (Number.isFinite(totalCash) && Number.isFinite(totalDebt)) ? totalCash - totalDebt : totalCash,
      operatingCashflow: fd.operatingCashflow?.raw ?? null,
      grossMargins: fd.grossMargins?.raw ?? null,
      revenueGrowth: fd.revenueGrowth?.raw ?? null,
    };
  } catch {
    return empty;
  }
}

export function formatFinancialSnapshot(snap: FinancialSnapshot): string {
  const lines: string[] = [];
  if (snap.netCash !== null) lines.push(`Net cash: ${fmtMoney(snap.netCash)}${snap.netCash >= 0 ? " — no debt concern" : " — net debt position"}`);
  if (snap.operatingCashflow !== null) lines.push(`Operating cash flow: ${fmtMoney(snap.operatingCashflow)}${snap.operatingCashflow > 0 ? " — cash flow positive" : " — burning cash"}`);
  if (snap.grossMargins !== null) lines.push(`Gross margin: ${(snap.grossMargins * 100).toFixed(1)}%`);
  if (snap.revenueGrowth !== null) lines.push(`Revenue growth YoY: ${snap.revenueGrowth >= 0 ? "+" : ""}${(snap.revenueGrowth * 100).toFixed(1)}%`);
  return lines.join("\n");
}

/**
 * Cash-runway survival check from SEC EDGAR companyconcept (crumb-FREE, unlike Yahoo financialData).
 * Returns cash on hand + TTM operating cash flow + months of runway when the company is burning.
 * Lean by design: 2 concept fetches (cash, operating cash flow), us-gaap then ifrs fallback. Used by
 * the radar survival filter, so it only runs for the few Research-eligible small-caps per scan.
 */
export type CashRunway = { cash: number | null; opCashTtm: number | null; runwayMonths: number | null };
const SEC_HEADERS = { "User-Agent": "Plainview investing tool plainview@dar-fishman.com", Accept: "application/json" };
type SecRow = { val: number; fp?: string; form?: string; end?: string; start?: string };
const SEC_FORMS = new Set(["10-Q", "10-K", "20-F", "40-F", "6-K"]);

export async function fetchCashRunwaySec(ticker: string): Promise<CashRunway> {
  const empty: CashRunway = { cash: null, opCashTtm: null, runwayMonths: null };
  try {
    const tickerRes = await fetch("https://www.sec.gov/files/company_tickers.json", { headers: SEC_HEADERS, next: { revalidate: 3600 } });
    if (!tickerRes.ok) return empty;
    const tickers = await tickerRes.json() as Record<string, { cik_str: number; ticker: string }>;
    const clean = ticker.replace(/\..*$/, "").toUpperCase();
    const row = Object.values(tickers).find((t) => t.ticker.toUpperCase() === clean);
    if (!row) return empty;
    const cik = String(row.cik_str).padStart(10, "0");
    const get = async (ns: string, concept: string): Promise<SecRow[]> => {
      try {
        const r = await fetch(`https://data.sec.gov/api/xbrl/companyconcept/CIK${cik}/${ns}/${concept}.json`, { headers: SEC_HEADERS, next: { revalidate: 3600 } });
        if (!r.ok) return [];
        const j = await r.json() as { units?: Record<string, SecRow[]> };
        const unit = j.units && (j.units.USD || Object.values(j.units)[0]);
        return (unit || []).filter((x) => Number.isFinite(x.val) && x.form && SEC_FORMS.has(x.form));
      } catch { return []; }
    };
    const latest = (rows: SecRow[]): number | null => {
      const s = rows.slice().sort((a, b) => String(b.end || "").localeCompare(String(a.end || "")));
      return s.length ? s[0].val : null;
    };
    // Operating cash flow: prefer trailing-4-quarter sum, fall back to latest annual (FY).
    const opTtm = (rows: SecRow[]): number | null => {
      const q = rows.filter((r) => { if (r.start && r.end) { const d = (Date.parse(r.end) - Date.parse(r.start)) / 86400000; return d >= 60 && d <= 125; } return r.fp && r.fp !== "FY"; })
        .sort((a, b) => String(b.end || "").localeCompare(String(a.end || "")));
      if (q.length >= 4) return q.slice(0, 4).reduce((s, r) => s + r.val, 0);
      const fy = rows.filter((r) => r.fp === "FY" || r.form === "10-K").sort((a, b) => String(b.end || "").localeCompare(String(a.end || "")));
      return fy.length ? fy[0].val : null;
    };

    let cashRows = await get("us-gaap", "CashAndCashEquivalentsAtCarryingValue");
    if (!cashRows.length) cashRows = await get("us-gaap", "CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents");
    if (!cashRows.length) cashRows = await get("ifrs-full", "CashAndCashEquivalents");
    let ocfRows = await get("us-gaap", "NetCashProvidedByUsedInOperatingActivities");
    if (!ocfRows.length) ocfRows = await get("ifrs-full", "CashFlowsFromUsedInOperatingActivities");

    const cash = latest(cashRows);
    const opCashTtm = opTtm(ocfRows);
    const runwayMonths = cash != null && cash > 0 && opCashTtm != null && opCashTtm < 0
      ? cash / (Math.abs(opCashTtm) / 12) : null;
    return { cash, opCashTtm, runwayMonths };
  } catch { return empty; }
}

/** Analyst price targets from Yahoo Finance (mean/high/low consensus) */
/** Scrape analyst consensus price target from MarketBeat.
 *  Especially valuable for TSX-listed stocks where Yahoo and StockAnalysis have sparse coverage.
 *  Returns null if unavailable — never throws. */
async function fetchMarketBeatTarget(ticker: string): Promise<number | null> {
  try {
    // Resolve exchange prefix and clean symbol for MarketBeat URL
    let symbol = ticker.toUpperCase().replace(/\s/g, "");
    let exchange = "NASDAQ"; // sensible default for US stocks
    if (/\.(TO|TSX)$/i.test(symbol))       { exchange = "TSX";   symbol = symbol.replace(/\.(TO|TSX)$/i, ""); }
    else if (/\.V$/i.test(symbol))          { exchange = "TSXV";  symbol = symbol.replace(/\.V$/i, ""); }
    else if (/\.(CN|NE)$/i.test(symbol))    { exchange = "CSE";   symbol = symbol.replace(/\.(CN|NE)$/i, ""); }
    else if (/\.(NYSE|N)$/i.test(symbol))   { exchange = "NYSE";  symbol = symbol.replace(/\.(NYSE|N)$/i, ""); }
    else if (/\.(OTC|PK)$/i.test(symbol))   { exchange = "OTCMKTS"; symbol = symbol.replace(/\.(OTC|PK)$/i, ""); }
    const url = `https://www.marketbeat.com/stocks/${exchange}/${symbol}/forecast/`;
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,*/*",
        "Accept-Language": "en-US,en;q=0.9",
      },
      next: { revalidate: 3600 },
    });
    if (!res.ok) return null;
    const html = await res.text();
    // MarketBeat shows "Consensus Price Target $X.XX" or "Average Price Target $X.XX"
    // Also check for a data attribute or JSON-LD structured data
    const patterns = [
      /[Cc]onsensus\s+[Pp]rice\s+[Tt]arget[\s\S]{0,400}?\$\s*([\d,]+\.?\d*)/,
      /[Aa]verage\s+[Pp]rice\s+[Tt]arget[\s\S]{0,400}?\$\s*([\d,]+\.?\d*)/,
      /"priceTarget"\s*:\s*\{[\s\S]{0,200}?"mean"\s*:\s*([\d.]+)/,
      /data-price-target="([\d.]+)"/,
    ];
    for (const p of patterns) {
      const m = html.match(p);
      if (m) {
        const n = Number(m[1].replace(/,/g, ""));
        if (Number.isFinite(n) && n > 0) return n;
      }
    }
    return null;
  } catch {
    return null;
  }
}

/** Scrape analyst price target from StockAnalysis.com as a second independent source.
 *  Returns null if unavailable — never throws. */
async function fetchStockAnalysisTarget(ticker: string): Promise<number | null> {
  try {
    const res = await fetch(
      `https://stockanalysis.com/stocks/${encodeURIComponent(ticker.toLowerCase())}/forecast/`,
      {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36",
          Accept: "text/html,application/xhtml+xml,*/*",
        },
        next: { revalidate: 3600 },
      }
    );
    if (!res.ok) return null;
    const html = await res.text();
    // StockAnalysis embeds the average target in a <td> next to "Average" or in __NEXT_DATA__
    // Try __NEXT_DATA__ JSON first (most reliable).
    const nd = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (nd) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const d: any = JSON.parse(nd[1]);
        const pt = d?.props?.pageProps?.data?.priceTarget?.mean
          ?? d?.props?.pageProps?.data?.priceTarget?.average
          ?? d?.props?.pageProps?.forecast?.priceTarget?.mean;
        if (pt != null) {
          const n = Number(pt);
          if (Number.isFinite(n) && n > 0) return n;
        }
      } catch { /* fall through to regex */ }
    }
    // Regex fallback: look for "Average Price Target" followed by a dollar amount
    const m = html.match(/[Aa]verage\s+[Pp]rice\s+[Tt]arget[\s\S]{0,200}?\$\s*([\d,]+\.?\d*)/);
    if (m) {
      const n = Number(m[1].replace(/,/g, ""));
      if (Number.isFinite(n) && n > 0) return n;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Fetch analyst consensus price target.
 * Primary: Yahoo Finance financialData module.
 * Secondary: StockAnalysis.com (independent source, often more current on recently upgraded names).
 *
 * When both sources are available, we take the HIGHER mean — recently raised targets show up
 * on StockAnalysis before Yahoo's consensus aggregation catches up (the POET / AAOI pattern).
 * Sets stale=true when the current stock price has already surpassed the consensus mean,
 * signalling to the AI that analysts are likely lagging and the target should be weighted lower.
 */
export async function fetchAnalystTarget(
  ticker: string,
  currentPrice?: number | null
): Promise<AnalystTargets> {
  const NULL_RESULT: AnalystTargets = { mean: null, high: null, low: null, sources: 0 };

  // Fetch all three sources in parallel; none is allowed to block the others.
  const [yahooResult, saTarget, mbTarget] = await Promise.allSettled([
    (async (): Promise<AnalystTargets> => {
      const res = await fetch(
        `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(ticker)}?modules=financialData`,
        { headers: YF_HEADERS, next: { revalidate: 3600 } }
      );
      if (!res.ok) return NULL_RESULT;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const json: any = await res.json();
      const fd = json?.quoteSummary?.result?.[0]?.financialData;
      return {
        mean: fd?.targetMeanPrice?.raw ?? null,
        high: fd?.targetHighPrice?.raw ?? null,
        low:  fd?.targetLowPrice?.raw  ?? null,
        sources: 1,
      };
    })(),
    fetchStockAnalysisTarget(ticker),
    fetchMarketBeatTarget(ticker),
  ]);

  const yahoo = yahooResult.status === "fulfilled" ? yahooResult.value : NULL_RESULT;
  const sa   = saTarget.status  === "fulfilled" ? saTarget.value  : null;
  const mb   = mbTarget.status  === "fulfilled" ? mbTarget.value  : null;

  // Bad-data guard: Yahoo sometimes returns the current price as targetMeanPrice when it has
  // no real analyst coverage (the field mirrors the last trade). Reject any mean within 2% of
  // current price — a real consensus that close to spot is statistically implausible.
  const isBadData = (m: number | null) =>
    m != null && currentPrice != null && currentPrice > 0 &&
    Math.abs(m - currentPrice) / currentPrice < 0.02;

  // Merge all three sources; take the highest credible mean.
  // Priority: prefer numbers that differ from current price (real analyst work, not echoed price).
  let mean: number | null = isBadData(yahoo.mean) ? null : (yahoo.mean ?? null);
  let sources = mean != null ? 1 : 0;

  for (const ext of [sa, mb]) {
    if (ext != null && ext > 0 && !isBadData(ext)) {
      sources += 1;
      if (mean == null || ext > mean) mean = ext;
    }
  }

  // Staleness signal: if we have a price and a consensus, and price has already surpassed
  // the consensus by >5%, analysts are almost certainly lagging. Flag it so the AI and UI
  // can surface this context rather than silently using a misleading number.
  const stale =
    mean != null &&
    currentPrice != null &&
    currentPrice > mean * 1.05;

  return { mean, high: yahoo.high, low: yahoo.low, sources, stale };
}

/**
 * Fetch headlines from Google News RSS for a raw query string.
 * Returns "YYYY-MM-DD — headline" strings, newest-first, same format as Yahoo results.
 * Used internally by fetchRecentNews as a second parallel source.
 */
async function fetchGoogleNewsRSS(query: string, maxItems = 8): Promise<string[]> {
  try {
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0" },
      next: { revalidate: 300 }, // same TTL as Yahoo so they age together
    });
    if (!res.ok) return [];
    const xml = await res.text();
    const cutoff = Date.now() - 1000 * 60 * 60 * 24 * 180; // drop anything older than 6 months
    const out: { title: string; ts: number }[] = [];
    for (const block of xml.split(/<item>/).slice(1)) {
      const rawTitle = (block.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || "";
      const pub = (block.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1] || "";
      let title = decodeNewsEntities(rawTitle);
      // Google News formats titles as "Headline - Source Name" — strip the source suffix
      const dash = title.lastIndexOf(" - ");
      if (dash > 0 && title.length - dash < 45) title = title.slice(0, dash).trim();
      if (!title || title.length < 8) continue;
      const ts = pub ? Date.parse(pub) : 0;
      if (ts && ts < cutoff) continue;
      out.push({ title, ts: Number.isFinite(ts) ? ts : 0 });
      if (out.length >= maxItems) break;
    }
    return out
      .sort((a, b) => b.ts - a.ts)
      .map(x => (x.ts ? `${new Date(x.ts).toISOString().slice(0, 10)} — ${x.title}` : x.title));
  } catch {
    return [];
  }
}

/**
 * Recent news headlines — Yahoo Finance + Google News RSS fetched in parallel,
 * merged, deduplicated, and returned newest-first as "YYYY-MM-DD — headline".
 *
 * Two sources means the AI sees more signal per ticker:
 * - Yahoo Finance: broad aggregator (Reuters, AP, Motley Fool, Barron's…), good on US large-caps
 * - Google News RSS: open-web crawl, often surfaces sector blogs, Canadian IR releases, and
 *   crypto/regulatory stories that Yahoo's aggregation misses
 *
 * Dedup key is the normalised title prefix (first 55 chars, lowercase, alphanumeric only)
 * so the same story syndicated under a slightly different headline only appears once.
 */
const CRYPTO_NAMES: Record<string, string> = {
  XRP:"Ripple XRP",HBAR:"Hedera HBAR",XLM:"Stellar XLM",BTC:"Bitcoin",ETH:"Ethereum",SOL:"Solana",
  XDC:"XDC Network",ADA:"Cardano",DOGE:"Dogecoin",LINK:"Chainlink",AVAX:"Avalanche",MATIC:"Polygon",
  POL:"Polygon",BNB:"BNB",TON:"Toncoin",DOT:"Polkadot",BCH:"Bitcoin Cash",LTC:"Litecoin",
  SHIB:"Shiba Inu",NEAR:"NEAR Protocol",APT:"Aptos",SUI:"SUI",ICP:"Internet Computer",
  ATOM:"Cosmos",FIL:"Filecoin",ARB:"Arbitrum",OP:"Optimism",INJ:"Injective",RNDR:"Render",
  ALGO:"Algorand",VET:"VeChain",GRT:"The Graph",AAVE:"Aave",UNI:"Uniswap",TAO:"Bittensor",
  FLR:"Flare",KAS:"Kaspa",TRX:"Tron",RENDER:"Render",ETC:"Ethereum Classic",IMX:"Immutable X",
};

function newsSearchQuery(ticker: string): string {
  const cryptoMatch = ticker.match(/^([A-Z0-9]+)-(USD|CAD)$/i);
  if (cryptoMatch) {
    const base = cryptoMatch[1].toUpperCase();
    return CRYPTO_NAMES[base] || `${base} crypto`;
  }
  const warrantMatch = ticker.match(/^([A-Z]+)[.\-](WS|WT|WR|RT)$/i);
  if (warrantMatch) return warrantMatch[1].toUpperCase();
  return ticker;
}

export async function fetchRecentNews(ticker: string): Promise<string[]> {
  const searchTicker = newsSearchQuery(ticker);
  // For Google News, append "stock" for short/ambiguous tickers to avoid car/movie/brand noise
  const baseTicker = ticker.replace(/[.\-].*$/, "").toUpperCase();
  const googleQuery = baseTicker.length <= 4 ? `${searchTicker} stock` : searchTicker;
  // Run both sources in parallel — neither waits for the other
  const [yahooLines, googleLines] = await Promise.allSettled([
    // --- Yahoo Finance ---
    (async (): Promise<string[]> => {
      const res = await fetch(
        `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(searchTicker)}&quotesCount=1&newsCount=14&enableFuzzyQuery=false`,
        { headers: YF_HEADERS, next: { revalidate: 300 } }
      );
      if (!res.ok) return [];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const data: any = await res.json();
      const symbolUC = baseTicker;
      // Distinctive company-name words (drop generic suffixes) to catch relevant headlines
      // not explicitly tagged with relatedTickers.
      const name = String(data.quotes?.[0]?.shortname || data.quotes?.[0]?.longname || "").toLowerCase();
      const nameWords = name
        .replace(/[.,]/g, " ")
        .replace(/\b(inc|corp|corporation|ltd|limited|plc|holdings?|company|co|group|the|sa|nv|ag)\b/g, " ")
        .split(/\s+/).filter((w: string) => w.length >= 4);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const items: any[] = Array.isArray(data.news) ? data.news : [];
      // Keep only headlines Yahoo tags with THIS ticker or that clearly name the company.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const relevant = items.filter((item: any) => {
        const related = (item.relatedTickers || []).map((t: string) => String(t).toUpperCase());
        if (related.includes(symbolUC)) return true;
        const title = String(item.title || "").toLowerCase();
        return nameWords.length > 0 && nameWords.some((w: string) => title.includes(w));
      });
      const chosen = relevant.length ? relevant : (nameWords.length ? [] : items);
      return chosen
        .map((item: { title?: string; providerPublishTime?: number }) => ({
          title: String(item.title || "").trim(),
          ts: typeof item.providerPublishTime === "number" ? item.providerPublishTime * 1000 : 0,
        }))
        .filter((x: { title: string }) => x.title)
        .sort((a: { ts: number }, b: { ts: number }) => b.ts - a.ts)
        .slice(0, 8)
        .map((x: { title: string; ts: number }) =>
          x.ts ? `${new Date(x.ts).toISOString().slice(0, 10)} — ${x.title}` : x.title
        );
    })(),
    // --- Google News RSS (append "stock" for short tickers to avoid brand noise) ---
    fetchGoogleNewsRSS(googleQuery, 8),
  ]);

  const yahoo = yahooLines.status === "fulfilled" ? yahooLines.value : [];
  const google = googleLines.status === "fulfilled" ? googleLines.value : [];

  // Merge: normalise each headline to a dedup key (first 55 alphanumeric chars, lowercase).
  // Prefer Yahoo's version when both sources carry the same story — Yahoo dates are more precise.
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const line of [...yahoo, ...google]) {
    // Strip the "YYYY-MM-DD — " prefix to get the raw title for dedup
    const title = line.replace(/^\d{4}-\d{2}-\d{2}\s+—\s+/, "");
    const key = title.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 55);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    merged.push(line);
  }

  // Sort merged pool newest-first (ISO date prefix sorts lexicographically correctly),
  // then cap at 8 — enough signal without padding the AI context window with noise.
  return merged
    .sort((a, b) => b.slice(0, 10).localeCompare(a.slice(0, 10)))
    .slice(0, 8);
}

/**
 * Fetch news by BOTH ticker symbol AND company name, merge and deduplicate.
 * Each call to fetchRecentNews now hits Yahoo + Google RSS in parallel, so this
 * function effectively runs 4 parallel fetches (ticker×Yahoo, ticker×Google,
 * name×Yahoo, name×Google) and delivers the best combined coverage.
 *
 * Ticker-only search misses real stories for small-cap, Canadian, OTC, and
 * crypto names — journalists write "Keel Infrastructure" not "KEEL.V".
 * Drop-in replacement for fetchRecentNews() at every call site that has a name.
 */
export async function fetchNewsForTicker(ticker: string, companyName?: string | null): Promise<string[]> {
  const byTicker = await fetchRecentNews(ticker).catch(() => [] as string[]);
  const baseSymbol = ticker.replace(/[.\-].*$/, "").toUpperCase();
  if (!companyName || companyName.toUpperCase() === baseSymbol) return byTicker;
  const byName = await fetchRecentNews(companyName).catch(() => [] as string[]);
  // Merge newest-first, deduplicate by first 40 chars of headline
  return [...new Map([...byTicker, ...byName].map(l => [l.slice(0, 40), l])).values()];
}

/**
 * Recent SEC filings formatted for the Intel brief — now powered by fetchSecSignals
 * so the AI receives classified, actionable context instead of bare filing names.
 */
export async function fetchSecFilings(ticker: string): Promise<string[]> {
  const signals = await fetchSecSignals(ticker);
  return formatSecSignals(signals);
}

// ─── Filing Facts (structured insights from filing_insights table) ───────────
// Reads the most recent 10-K/10-Q extracted facts for a ticker — the hive mind's
// DD knowledge. Every surface that calls gatherSignals() receives these automatically.
// Source: filing_insights (tier-1, SEC filings parsed by filing-reader).
export type FilingFact = {
  category: string;
  fact: string;
  numeric_value: number | null;
  source_section: string | null;
  filing_type: string;
  filing_date: string;
};

export async function fetchFilingFacts(ticker: string): Promise<FilingFact[]> {
  try {
    const sb = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { autoRefreshToken: false, persistSession: false } }
    );
    const { data } = await sb
      .from("filing_insights")
      .select("category, fact, numeric_value, source_section, filing_type, filing_date")
      .eq("ticker", ticker.toUpperCase())
      .order("filing_date", { ascending: false })
      .limit(12);
    return (data as FilingFact[] | null) ?? [];
  } catch {
    return [];
  }
}

export function formatFilingFacts(facts: FilingFact[]): string[] {
  if (!facts.length) return [];
  const ft = facts[0].filing_type;
  const fd = facts[0].filing_date;
  const lines = [`Filing Intelligence (${ft} filed ${fd}, SEC EDGAR — tier-1):`];
  for (const f of facts.slice(0, 10)) {
    const cat = f.category.replace(/_/g, " ");
    const src = f.source_section ? ` [${f.source_section}]` : "";
    lines.push(`  • ${cat}: ${f.fact}${src}`);
  }
  return lines;
}

// ─── SEC Filing Signals ───────────────────────────────────────────────────────
// Classifies recent SEC EDGAR filings as structured bullish / bearish / watch signals.
// Used by: Intel brief (rich context for the AI), Radar (catalyst + red-flag scoring).
// Source: EDGAR submissions API — legally required disclosures, stronger than news headlines.

// Structured insider (Form 4) breakdown lives in its own pure, unit-tested module (imported above).
// Re-exported here so existing importers of these types from market-context keep working.
export type { Form4Role, Form4Insight, Form4Parsed };

export type SecSignal = {
  form: string;
  date: string;
  signal: "bullish" | "bearish" | "watch";
  summary: string;
  items?: string;        // 8-K item numbers e.g. "1.01,7.01"
  accessionNumber?: string; // EDGAR accession e.g. "0001213900-26-065369"
  primaryDocument?: string; // primary doc filename (may have xslF prefix)
  form4?: Form4Insight;  // structured insider breakdown (Form 4 only; deterministic, optional)
};

// 8-K item number → first-pass classification.
// CALIBRATION: filing type alone is NOT a final verdict — it is a detection signal.
// Only structurally unambiguous negatives are auto-bearish (bankruptcy, restatement,
// covenant breach, agreement termination). Everything else is "watch" so the Intel
// brief AI can interpret the actual substance. Examples of why this matters:
//   1.01 covers both an AWS-backed $810M deal AND a distressed debt restructuring.
//   2.01 covers both a strategic acquisition AND a forced asset fire-sale.
//   SC 13D can be activist upside OR a hostile control fight.
//   Form 4 cluster is only bullish if the transactions are open-market purchases (code P),
//   not option grants (A/M) or sales (S) — transaction codes require parsing the XML doc.
// Rule: bearish > watch in ranking; no item is auto-bullish from type alone.
const K8_ITEM_MAP: Record<string, { signal: SecSignal["signal"]; summary: string }> = {
  "1.01": { signal: "watch",   summary: "Material definitive agreement — read for substance (major contract, financing, or debt restructuring)" },
  "1.02": { signal: "bearish", summary: "Termination of a material agreement" },
  "1.03": { signal: "bearish", summary: "Bankruptcy or receivership filing" },
  "2.01": { signal: "watch",   summary: "Acquisition or major transaction completed — evaluate terms and strategic rationale" },
  "2.04": { signal: "bearish", summary: "Financial obligation trigger — debt covenant or acceleration event" },
  "3.02": { signal: "watch",   summary: "Unregistered equity securities sold — dilution risk; verify size and terms" },
  "4.01": { signal: "watch",   summary: "Change in certifying accountant — may be routine or an early warning sign" },
  "4.02": { signal: "bearish", summary: "Non-reliance on prior financial statements — restatement risk" },
  "5.01": { signal: "watch",   summary: "Change in control of registrant" },
  "5.02": { signal: "watch",   summary: "Officer / director departure or appointment — context determines significance" },
  "7.01": { signal: "watch",   summary: "Regulation FD voluntary disclosure — read for material guidance or data" },
  "8.01": { signal: "watch",   summary: "Other material events — read filing for substance" },
};

/**
 * Fetch and classify recent SEC EDGAR filings as structured signals.
 * Returns newest-first, up to 6 signals, within the last 30 days.
 * Canadian / non-US tickers return [] (no EDGAR data).
 */
const EMPTY_FORM4: Form4Parsed = { codes: [], ownerName: "", role: "insider", officerTitle: "", ownedAfter: null, scheduled: null };

/** Read the reporting owner's strongest relationship flag from a Form 4 XML. A boolean flag may be
 *  "1"/"true". Hierarchy by signal strength: officer > director > 10% owner > generic insider. */
function readForm4Role(xml: string): { role: Form4Role; officerTitle: string } {
  const flag = (tag: string) => new RegExp(`<${tag}[^>]*>\\s*(1|true)\\s*</${tag}>`, "i").test(xml);
  const titleMatch = xml.match(/<officerTitle[^>]*>([\s\S]*?)<\/officerTitle>/i);
  const officerTitle = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, " ").replace(/\s{2,}/g, " ").trim() : "";
  if (flag("isOfficer") || officerTitle) return { role: "officer", officerTitle };
  if (flag("isDirector")) return { role: "director", officerTitle: "" };
  if (flag("isTenPercentOwner")) return { role: "tenPercentOwner", officerTitle: "" };
  return { role: "insider", officerTitle: "" };
}

/** Fetch a Form 4 XML and extract transaction codes + share counts AND the reporting owner's role,
 *  post-transaction holdings, and 10b5-1 status — the structured fields the gem card surfaces.
 *  Uses primaryDocument from the EDGAR submissions API — no index round-trip needed.
 *  Returns EMPTY_FORM4 on any failure (fail-open). */
async function parseForm4Codes(
  cik: string,
  accession: string,
  primaryDoc: string,
): Promise<Form4Parsed> {
  try {
    if (!accession) return EMPTY_FORM4;
    const cikInt = parseInt(cik, 10); // strip leading zeros for EDGAR URL
    const accClean = accession.replace(/-/g, ""); // "0001234567-26-069123" → "000123456726069123"
    const base = `https://www.sec.gov/Archives/edgar/data/${cikInt}/${accClean}`;

    // EDGAR Form 4 primaryDocument often has an "xslF345X06/" XSLT viewer prefix
    // (e.g. "xslF345X06/form4-20260601.xml"). Strip it — the actual XML sits at the base level.
    const docFilename = primaryDoc
      ? primaryDoc.replace(/^xslF\w+\//i, "")  // strip xslF345X06/ or similar
      : "";
    const xmlPrimary = docFilename && /\.xml$/i.test(docFilename) ? `${base}/${docFilename}` : null;
    const candidates = [
      xmlPrimary,
      `${base}/${accession}.xml`,        // accession-number.xml (common for many filers)
      `${base}/form4.xml`,               // generic fallback
    ].filter(Boolean) as string[];

    let xml = "";
    for (const url of candidates) {
      const r = await fetch(url, { headers: SEC_HEADERS, cache: "no-store" }).catch(() => null);
      if (!r?.ok) continue;
      const text = await r.text();
      // Must contain a Form 4 transaction code element to be the right document
      if (/<transactionCode/i.test(text)) { xml = text; break; }
    }

    // Last resort: fetch the filing index JSON to locate any XML document in the package
    if (!xml) {
      const idxRes = await fetch(`${base}/${accession}-index.json`, {
        headers: SEC_HEADERS, cache: "no-store",
      }).catch(() => null);
      if (idxRes?.ok) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const idx = await idxRes.json().catch(() => null) as any;
        const items: Array<{ name: string }> = idx?.directory?.item ?? [];
        const xmlFile = items.find(f => /\.xml$/i.test(f.name) && !/index/i.test(f.name));
        if (xmlFile) {
          const r = await fetch(`${base}/${xmlFile.name}`, { headers: SEC_HEADERS, cache: "no-store" }).catch(() => null);
          if (r?.ok) xml = await r.text();
        }
      }
    }

    if (!xml) return EMPTY_FORM4;

    // Parse all <transactionCode> values and their associated share amounts
    const results: Array<{ code: string; shares: number; price: number }> = [];
    const codeMatches = [...xml.matchAll(/<transactionCode[^>]*>([^<]+)<\/transactionCode>/gi)];
    const shareMatches = [...xml.matchAll(/<transactionShares[^>]*>[\s\S]*?<value[^>]*>([^<]+)<\/value>/gi)];
    const priceMatches = [...xml.matchAll(/<transactionPricePerShare[^>]*>[\s\S]*?<value[^>]*>([^<]+)<\/value>/gi)];

    for (let i = 0; i < codeMatches.length; i++) {
      results.push({
        code: (codeMatches[i][1] || "").trim().toUpperCase(),
        shares: parseFloat(shareMatches[i]?.[1] || "0") || 0,
        price: parseFloat(priceMatches[i]?.[1] || "0") || 0,
      });
    }

    // Reporting owner role + name (the single most important Form 4 fact — who, and how senior).
    const { role, officerTitle } = readForm4Role(xml);
    const nameMatch = xml.match(/<rptOwnerName[^>]*>([\s\S]*?)<\/rptOwnerName>/i);
    const ownerName = nameMatch ? nameMatch[1].replace(/<[^>]+>/g, " ").replace(/\s{2,}/g, " ").trim() : "";

    // Shares held AFTER the LAST transaction → lets us compute the stake-delta (% the buy added).
    const ownedMatches = [...xml.matchAll(/<sharesOwnedFollowingTransaction[^>]*>[\s\S]*?<value[^>]*>([^<]+)<\/value>/gi)];
    const lastOwned = ownedMatches.length ? parseFloat(ownedMatches[ownedMatches.length - 1][1] || "") : NaN;
    const ownedAfter = Number.isFinite(lastOwned) ? lastOwned : null;

    // 10b5-1: a pre-scheduled trade is automatic (weak signal); discretionary is conviction. Newer
    // filings carry a structured <aff10b5One> flag; older ones mention "10b5-1" only in footnotes.
    const scheduled = /<aff10b5One[^>]*>\s*(1|true)\s*<\/aff10b5One>|rule\s*10b5-?1|10b5-?1\s*(plan|trading)/i.test(xml)
      ? true
      : /<aff10b5One[^>]*>\s*(0|false)\s*<\/aff10b5One>/i.test(xml) ? false : null;

    return { codes: results, ownerName, role, officerTitle, ownedAfter, scheduled };
  } catch { return EMPTY_FORM4; }
}

/** Map a parsed Form 4 to a SecSignal classification. Reads the FULL parse (role, 10b5-1, stake-delta),
 *  not just the codes, so the summary states the facts ("CFO sale — 120k sh · $2.1M · 10b5-1 scheduled")
 *  instead of punting ("check if 10b5-1"). Buys are additionally upgraded to the richer gem-card line
 *  upstream via form4PurchaseSummary; this covers sells/grants/mixed deterministically. */
function classifyForm4Codes(
  p: Form4Parsed,
  totalNote: string
): { signal: SecSignal["signal"]; summary: string } {
  const codes = p.codes;
  if (!codes.length) {
    // True read of an un-parsed filing is the AI fallback's job (Tier 2); until then, an honest note.
    return { signal: "watch", summary: `Insider filing — transaction details not machine-readable; open Form 4 to read${totalNote}` };
  }

  const purchases = codes.filter(c => c.code === "P");
  const sales     = codes.filter(c => c.code === "S");
  const grants    = codes.filter(c => ["A", "M", "F", "G", "C", "W", "X", "D"].includes(c.code));
  const fmtVal = (v: number) => v > 0 ? ` · ~$${v >= 1_000_000 ? (v/1_000_000).toFixed(1)+"M" : v >= 1_000 ? (v/1_000).toFixed(0)+"K" : v.toFixed(0)}` : "";
  const who = shortTitle(p.officerTitle, p.role);
  const sched = p.scheduled === true ? " · 10b5-1 scheduled" : p.scheduled === false ? " · discretionary" : "";
  // Stake-delta vs the prior holding: % ADDED for a buy, % REDUCED for a sell.
  const stakePct = (sharesTxn: number, isBuy: boolean): string => {
    if (p.ownedAfter == null || sharesTxn <= 0) return "";
    const prior = isBuy ? p.ownedAfter - sharesTxn : p.ownedAfter + sharesTxn;
    if (prior <= 0) return "";
    const pct = sharesTxn / prior;
    if (pct < 0.01) return "";
    return isBuy ? ` · +${(pct*100).toFixed(0)}% to stake` : ` · −${(pct*100).toFixed(0)}% of stake`;
  };

  if (purchases.length > 0 && sales.length === 0) {
    const shares = purchases.reduce((s, c) => s + c.shares, 0);
    const value = purchases.reduce((sum, c) => sum + c.shares * c.price, 0);
    return { signal: "bullish", summary: `${who} open-market buy — ${shares.toLocaleString("en",{maximumFractionDigits:0})} sh${fmtVal(value)}${stakePct(shares,true)}${sched}${totalNote}.` };
  }
  if (sales.length > 0 && purchases.length === 0) {
    const shares = sales.reduce((s, c) => s + c.shares, 0);
    const value = sales.reduce((sum, c) => sum + c.shares * c.price, 0);
    return { signal: "watch", summary: `${who} sale — ${shares.toLocaleString("en",{maximumFractionDigits:0})} sh${fmtVal(value)}${stakePct(shares,false)}${sched}${totalNote}.` };
  }
  if (purchases.length > 0 && sales.length > 0) {
    return { signal: "watch", summary: `${who} mixed activity — ${purchases.length} buy(s) + ${sales.length} sale(s) in one filing${sched}${totalNote}.` };
  }
  if (grants.length > 0) {
    const grantTypes = [...new Set(grants.map(c => c.code))].join("/");
    return { signal: "watch", summary: `${who} compensation filing (${grantTypes}) — grant, vesting, or option exercise${totalNote}. Not an open-market transaction.` };
  }
  const uniqueCodes = [...new Set(codes.map(c => c.code))].join(", ");
  return { signal: "watch", summary: `${who} filing — transaction code(s): ${uniqueCodes}${totalNote}` };
}

/**
 * Fetch real text from an EDGAR filing document and return a meaningful snippet.
 * Used to replace generic summaries (e.g. "Other material events") with the actual
 * filing content — e.g. "$400M convertible notes offering priced."
 *
 * Fetches first 60 KB (Range header) to avoid loading multi-MB filings.
 * Strips HTML, finds the first substantive paragraph after an Item/section heading.
 * Returns null on any failure so callers fall back to the generic summary.
 */
export async function fetchFilingSnippet(
  cikInt: number,
  accessionNumber: string,
  primaryDocument: string,
  form: string,
): Promise<string | null> {
  try {
    const docFilename = primaryDocument.replace(/^xslF\w+\//i, "");
    if (!docFilename || /\.xml$/i.test(docFilename)) return null; // XML = XBRL data, not prose
    const accClean = accessionNumber.replace(/-/g, "");
    const url = `https://www.sec.gov/Archives/edgar/data/${cikInt}/${accClean}/${docFilename}`;

    const r = await fetch(url, {
      headers: { ...SEC_HEADERS, Accept: "text/html,*/*", Range: "bytes=0-61439" },
      cache: "no-store",
    }).catch(() => null);
    if (!r || (r.status !== 200 && r.status !== 206)) return null;

    const raw = await r.text();

    // Strip style / script blocks then all HTML tags, then decode HTML entities
    const text = raw
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ")
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      // Named entities
      .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
      .replace(/&quot;/gi, '"').replace(/&apos;/gi, "'").replace(/&mdash;/gi, "—").replace(/&ndash;/gi, "–")
      .replace(/&ldquo;/gi, '"').replace(/&rdquo;/gi, '"').replace(/&lsquo;/gi, "'").replace(/&rsquo;/gi, "'")
      // Numeric entities — decode common typographic ones
      .replace(/&#160;/g, " ")   // non-breaking space
      .replace(/&#8220;/g, '"').replace(/&#8221;/g, '"')  // curly quotes
      .replace(/&#8216;/g, "'").replace(/&#8217;/g, "'")  // curly apostrophes
      .replace(/&#8212;/g, "—").replace(/&#8211;/g, "–")  // dashes
      .replace(/&#(\d+);/g, (_, n) => { const c = parseInt(n, 10); return (c > 31 && c < 127) ? String.fromCharCode(c) : " "; })
      .replace(/&[a-z]+;/gi, " ")
      .replace(/\s+/g, " ").trim();

    // ── 8-K / 8-K/A ──────────────────────────────────────────────────────────
    // Find the first "Item N.NN" block and extract the substantive body text.
    if (/^8-K/i.test(form)) {
      const itemMatch = text.match(/Item\s+\d+\.\d+\.?\s+[A-Za-z][^\n]{0,120}?\.\s*([\s\S]{80,})/i);
      if (itemMatch) {
        const body = itemMatch[1];
        const snippet = extractSubstantiveSentences(body, 420);
        if (snippet) return snippet;
      }
    }

    // ── 10-K ─────────────────────────────────────────────────────────────────
    // Look for "BUSINESS" or "OVERVIEW" section; fall back to first real paragraph.
    if (/^10-K/i.test(form)) {
      const ovMatch = text.match(/(?:OVERVIEW|BUSINESS\s+OVERVIEW|OUR\s+BUSINESS)[^a-z]{0,30}((?:[A-Z][^.!?]{30,}[.!?]\s*){1,4})/i);
      if (ovMatch) return ovMatch[1].slice(0, 420).trim();
      // Fall through to generic extraction
    }

    // ── 10-Q ─────────────────────────────────────────────────────────────────
    // Look for MD&A / Results of Operations
    if (/^10-Q/i.test(form)) {
      const mdaMatch = text.match(/(?:RESULTS\s+OF\s+OPERATIONS|MANAGEMENT.{0,20}DISCUSSION)[^a-z]{0,30}((?:[A-Z][^.!?]{30,}[.!?]\s*){1,4})/i);
      if (mdaMatch) return mdaMatch[1].slice(0, 420).trim();
    }

    // ── 424B / S-3 ───────────────────────────────────────────────────────────
    // Prospectus cover page — find first substantive offering description
    if (/^(424B|S-3)/i.test(form)) {
      const offerMatch = text.match(/((?:We are offering|We are selling|This prospectus relates to|This prospectus supplement relates to|Pursuant to this|The selling stockholders?|No proceeds to the [Cc]ompany|[Ss]hares of [Cc]ommon [Ss]tock [Ii]ssuable [Uu]pon [Ee]xercise|[Uu]p to[\s\d,]+[Ss]hares)[^.!?]{10,}[.!?](?:\s*[A-Z][^.!?]{20,}[.!?]){0,2})/i);
      if (offerMatch) return offerMatch[1].slice(0, 420).trim();
    }

    // ── Generic fallback ─────────────────────────────────────────────────────
    // Find the first substantive paragraph (skip EDGAR boilerplate header)
    // Boilerplate: "UNITED STATES SECURITIES AND EXCHANGE COMMISSION", addresses, checkboxes
    const afterHeader = text.replace(/^[\s\S]{0,1200}?(?:CURRENT REPORT|ANNUAL REPORT|QUARTERLY REPORT|FORM\s+8-K|FORM\s+10-K|FORM\s+10-Q|FORM\s+S-3|FORM\s+424)[^]*?(?=On\s+[A-Z]|The\s+Company|We\s+are|[A-Z][a-z]{3,}\s+(?:Inc|Corp|Ltd|LLC))/i, "");
    const snippet = extractSubstantiveSentences(afterHeader || text, 420);
    return snippet;
  } catch { return null; }
}

/** Extract the first ~maxChars of substantive prose, skipping short header-like lines. */
function extractSubstantiveSentences(text: string, maxChars: number): string | null {
  // Split on sentence boundaries
  const sentences = text.split(/(?<=[.!?])\s+(?=[A-Z])/);
  const good: string[] = [];
  let total = 0;
  for (const s of sentences) {
    const clean = s.trim();
    // Skip: short (<50 chars), looks like a heading, or is boilerplate EDGAR text
    if (clean.length < 50) continue;
    if (/^(exhibit|pursuant to rule|item \d|check the appropriate|indicate by check|securities registered|emerging growth|commission file|date of report|registration no|filed pursuant|prospectus supplement no|prospectus dated|form\s+\d|table of contents)/i.test(clean)) continue;
    if (/\.(htm|txt|xml)\b/i.test(clean)) continue; // filename fragment = header garbage
    if (/registration\s+no\.?\s+\d{3}-\d+/i.test(clean)) continue;
    if (/^[A-Z\s,.()\d]+$/.test(clean)) continue; // all-caps = heading
    good.push(clean);
    total += clean.length;
    if (total >= maxChars) break;
  }
  if (!good.length) return null;
  return good.join(" ").slice(0, maxChars);
}

export async function fetchSecSignals(ticker: string): Promise<SecSignal[]> {
  if (/\.(TO|V|CN|NE|TSX)$/i.test(ticker)) return [];
  try {
    const tickerRes = await fetch("https://www.sec.gov/files/company_tickers.json", {
      headers: SEC_HEADERS, next: { revalidate: 3600 },
    });
    if (!tickerRes.ok) return [];
    const tickerMap = await tickerRes.json() as Record<string, { cik_str: number; ticker: string }>;
    const clean = ticker.replace(/\..*$/, "").toUpperCase();
    const match = Object.values(tickerMap).find(t => t.ticker.toUpperCase() === clean);
    if (!match) return [];
    const cik = String(match.cik_str).padStart(10, "0");

    const subRes = await fetch(`https://data.sec.gov/submissions/CIK${cik}.json`, {
      headers: SEC_HEADERS, cache: "no-store",
    });
    if (!subRes.ok) return [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sub = await subRes.json() as any;
    const forms: string[]      = sub.filings?.recent?.form            ?? [];
    const dates: string[]      = sub.filings?.recent?.filingDate      ?? [];
    const itemsArr: string[]   = sub.filings?.recent?.items           ?? [];
    const accNums: string[]    = sub.filings?.recent?.accessionNumber ?? [];
    const primaryDocs: string[]= sub.filings?.recent?.primaryDocument ?? [];

    const cutoff   = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const sevenAgo = new Date(Date.now() -  7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    const signals: SecSignal[] = [];
    let form4Total = 0;
    const form4Recent: Array<{ date: string; accession: string; primaryDoc: string }> = [];

    for (let i = 0; i < forms.length; i++) {
      const date = dates[i] || "";
      if (date < cutoff) break; // filings are newest-first; everything beyond 30 days is irrelevant
      const form = forms[i];
      const itemStr = (itemsArr[i] || "").trim();

      const accNum = accNums[i] || "";
      const pDoc   = primaryDocs[i] || "";

      if (form === "8-K" || form === "8-K/A") {
        const nums = itemStr ? itemStr.split(",").map(s => s.trim()) : [];
        // Rank: bearish > bullish > watch; pick the single most significant item
        let best: { signal: SecSignal["signal"]; summary: string } | null = null;
        for (const num of nums) {
          const cls = K8_ITEM_MAP[num];
          if (!cls) continue;
          if (!best
            || (cls.signal === "bearish" && best.signal !== "bearish")
            || (cls.signal === "bullish" && best.signal === "watch")) best = cls;
        }
        if (best) signals.push({ form, date, signal: best.signal, summary: best.summary, items: itemStr || undefined, accessionNumber: accNum, primaryDocument: pDoc });

      } else if (form === "10-K" || form === "10-K/A") {
        signals.push({ form, date, signal: "watch", summary: "Annual report filed — review for revenue, cash position, and forward guidance", accessionNumber: accNum, primaryDocument: pDoc });

      } else if (form === "10-Q" || form === "10-Q/A") {
        signals.push({ form, date, signal: "watch", summary: "Quarterly report filed — review for results, cash runway, and any revised guidance", accessionNumber: accNum, primaryDocument: pDoc });

      } else if (form === "NT 10-Q" || form === "NT 10-K" || form === "NT 20-F") {
        signals.push({ form, date, signal: "bearish", summary: "Late filing notice — may indicate audit issues or restatement" });

      } else if (form === "S-3" || form === "S-3/A") {
        signals.push({ form, date, signal: "watch", summary: "Shelf registration filed — shares authorized for potential future offering (not an active sale yet)", accessionNumber: accNum, primaryDocument: pDoc });
      } else if (form === "424B3" || form === "424B4" || form === "424B5") {
        signals.push({ form, date, signal: "watch", summary: "Prospectus supplement filed — registered shares or warrants may create future selling pressure. Review filing to confirm whether active offering or resale registration.", accessionNumber: accNum, primaryDocument: pDoc });

      } else if (form === "SC 13D" || form === "SC 13D/A") {
        signals.push({ form, date, signal: "watch", summary: "New 13D — 5%+ stakeholder with active intent; may be activist, strategic partner, or control-related" });

      } else if (form === "SC 13G" || form === "SC 13G/A") {
        signals.push({ form, date, signal: "watch", summary: "New 13G — institutional investor acquired 5%+ passive stake" });

      } else if (form === "4") {
        form4Total++;
        // Parse the XML (buy vs sell) for every Form 4 in the FULL 30-day window, not just the last 14 days.
        // A SINGLE insider BUY filed 15-30 days ago (e.g. a CEO's first open-market purchase in years) was
        // being dropped entirely: too old for the 14-day enrich window AND form4Total=1 skips the 2+ "cluster"
        // fallback below. An insider buy is Tier-1 evidence — it must never silently vanish. (date is already
        // ≥ the 30-day cutoff here; cap at 8 to bound the XML fetches.)
        if (form4Recent.length < 8) {
          form4Recent.push({ date, accession: accNums[i] || "", primaryDoc: primaryDocs[i] || "" });
        }
      }
    }

    // Form 4 — fetch actual XML for each recent filing to get transaction codes.
    // P = open-market purchase, S = sale, A = grant/award, M = option exercise, F = tax withholding
    if (form4Recent.length > 0) {
      const enriched = await Promise.all(
        form4Recent.map(({ date, accession, primaryDoc }) =>
          parseForm4Codes(cik, accession, primaryDoc).then(parsed => ({ date, parsed }))
        )
      );
      const totalNote = form4Total > form4Recent.length
        ? ` (${form4Total} filings in 30 days total)` : "";
      // CLUSTER = distinct REPORTING OWNERS buying (not filing count). Multiple different insiders
      // buying at once is the strongest signal in the literature; one person amending is not.
      const distinctBuyers = new Set(
        enriched
          .filter(({ parsed }) => form4Action(parsed.codes) === "buy" && parsed.ownerName)
          .map(({ parsed }) => parsed.ownerName.toUpperCase())
      ).size;
      enriched.forEach(({ date, parsed }) => {
        const { signal, summary } = classifyForm4Codes(parsed, totalNote);
        const insight = buildForm4Insight(parsed, Math.max(distinctBuyers, 1), form4Total);
        // For a real buy, lead with the richer role/stake/cluster-aware line + structured insight.
        if (insight) {
          signals.unshift({ form: "4", date, signal, summary: form4PurchaseSummary(insight) + totalNote, form4: insight });
        } else {
          signals.unshift({ form: "4", date, signal, summary });
        }
      });
    } else if (form4Total >= 2) {
      const firstDate = dates[forms.indexOf("4")] || cutoff;
      signals.push({ form: "4", date: firstDate, signal: "watch",
        summary: `Insider activity cluster — ${form4Total} Form 4 filings in 30 days; open EDGAR to verify transaction types` });
    }

    // ── Enrich non-Form-4 signals with real filing text ─────────────────────
    // Forms with generic summaries (8-K, 10-K, 10-Q, 424B, S-3) get a live snippet
    // fetched from the EDGAR document so the popup shows real substance, not boilerplate.
    const SNIPPET_FORMS = new Set(["8-K", "8-K/A", "10-K", "10-K/A", "10-Q", "10-Q/A", "424B3", "424B4", "424B5", "S-3", "S-3/A"]);
    const cikInt = parseInt(cik, 10);
    const enrichTargets = signals
      .map((s, idx) => ({ s, idx }))
      .filter(({ s }) => SNIPPET_FORMS.has(s.form) && s.accessionNumber && s.primaryDocument);

    if (enrichTargets.length > 0) {
      const enriched = await Promise.all(
        enrichTargets.map(({ s, idx }) =>
          Promise.race([
            fetchFilingSnippet(cikInt, s.accessionNumber!, s.primaryDocument!, s.form),
            new Promise<null>(r => setTimeout(() => r(null), 4000)),
          ]).then(snippet => ({ idx, snippet }))
        )
      );
      for (const { idx, snippet } of enriched) {
        if (snippet && snippet.length > 40) {
          signals[idx] = { ...signals[idx], summary: snippet };
        }
      }
    }

    return signals.slice(0, 8);
  } catch { return []; }
}

/** Format SecSignals as human-readable lines for the Intel brief context block */
export function formatSecSignals(signals: SecSignal[]): string[] {
  return signals.map(s => {
    const icon = s.signal === "bullish" ? "✅" : s.signal === "bearish" ? "🔴" : "⚠️";
    const itemTag = s.items ? ` [Item ${s.items}]` : "";
    return `${icon} ${s.form} (${s.date})${itemTag}: ${s.summary}`;
  });
}

/** X-Ray fundamentals — fetched directly (no internal HTTP call) with a hard timeout */
export async function runXray(ticker: string): Promise<XrayResult | null> {
  try {
    return await Promise.race([
      fetchYahooXray(ticker),
      new Promise<null>(resolve => setTimeout(() => resolve(null), 12000)),
    ]);
  } catch {
    return null;
  }
}

/**
 * ETF performance & risk metrics from 1-year price history (no crumb, no fundamentals).
 * Returns null if the symbol is NOT an ETF — callers then fall through to the stock path.
 * Used to give ETFs a meaningful Plainview score (since they have no company financials).
 * Self-contained: does not affect the stock/crypto paths.
 */
export async function fetchEtfMetrics(symbol: string): Promise<{ name: string; score: number; block: string } | null> {
  try {
    // Resolve Canadian/other listings (e.g. XEQT → XEQT.TO) — a bare ticker often has no
    // Yahoo data. Bare symbol is tried first, so US stocks/ETFs stop after one fetch.
    const candidates = symbol.includes(".") ? [symbol] : [symbol, `${symbol}.TO`, `${symbol}.NE`, `${symbol}.V`, `${symbol}.CN`];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let result: any = null;
    for (const cand of candidates) {
      for (const host of ["query1", "query2"]) {
        const res = await fetch(
          `https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(cand)}?range=1y&interval=1d`,
          { headers: YF_HEADERS, cache: "no-store" }
        ).catch(() => null);
        if (res?.ok) {
          const r = (await res.json())?.chart?.result?.[0] ?? null;
          if (r?.indicators?.quote?.[0]?.close?.length) { result = r; break; }
        }
      }
      if (result) break;
    }
    if (!result) return null;
    const meta = result.meta || {};
    if (String(meta.instrumentType || "").toUpperCase() !== "ETF") return null;

    const closes: number[] = (result.indicators?.quote?.[0]?.close ?? []).filter((v: unknown): v is number => typeof v === "number" && Number.isFinite(v));
    const timestamps: number[] = result.timestamp ?? [];
    if (closes.length < 30) return null;

    const price = Number(meta.regularMarketPrice) || closes[closes.length - 1];
    const name = (meta.longName || meta.shortName || symbol) as string;
    const last = closes[closes.length - 1];
    const retDays = (d: number): number | null => { const i = closes.length - 1 - d; return i >= 0 && closes[i] > 0 ? (last - closes[i]) / closes[i] * 100 : null; };
    const ret1Y = retDays(closes.length - 1), ret6M = retDays(126), ret3M = retDays(63);
    const yStart = new Date(new Date().getFullYear(), 0, 1).getTime() / 1000;
    const yi = timestamps.findIndex(t => t >= yStart);
    const retYTD = (yi >= 0 && closes[yi] > 0) ? (last - closes[yi]) / closes[yi] * 100 : null;

    const avg = (arr: number[], n: number) => arr.length >= n ? arr.slice(-n).reduce((a, b) => a + b, 0) / n : null;
    const ma50 = avg(closes, 50), ma200 = avg(closes, 200);
    const week52High = Math.max(...closes), week52Low = Math.min(...closes);
    const drawdown = week52High > 0 ? (price - week52High) / week52High * 100 : null;

    const dailyRets: number[] = [];
    for (let i = 1; i < closes.length; i++) if (closes[i - 1] > 0) dailyRets.push((closes[i] - closes[i - 1]) / closes[i - 1]);
    let volatility: number | null = null;
    if (dailyRets.length > 20) {
      const mean = dailyRets.reduce((a, b) => a + b, 0) / dailyRets.length;
      const variance = dailyRets.reduce((s, r) => s + (r - mean) ** 2, 0) / dailyRets.length;
      volatility = Math.sqrt(variance) * Math.sqrt(252) * 100;
    }

    const aboveMa50 = ma50 != null && price > ma50;
    const aboveMa200 = ma200 != null && price > ma200;
    let score = 5;
    if (aboveMa50) score += 1;
    if (aboveMa200) score += 1;
    if (ret1Y != null && ret1Y > 0) score += 1;
    if (ret6M != null && ret6M > 0) score += 0.5;
    if (retYTD != null && retYTD > 0) score += 0.5;
    if (volatility != null && volatility > 40) score -= 1;
    if (drawdown != null && drawdown < -25) score -= 1;
    score = Math.max(0, Math.min(10, score));

    const pct = (v: number | null) => v == null ? "n/a" : `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`;
    const trendLabel = (aboveMa50 && aboveMa200) ? "uptrend (above 50 & 200-day MA)"
      : (!aboveMa50 && !aboveMa200) ? "downtrend (below 50 & 200-day MA)" : "mixed (between 50 & 200-day MA)";
    const block = [
      `Plainview ETF score: ${score.toFixed(1)}/10 (performance & risk based — ETFs have no company fundamentals to score)`,
      `YTD return: ${pct(retYTD)} · 1-year: ${pct(ret1Y)} · 6-month: ${pct(ret6M)} · 3-month: ${pct(ret3M)}`,
      `Trend: ${trendLabel}`,
      volatility != null ? `Annualized volatility: ${volatility.toFixed(0)}% (${volatility < 20 ? "low / stable" : volatility <= 35 ? "moderate" : "high"})` : null,
      drawdown != null ? `Drawdown from 52-week high: ${drawdown.toFixed(0)}%` : null,
    ].filter(Boolean).join("\n");

    return { name, score, block };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

/** Multi-line fundamentals block for single-ticker prompts */
export function formatXray(xray: XrayResult): string {
  const get = (label: string) =>
    [...xray.metrics, ...xray.valuation].find((m) => m.label === label)?.value ?? "n/a";

  // NOTE: deliberately does NOT feed our internal X-Ray score to the model — it is a
  // circular self-reference and the score computed here can differ from the X-Ray tab's
  // (different fetch path/timeout), causing the AI to cite a wrong "X-Ray score of N/10".
  // The model reasons from the underlying fundamentals below instead.
  return [
    `Revenue TTM: ${get("Revenue TTM")}`,
    `Revenue trend (QoQ): ${get("Revenue Trend")}`,
    `Gross margin: ${get("Gross Margin")}`,
    `EPS: ${get("EPS")}`,
    `Net cash: ${get("Net Cash")}`,
    `P/S ratio: ${get("P/S Ratio")}`,
    `Cash per share: ${get("Cash Per Share")}`,
    `Operating cash flow: ${get("Cash Runway")}`,
    `Shares outstanding: ${get("Shares Outstanding")}`,
  ]
    .filter((l) => !l.endsWith("n/a") && !l.includes("Needs ") && !l.includes("needs "))
    .join("\n");
}

// X-RAY → DETERMINISTIC OPPOSING FUNDAMENTALS. The separate Yahoo financialData feed (fetchFinancialSnapshot)
// is crumb-blocked → revenueGrowth/grossMargins come back null for EVERY ticker, so the old code-detected
// "revenue declining / negative margin" opposing facts were DEAD. X-Ray works everywhere and already tags
// each metric good/watch/bad, so derive the fundamental headwinds from it instead — the reliable source.
// Constitution §7.5: X-Ray is a valid INPUT to the Contradiction pillar (never the verdict). Conservatively
// weighted + capped so weak fundamentals show as a ✗ RISK but can't, alone, flip a forward thesis to
// "Contradicted" (only genuine disconfirming FACTS from news/filings do that).
// NARROW + PRECISE: only two fundamentals are UNIVERSAL, unambiguous headwinds against a (typically
// bullish) thesis — DECLINING revenue and NEGATIVE gross margin. The earlier broad version treated ANY
// "bad" X-Ray metric as a contradiction, which (a) flagged metrics that are actually fine in the thesis
// path's X-Ray fetch — TSLA's $44B net cash / positive EPS were wrongly shown "weak" — and (b) dinged
// pre-revenue biotechs for expected unprofitability (EPS/ROE bad). Restricting to revenue-decline and
// negative-margin restores the original dead-financials intent precisely, with plain-English wording.
export function xrayOpposingFundamentals(xray: XrayResult | null): { text: string; tierWeight: number }[] {
  if (!xray) return [];
  const all = [...(xray.metrics || []), ...(xray.valuation || [])];
  const find = (re: RegExp) => all.find((m) => re.test(m.label));
  const out: { text: string; tierWeight: number }[] = [];
  const rt = find(/revenue trend/i);
  if (rt && rt.status === "bad" && rt.value && rt.value !== "n/a") out.push({ text: `Revenue is declining (${rt.value})`, tierWeight: 0.6 });
  const gm = find(/gross margin/i);
  if (gm && gm.status === "bad" && /^\s*-/.test(String(gm.value || ""))) out.push({ text: `Negative gross margin (${gm.value})`, tierWeight: 0.6 });
  return out;
}

/** Compact single-line fundamentals for multi-ticker portfolio context */
export function formatXrayLine(ticker: string, xray: XrayResult, earningsDate: string | null): string {
  const get = (label: string) => {
    const val = [...xray.metrics, ...xray.valuation].find((m) => m.label === label)?.value;
    return val && val !== "n/a" ? val : null;
  };

  const parts = [
    `score ${xray.score.toFixed(1)}/10`,
    get("Revenue TTM") ? `Rev TTM ${get("Revenue TTM")}` : null,
    get("Revenue Trend") ? get("Revenue Trend") : null,
    get("Gross Margin") ? `Gross margin ${get("Gross Margin")}` : null,
    get("EPS") ? `EPS ${get("EPS")}` : null,
    get("Net Cash") ? `Net cash ${get("Net Cash")}` : null,
    get("P/S Ratio") ? `P/S ${get("P/S Ratio")}` : null,
    earningsDate ? `Earnings: ${earningsDate}` : null,
  ].filter(Boolean);

  return `${ticker} (${parts.join(" · ")})`;
}

/** Format technical levels into a concise prompt block */
export function formatTechnical(ta: TechnicalData, currentPrice?: number | null): string {
  const lines: string[] = [];
  if (ta.rsi !== null) {
    const label = ta.rsiSignal === "overbought"
      ? `RSI(14): ${ta.rsi} — OVERBOUGHT (>70) — momentum extended, do not chase`
      : ta.rsiSignal === "oversold"
      ? `RSI(14): ${ta.rsi} — OVERSOLD (<30) — historically a better entry zone`
      : `RSI(14): ${ta.rsi} — neutral`;
    lines.push(label);
  }
  if (ta.ma50) {
    const slopeTag = ta.ma50Slope !== null
      ? ta.ma50Slope > 0.015 ? " — trend strongly rising ↑↑"
      : ta.ma50Slope > 0.005 ? " — trend rising ↑"
      : ta.ma50Slope < -0.015 ? " — trend strongly falling ↓↓"
      : ta.ma50Slope < -0.005 ? " — trend falling ↓"
      : " — trend flat →"
      : "";
    lines.push(`50-day MA: $${ta.ma50.toFixed(2)}${currentPrice ? ` (price is ${currentPrice > ta.ma50 ? "above" : "below"})` : ""}${slopeTag}`);
  }
  if (ta.ma200)     lines.push(`200-day MA: $${ta.ma200.toFixed(2)}${currentPrice ? ` (price is ${currentPrice > ta.ma200 ? "above" : "below"})` : ""}`);
  if (ta.week52High && ta.week52Low) {
    lines.push(`52-week range: $${ta.week52Low.toFixed(2)} – $${ta.week52High.toFixed(2)}`);
    if (currentPrice) {
      const pct = ((currentPrice - ta.week52Low) / (ta.week52High - ta.week52Low) * 100).toFixed(0);
      lines.push(`Price position: ${pct}% up from 52wk low`);
    }
  }
  if (ta.avgVolume && ta.currentVolume) {
    const ratio = (ta.currentVolume / ta.avgVolume).toFixed(1);
    lines.push(`Volume: ${Number(ratio)}x average (${Number(ratio) >= 1.5 ? "elevated" : Number(ratio) <= 0.7 ? "low" : "normal"})`);
  }
  if (ta.beta) lines.push(`Beta: ${ta.beta.toFixed(2)}`);
  // Short interest — squeeze / crowded-short signal (stockanalysis.com source).
  // Verdict bucketed off short % of float (the standard crowdedness metric).
  if (ta.shortPercentOfFloat != null && ta.shortPercentOfFloat > 0) {
    const sp = ta.shortPercentOfFloat * 100;
    const verdict = sp >= 20 ? "Very High" : sp >= 10 ? "High" : sp >= 5 ? "Medium" : "Low";
    const sharesTxt = (ta.shortShares != null && ta.shortShares > 0) ? ` (${ta.shortShares >= 1e9 ? (ta.shortShares / 1e9).toFixed(2) + "B" : (ta.shortShares / 1e6).toFixed(1) + "M"} shares)` : "";
    lines.push(`Short interest: ${sp.toFixed(1)}% of float${sharesTxt} — squeeze potential ${verdict}`);
  }
  if (ta.daysToCover != null && ta.daysToCover > 0) {
    lines.push(`Days to cover: ${ta.daysToCover.toFixed(1)} days (higher = more squeeze fuel)`);
  }
  if (ta.ma50 && ta.ma200) {
    lines.push(`Trend: ${ta.ma50 > ta.ma200 ? "50-day MA above 200-day MA (bullish structure)" : "50-day MA below 200-day MA (bearish structure)"}`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Warrant / rights / unit resolver
// Maps derivative tickers to their underlying common stock for research purposes.
// INFQ.WS → INFQ, INFQ-WT → INFQ, RGTIW → RGTI, AMCWW → AMC
// ---------------------------------------------------------------------------

export function resolveResearchTicker(raw: string): string {
  const t = raw.trim().toUpperCase().replace(/^\./, "");
  // Exchange-qualified warrant suffixes
  if (/\.(WS|WT|RT|UN|U)$/i.test(t)) return t.replace(/\.(WS|WT|RT|UN|U)$/i, "");
  // Dash-separated warrant suffixes
  if (/-(WT|WS|UN|U)$/i.test(t)) return t.replace(/-(WT|WS|UN|U)$/i, "");
  // Double-W (AMCWW → AMC)
  if (t.endsWith("WW") && t.length >= 4) return t.slice(0, -2);
  // Single trailing W on tickers 5+ chars (RGTIW → RGTI, but not BBW or AMC)
  if (t.endsWith("W") && t.length >= 5) return t.slice(0, -1);
  return t;
}

const YF_UA = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" };

/** True if Yahoo has a live price for this exact symbol — used to probe Canadian suffixes. */
export async function hasChartPrice(symbol: string): Promise<boolean> {
  for (const host of ["query1", "query2"]) {
    try {
      const res = await fetch(`https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=5d&interval=1d`, { headers: YF_UA, cache: "no-store" });
      if (!res.ok) continue;
      const j = await res.json();
      const meta = j?.chart?.result?.[0]?.meta;
      if (meta && (meta.regularMarketPrice != null || meta.chartPreviousClose != null || meta.previousClose != null)) return true;
    } catch { /* next host */ }
  }
  return false;
}

/** Company name + sector + industry from Yahoo search — works for Canadian/OTC listings
 *  where the US fundamentals feeds are blocked, so the AI knows what the company actually is. */
export async function fetchYahooProfile(symbol: string): Promise<{ sector: string | null; industry: string | null; name: string | null }> {
  for (const host of ["query1", "query2"]) {
    try {
      const res = await fetch(`https://${host}.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(symbol)}&quotesCount=4&newsCount=0`, { headers: YF_UA, next: { revalidate: 86400 } });
      if (!res.ok) continue;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const data: any = await res.json();
      const quotes: Record<string, unknown>[] = Array.isArray(data?.quotes) ? data.quotes : [];
      const up = symbol.toUpperCase();
      const q = quotes.find((x) => String(x.symbol || "").toUpperCase() === up) || quotes[0];
      if (!q) continue;
      return { sector: q.sector ? String(q.sector) : null, industry: q.industry ? String(q.industry) : null, name: (q.longname || q.shortname) ? String(q.longname || q.shortname) : null };
    } catch { /* next host */ }
  }
  return { sector: null, industry: null, name: null };
}

/** Resolve the best research symbol. A CAD/TSX-listed position's bare ticker can collide with
 *  a US security (e.g. "USA" = a US closed-end fund vs Americas Gold & Silver on the TSX), so when
 *  the position currency/exchange says Canadian, prefer the Canadian Yahoo listing (.TO/.NE/.V/.CN). */
export async function resolveResearchSymbol(raw: string, opts?: { currency?: string | null; exchange?: string | null }): Promise<string> {
  const base = resolveResearchTicker(raw).replace(/\.(TO|V|CN|NE)$/i, "");
  const ccy = String(opts?.currency || "").toUpperCase();
  const exch = String(opts?.exchange || "").toUpperCase();
  const isCanadian = ccy === "CAD" || /TSX|TSXV|VENTURE|CSE|NEO|CBOE CANADA/.test(exch) || /\.(TO|V|CN|NE)$/i.test(raw);
  if (isCanadian) {
    for (const suffix of [".TO", ".NE", ".V", ".CN"]) {
      try { if (await hasChartPrice(base + suffix)) return base + suffix; } catch { /* keep probing */ }
    }
  }
  return base;
}

// ---------------------------------------------------------------------------
// Shared investor context — injected into every AI prompt as a system prefix
// ---------------------------------------------------------------------------

export type InvestorProfile = {
  goal?: number | null;
  currency?: string | null;
  deadline?: string | null;
  riskLevel?: string | null;
  investingStyle?: string | null;
  timeHorizon?: string | null;
  requiredAnnualReturn?: number | null;
  totalValue?: number | null;
  positionCount?: number | null;
};

/**
 * Builds a concise investor profile block prepended to every AI prompt, PLUS explicit
 * calibration instructions so the model genuinely tailors its emphasis to this investor
 * (not just acknowledges them). Objective facts/numbers stay the same for everyone — only
 * the lens, emphasis, and framing change.
 */
export function buildInvestorContext(profile: InvestorProfile | null | undefined): string {
  if (!profile) return "";
  const parts: string[] = [];
  if (profile.riskLevel) parts.push(`Risk tolerance: ${profile.riskLevel}`);
  if (profile.investingStyle) parts.push(`Investing style: ${profile.investingStyle}`);
  if (profile.timeHorizon) parts.push(`Time horizon: ${profile.timeHorizon}`);
  if (profile.goal && profile.currency)
    parts.push(`Portfolio goal: ${profile.currency}$${Number(profile.goal).toLocaleString("en")} by ${profile.deadline || "target date not set"}`);
  if (profile.requiredAnnualReturn != null)
    parts.push(`Required return to reach that goal: ~${profile.requiredAnnualReturn}%/year from where they stand today`);
  if (profile.totalValue && profile.currency)
    parts.push(`Current portfolio value: ${profile.currency}$${Number(profile.totalValue).toLocaleString("en")}`);
  if (profile.positionCount != null)
    parts.push(`Active positions: ${profile.positionCount}`);
  if (!parts.length) return "";
  return `INVESTOR CONTEXT — tailor your EMPHASIS and FRAMING to this person (keep all facts/numbers the same, only change what you weight and how you frame it):
${parts.join("\n")}
Calibration: A Conservative or long-horizon investor cares most about balance-sheet safety, downside, and durability — lead with those. An Aggressive/Extreme or short-horizon investor cares about catalysts, momentum, and asymmetric upside — lead with those. A value style weighs valuation and cash; a growth style weighs revenue growth and TAM; a dividend style weighs yield and stability. If the required return is high, be honest that the position needs to pull real weight; if it's modest, reward not over-reaching. Never recommend something outside their risk tolerance without flagging that it is.`;
}

/** Strip DeepSeek R1 chain-of-thought blocks before returning text to the caller */
export function stripThinkBlocks(raw: string): string {
  return raw.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

// Fix sloppy AI spacing: "$400million" → "$400 million", "convertiblenote" → stays (can't reliably split).
// Targets patterns that are objectively wrong regardless of context.
function fixAiSpacing(t: string): string {
  return t
    // digit glued to a long word: "400million" → "400 million". Skip single-char suffixes
    // (10Y, 2x, 3Q, 5B, 8K), ordinals (1st, 2nd, 3rd, 4th), and percent-like (5pct).
    .replace(/(\d)([a-zA-Z]{2,})/g, (m, d, w) => {
      if (/^(st|nd|rd|th|am|pm|yr|mo|wk|er|ly)$/i.test(w)) return m;
      return `${d} ${w}`;
    })
    // word glued to "$": "the$400" → "the $400"
    .replace(/([a-zA-Z])\$/g, "$1 $")
    // "AI" prefix smashed: "Alfocused" → "AI-focused" (common AI model error)
    .replace(/\bAl(focused|powered|driven|enabled|generated|based|native|first|ready|assisted)\b/g, "AI-$1")
    // double spaces
    .replace(/ {2,}/g, " ");
}

// ---------------------------------------------------------------------------
// Groq caller for free-text output (portfolio review, intel brief)
// ---------------------------------------------------------------------------

const GROQ_TEXT_MODELS = [
  // Current Groq models only. (deepseek-r1-distill-qwen-32b was removed — keeping a dead
  // model just burns a retry slot.) llama-3.3-70b is the quality pick; 8b-instant is the
  // fast fallback if the 70b is busy/rate-limited.
  { id: "llama-3.3-70b-versatile",       maxTokens: 800,  temperature: 0.3 },
  { id: "llama-3.1-8b-instant",          maxTokens: 600,  temperature: 0.3 },
];

export async function callGroqText(prompt: string, tempOverride?: number): Promise<string> {
  let lastError = "No models tried";
  for (const { id, maxTokens } of GROQ_TEXT_MODELS) {
    // DETERMINISM LAW: judgments/briefs must be stable (same facts → same answer), so default to
    // temp 0 unless a caller explicitly asks for variety. (Was per-model 0.3-ish → flickered.)
    const temperature = tempOverride ?? 0;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000); // 12s per model — fail fast and try next
    try {
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
        signal: controller.signal,
      });

      if (res.status === 404 || res.status === 400) {
        lastError = `${id} unavailable`;
        continue;
      }
      if (!res.ok) {
        const err = await res.text();
        throw new Error(`Groq ${res.status}: ${err.slice(0, 200)}`);
      }

      const data = await res.json() as { choices: { message: { content: string } }[] };
      const raw = data?.choices?.[0]?.message?.content || "";
      const text = fixAiSpacing(stripThinkBlocks(raw));
      if (text) return text;
      lastError = `${id} returned empty response`;
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") {
        lastError = `${id} timed out`;
        continue;
      }
      throw e;
    } finally {
      clearTimeout(timeout);
    }
  }
  throw new Error(`Groq: ${lastError}`);
}

// Cerebras — FREE tier (no credit card), very fast, generous daily limits. OpenAI-compatible.
// Models are reasoning models (gpt-oss-120b puts reasoning in a separate field and clean output
// in message.content), so we give them generous max_tokens so the reasoning doesn't starve the
// answer. Placed FIRST in the chain to absorb load off Groq/Gemini and avoid rate-limit dead-ends.
const CEREBRAS_MODELS = ["gpt-oss-120b", "zai-glm-4.7"];
export async function callCerebrasText(prompt: string, temperature = 0): Promise<string> {
  if (!process.env.CEREBRAS_API_KEY) return "";
  let lastError = "No models tried";
  for (const model of CEREBRAS_MODELS) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    try {
      const res = await fetch("https://api.cerebras.ai/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${process.env.CEREBRAS_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }], max_tokens: 3000, temperature }),
        signal: controller.signal,
      });
      if (res.status === 404 || res.status === 400) { lastError = `${model} unavailable`; continue; }
      if (!res.ok) { const err = await res.text(); throw new Error(`Cerebras ${res.status}: ${err.slice(0, 200)}`); }
      const data = await res.json() as { choices: { message: { content: string } }[] };
      const raw = data?.choices?.[0]?.message?.content || "";
      const text = fixAiSpacing(stripThinkBlocks(raw));
      if (text) return text;
      lastError = `${model} returned empty response`;
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") { lastError = `${model} timed out`; continue; }
      throw e;
    } finally {
      clearTimeout(timeout);
    }
  }
  throw new Error(`Cerebras: ${lastError}`);
}

// Google Gemini — generous FREE tier (no credit card). Used as the fallback when Groq is
// rate-limited, so the app keeps working without any paid provider. Returns "" if no key
// is configured (callers then fall through to the next provider).
// Current free-tier Gemini Flash models (verified available 2026-06). gemini-flash-latest is
// an alias that always points to the newest Flash, so the chain self-updates as Google ships.
const GEMINI_MODELS = ["gemini-2.5-flash", "gemini-flash-latest", "gemini-2.5-flash-lite"];
export async function callGeminiText(prompt: string, temperature = 0): Promise<string> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return "";
  let lastError = "No models tried";
  for (const model of GEMINI_MODELS) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 18000);
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            // thinkingBudget:0 disables Gemini 2.5's internal reasoning, which otherwise eats
            // the output-token budget and truncates/empties the response (broke JSON briefs).
            generationConfig: { temperature, maxOutputTokens: 1500, thinkingConfig: { thinkingBudget: 0 } },
          }),
          signal: controller.signal,
        }
      );
      if (res.status === 404 || res.status === 400) { lastError = `${model} unavailable`; continue; }
      if (!res.ok) { lastError = `Gemini ${res.status}: ${(await res.text()).slice(0, 160)}`; continue; }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const data: any = await res.json();
      const raw = (data?.candidates?.[0]?.content?.parts || []).map((p: { text?: string }) => p.text || "").join("");
      const text = fixAiSpacing(stripThinkBlocks(String(raw || "")));
      if (text.trim()) return text;
      lastError = `${model} returned empty response`;
    } catch (e) {
      lastError = e instanceof Error ? (e.name === "AbortError" ? `${model} timed out` : e.message) : String(e);
    } finally {
      clearTimeout(timeout);
    }
  }
  throw new Error(`Gemini: ${lastError}`);
}

// ---- Live news evidence (Google News RSS) ----
// Free, no-key, reachable from Vercel servers (unlike DuckDuckGo's HTML endpoint).
// Verifies "easily-Googleable" thesis claims (partnerships, acquisitions, order wins,
// earnings figures) for foreign/small-cap names whose facts the structured feed misses.
export type NewsEvidenceItem = { title: string; source: string; date: string; ts: number };

function decodeNewsEntities(text: string): string {
  return text
    .replace(/<!\[CDATA\[|\]\]>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const NEWS_QUERY_STOP = new Set([
  "the", "and", "for", "with", "this", "that", "its", "recent", "class", "near", "term",
  "high", "margin", "market", "growth", "revenue", "cash", "combination", "order", "backlog",
  "should", "pending", "holds", "booked", "posted", "now", "while", "expand", "company",
  "stock", "shares", "share", "year", "quarter", "from", "into", "over",
]);

export function buildNewsQueries(name: string | null, ticker: string, thesis: string): string[] {
  const base = (name || ticker || "").trim();
  if (!base) return [];
  const baseWords = new Set(base.toLowerCase().split(/\s+/));
  // The CHECKABLE catalysts in a thesis are its proper nouns — partnership, acquisition,
  // product, and certification names (NVIDIA, Covelya, QNX, FedRAMP). Dollar figures hurt
  // news-search relevance, so we drop them and search the names instead.
  const proper = (thesis.match(/\b[A-Z][A-Za-z0-9.&-]{2,}\b/g) || [])
    .map((s) => s.trim())
    .filter(
      (t) =>
        t &&
        !baseWords.has(t.toLowerCase()) &&
        !NEWS_QUERY_STOP.has(t.toLowerCase()) &&
        !/^Q[1-4]$/i.test(t) &&
        !/^FY?\d/i.test(t)
    );
  const uniq = Array.from(new Set(proper)).slice(0, 6);
  // q1 = targeted catalyst search (most relevant), q2 = general recent coverage.
  const q1 = `${base}${uniq.length ? " " + uniq.join(" ") : ""}`.trim();
  const q2 = `${base} stock news`;
  return Array.from(new Set([q1, q2])).filter(Boolean);
}

export async function fetchNewsEvidence(queries: string[], perQuery = 5, maxTotal = 8, budgetMs = 6500): Promise<NewsEvidenceItem[]> {
  const out: NewsEvidenceItem[] = [];
  const seen = new Set<string>();
  // Drop clearly stale items (> ~18 months), but KEEP the targeted-query (relevance) order
  // Google returns — a global date-sort buries the specific catalyst (an acquisition or
  // partnership headline) under newer generic "quarterly results" coverage.
  const cutoff = Date.now() - 1000 * 60 * 60 * 24 * 550;
  // SELF-BUDGET — return PARTIAL results, never get nuked. Previously the caller wrapped this in
  // cap(..., 7000, []) — if one slow query blew the budget, the WHOLE result was discarded (WPM returned
  // 0 news because its mining-lens "drill results" queries ran first, slow, and the cap nuked everything).
  // Now we own the budget: a per-query AbortTimeout bounds each fetch, and we stop starting new queries
  // once the budget is spent, returning whatever we already have. So later queries never erase earlier hits.
  const deadline = Date.now() + budgetMs;
  for (const query of queries) {
    if (!query) continue;
    if (Date.now() >= deadline && out.length) break; // budget spent and we have something → return it
    try {
      const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
      // Cache the RSS 30 min: Google News reorders results on every raw fetch, which made the thesis
      // verdict flicker between re-runs. A short shared cache = the SAME evidence across rapid rechecks
      // = a STABLE verdict (deterministic at temp 0). Fresh news still arrives every 30 min.
      const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }, next: { revalidate: 1800 }, signal: AbortSignal.timeout(Math.max(1500, deadline - Date.now())) });
      if (!res.ok) continue;
      const xml = await res.text();
      const blocks = xml.split(/<item>/).slice(1, perQuery + 1);
      for (const block of blocks) {
        const rawTitle = (block.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || "";
        const pub = (block.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1] || "";
        let title = decodeNewsEntities(rawTitle);
        let source = "";
        // Google News formats titles as "Headline - Source"
        const dash = title.lastIndexOf(" - ");
        if (dash > 0 && title.length - dash < 45) { source = title.slice(dash + 3).trim(); title = title.slice(0, dash).trim(); }
        if (!title || title.length < 8) continue;
        const key = title.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 60);
        if (seen.has(key)) continue;
        const ts = pub ? Date.parse(pub) : 0;
        if (ts && ts < cutoff) continue;
        seen.add(key);
        out.push({ title, source, date: pub, ts: Number.isFinite(ts) ? ts : 0 });
        if (out.length >= maxTotal) return out;
      }
    } catch { /* news evidence is supplementary — core facts still run */ }
  }
  return out.slice(0, maxTotal);
}

// ---- Mining lens ----
// Explorers/developers can't be judged like general equities: revenue/EPS/margins are
// often irrelevant, and what matters is stage, drill results/continuity, jurisdiction,
// cash runway/dilution, and the next assay/resource/permit catalyst. We DETECT mining
// names conservatively (mining identity + a commodity) and feed the AI the right signals
// and framing — it still synthesizes the verdict (no hard scoring rubric).
const MINING_COMMODITY = /\b(gold|silver|copper|uranium|lithium|nickel|zinc|cobalt|molybdenum|palladium|platinum|tin|tungsten|rare earth|graphite|vanadium|potash|manganese|antimony)\b/i;
const MINING_IDENTITY = /\b(mining|miner|minerals?|mines?|metals?|exploration|resources?|gold|silver|copper|uranium|lithium)\b/i;
const MINING_STAGE = /\b(drill|drilling|assay|intercept|g\/t|grade|resource estimate|mineral resource|ni ?43-?101|pea|pfs|dfs|feasibility|deposit|orebody|ore body|mineralization|exploration|tonnage|aisc)\b/i;

export type MiningClassification = { isMining: boolean; commodity: string | null };

export function classifyMining(input: {
  name?: string | null; sector?: string | null; industry?: string | null; description?: string | null;
}): MiningClassification {
  const identity = [input.name, input.sector, input.industry, input.description]
    .filter(Boolean).join(" ");
  if (!identity) return { isMining: false, commodity: null };
  // Strong signal: explicit mining sector/industry, OR a mining-identity word backed by a
  // commodity or an exploration-stage term (so "Apple resources" alone won't trip it).
  const sectorIndustry = [input.sector, input.industry].filter(Boolean).join(" ").toLowerCase();
  const sectorMining = /(mining|metals|materials|precious metals|gold|silver|coal & consumable fuels|steel)/.test(sectorIndustry) && MINING_IDENTITY.test(identity);
  const nameMining = MINING_IDENTITY.test(identity) && (MINING_COMMODITY.test(identity) || MINING_STAGE.test(identity));
  const isMining = Boolean(sectorMining || nameMining);
  const commodity = (identity.match(MINING_COMMODITY) || [])[0]?.toLowerCase() || null;
  return { isMining, commodity };
}

export function buildMiningNewsQueries(name: string | null, ticker: string, commodity: string | null): string[] {
  const base = (name || ticker || "").trim();
  if (!base) return [];
  return [
    `${base} drill results assay resource`,
    `${base}${commodity ? " " + commodity : ""} PEA financing permit`.trim(),
  ];
}

export function computeCashRunway(totalCash: number | null, operatingCashflow: number | null): string | null {
  if (totalCash == null || totalCash <= 0) return null;
  const cashM = totalCash / 1e6;
  if (operatingCashflow == null) return `Cash on hand: ~$${cashM.toFixed(1)}M (operating cash flow not available — runway unknown)`;
  if (operatingCashflow >= 0) return `Cash on hand: ~$${cashM.toFixed(1)}M, and operating cash flow is positive (no burn — not dependent on near-term financing)`;
  const burnAnnual = Math.abs(operatingCashflow);
  const months = totalCash / (burnAnnual / 12);
  const monthsTxt = months >= 36 ? "36+ " : `~${Math.round(months)} `;
  return `Cash runway: ${monthsTxt}months (cash ~$${cashM.toFixed(1)}M ÷ operating burn ~$${(burnAnnual / 1e6).toFixed(1)}M/yr) — ${months < 12 ? "short runway, dilution/financing likely near-term" : "reasonable runway"}`;
}

// Analytical frame fed into mining briefs/thesis-checks. Tells the AI WHAT MATTERS for a
// miner — it still decides the verdict from the cited evidence (fluid, not scripted).
export const MINING_LENS_FRAME = `MINING LENS — judge this as a mining/exploration company, NOT a general equity. P/E, EPS, margins, and analyst price targets are largely irrelevant for an explorer/developer; do not lean on them. What actually matters, in order:
1. STAGE — grassroots explorer, discovery, resource-definition, developer, or producer. Name it if the evidence shows it.
2. DRILL RESULTS & CONTINUITY — is the deposit GROWING with continuity (grade × width × depth, near-surface vs deep), or just isolated flashy intercepts? Continuity beats one big hit. Cite real intercepts/grades only if they appear in the evidence.
3. JURISDICTION — safe (Canada/Australia/US) vs permit-hostile/unstable regions.
4. CASH RUNWAY & DILUTION — explorers burn cash and raise often; a short runway is a real risk and a likely near-term dilution catalyst.
5. NEXT CATALYST — assays pending, resource update, PEA/PFS/DFS, permit, financing, JV, or production decision.
6. WHAT KILLS THE THESIS — bad/narrow assays, no continuity, metallurgical problems, permit delays, or dilutive financing.
Only state drill grades, resource sizes, or financing figures that appear in the cited evidence above — never invent geology or numbers from memory.`;

// ---- Biotech lens ----
// Clinical-stage biotechs are binary-catalyst businesses: revenue/EPS/margins are usually
// irrelevant pre-commercialization, and value hinges on the pipeline, trial readouts, the
// regulatory path, and cash runway into the next catalyst. We DETECT conservatively (biotech
// industry, OR a biotech identity backed by a clinical-stage term) and frame the analysis —
// the AI still synthesizes the verdict. Restricted to pharma/biotech industries so it never
// leaks onto hospitals, insurers, or device distributors.
// STRONG = essentially always clinical-stage (a "biotechnology"/"therapeutics" industry). WEAK = a label
// that ALSO covers revenue-generating non-clinical businesses (generic/compounding drug makers, consumer
// telehealth like Hims & Hers under "Drug Manufacturers"), so it needs a clinical-stage corroboration
// before the binary-catalyst biotech lens applies — otherwise it mis-frames a profitable company.
const BIOTECH_INDUSTRY_STRONG = /(biotechnolog|therapeutic)/i;
const BIOTECH_INDUSTRY_WEAK = /(drug manufactur|pharmaceutic|diagnostics ?& ?research)/i;
const BIOTECH_INDUSTRY = /(biotechnolog|drug manufactur|pharmaceutic|diagnostics ?& ?research|therapeutic)/i;
const BIOTECH_IDENTITY = /\b(therapeutics?|biopharma\w*|pharmaceutical?s?|biosciences?|biotech\w*|oncolog\w*|genomics?|gene therapy|cell therapy|immuno\w*|vaccine|biologics?)\b/i;
const BIOTECH_STAGE = /\b(phase ?[123i]+\b|phase one|phase two|phase three|clinical trial|fda|nda|bla|ind\b|pdufa|topline|read ?out|primary endpoint|pivotal|efficacy|enrollment|orphan drug|breakthrough therapy|first-in-human|investigational)\b/i;

export type BiotechClassification = { isBiotech: boolean };

export function classifyBiotech(input: {
  name?: string | null; sector?: string | null; industry?: string | null; description?: string | null;
}): BiotechClassification {
  const identity = [input.name, input.sector, input.industry, input.description].filter(Boolean).join(" ");
  if (!identity) return { isBiotech: false };
  const industry = [input.sector, input.industry].filter(Boolean).join(" ");
  // STRONG industry (biotechnology/therapeutics) → clinical-stage by itself. WEAK industry (generic
  // drug-maker / pharma / diagnostics — also covers profitable non-clinical names) → only biotech if a
  // clinical-stage term or a biotech-identity word corroborates it, so consumer telehealth (Hims & Hers,
  // "Drug Manufacturers") isn't mis-framed with the trial/FDA lens.
  const industryBio = BIOTECH_INDUSTRY_STRONG.test(industry)
    || (BIOTECH_INDUSTRY_WEAK.test(industry) && (BIOTECH_STAGE.test(identity) || BIOTECH_IDENTITY.test(input.name || "")));
  const nameBio = BIOTECH_IDENTITY.test(identity) && (BIOTECH_STAGE.test(identity) || BIOTECH_INDUSTRY.test(identity));
  return { isBiotech: Boolean(industryBio || nameBio) };
}

export function buildBiotechNewsQueries(name: string | null, ticker: string): string[] {
  const base = (name || ticker || "").trim();
  if (!base) return [];
  return [
    `${base} trial results data readout`,
    `${base} FDA phase clinical`,
  ];
}

// Analytical frame for biotech briefs/thesis-checks. WHAT MATTERS for a clinical-stage name —
// the AI still decides the verdict from the cited evidence (fluid, not scripted).
export const BIOTECH_LENS_FRAME = `BIOTECH LENS — judge this as a clinical-stage / biotech company, NOT a general equity. Revenue, P/E, and margins are usually irrelevant for a pre-commercial biotech; the value is in the pipeline and its binary catalysts. What matters, in order:
1. STAGE & LEAD ASSET — preclinical, Phase 1, Phase 2, Phase 3, NDA/BLA filed, or approved. Name the lead program and where it sits.
2. BINARY CATALYST & TIMING — the next trial readout, PDUFA date, or FDA decision, and when it lands. Be precise about regulatory wording: enrolled ≠ topline data ≠ filed ≠ accepted ≠ approved.
3. ENDPOINT & PRIOR DATA — did earlier data hit its PRIMARY endpoint, and is the trial design / statistical bar credible? A secondary-endpoint win with a missed primary is not success.
4. CASH RUNWAY & DILUTION — biotechs burn cash and raise around catalysts; a short runway INTO a readout is a real risk and a likely dilution event.
5. PIPELINE CONCENTRATION — single-asset binary risk vs a diversified pipeline (one failed trial can halve a single-asset name).
6. REGULATORY PATH & MARKET — approval pathway, competition, and the addressable patient population.
Only state trial data, event/patient counts, dates, or cash figures that appear in the cited evidence — never invent clinical results, p-values, or regulatory status from memory.`;

// ============================================================================
// Claim-level verification engine (Phase 1, gated by CLAIM_VERIFY)
// ----------------------------------------------------------------------------
// Pipeline: (1) deterministically EXTRACT the material factual claims a thesis makes,
// (2) RETRIEVE targeted evidence per claim (Google News RSS workhorse + SEC EDGAR full-text
// as a tier-1 corroboration signal), (3) hand a claim-tagged evidence packet to the EXISTING
// thesis-check AI call to CLASSIFY each claim (Verified / Contradicted / Forecast / Unverified /
// Weak-Source). No new AI calls; additive and fail-open; "Unverified" stays neutral; nothing
// here forces a verdict — the model still synthesizes.
// ============================================================================

export type ThesisClaim = { type: string; value: string | null; weight: number; raw: string };

const CLAIM_MAX = 4;

const CLAIM_DETECTORS: { type: string; w: number; re: RegExp }[] = [
  { type: "revenueGrowth", w: 9, re: /\b(?:grew|growth|increased|rose|gained|up|jump\w*)\b[^.]{0,25}?(\d{1,3}(?:\.\d+)?)\s*%|(\d{1,3}(?:\.\d+)?)\s*%[^.]{0,30}?\b(?:yoy|year[- ]over[- ]year|growth|increase|rise|gain)\b/i },
  { type: "backlog", w: 9, re: /\$?\s*(\d[\d,.]*)\s*(?:million|billion|m|b)\b[^.]{0,30}?\b(?:backlog|bookings|order book)\b|\b(?:backlog|bookings)\b[^.]{0,20}?\$?\s*(\d[\d,.]*)\s*(?:million|billion|m|b)/i },
  { type: "drillResult", w: 9, re: /(\d+(?:\.\d+)?)\s*m(?:etre|eter)?s?\b[^.]{0,30}?(\d[\d,.]*)\s*(?:g\/t|%|oz\/t)|(\d[\d,.]*)\s*g\/t\b/i },
  { type: "trialEvent", w: 9, re: /\bphase\s*([0-3i]+)\b|(\d+)\s*\/\s*(\d+)\s*events?\b|\b(readout|topline|primary endpoint|interim analysis|pivotal)\b/i },
  { type: "permitStatus", w: 8, re: /\b(?:permit|licen[sc]e|nrc|fda|pdufa|approval|certification|fedramp)\b[^.]{0,40}?\b(submitted|filed|accepted|approved|pending|granted|cleared|received|under review|decision)\b/i },
  { type: "operatingMetric", w: 8, re: /((?:\d[\d,.]*)\s*(?:million|billion|m|b|k|thousand)?)\s*(?:[a-z]+\s+){0,2}?(?:attendance|moviegoers|patrons|admissions|subscribers|users|members|deliveries|visitors|guests)\b|\b(?:attendance|subscribers|deliveries|moviegoers|patrons)\b[^.]{0,25}?((?:\d[\d,.]*)\s*(?:million|billion|m|b|k|thousand)?)/i },
  // QUALITATIVE growth/momentum claim — the load-bearing narrative premise with NO hard number ("revenue
  // accelerates", "attendance improving", "margins recover"). High weight (usually the core of the thesis),
  // and almost always hard to VERIFY from a clean source → it correctly surfaces as the Critical Unknown.
  { type: "growthNarrative", w: 8, re: /\b(accelerat\w+|re-?accelerat\w+|ramp\w*|improv\w+|expand\w+|recover\w+|rebound\w*|surg\w+|inflect\w+|turnaround|turning around|breakout|re-?rat\w+|growth|grow(?:ing|s)?|rising|climb\w+|gaining|demand)\b/i },
  { type: "revenueFigure", w: 7, re: /\$?\s*(\d[\d,.]*)\s*(?:million|billion|m|b)\b[^.]{0,20}?\b(?:revenue|sales|top-?line)\b|\b(?:revenue|sales)\b[^.]{0,15}?\$?\s*(\d[\d,.]*)\s*(?:million|billion|m|b)/i },
  { type: "cashBalance", w: 7, re: /\$?\s*(\d[\d,.]*)\s*(?:million|billion|m|b)\b[^.]{0,20}?\b(?:cash|liquidity|runway)\b|\b(?:cash|runway)\b[^.]{0,20}?\$?\s*(\d[\d,.]*)\s*(?:million|billion|m|b)|\b(zero|no)\s+debt\b/i },
  { type: "partnership", w: 7, re: /\b(?:partnership|collaboration|agreement|joint venture|\bjv\b|offtake|acquir\w+|acquisition|merger|deal)\b/i },
  { type: "production", w: 7, re: /(\d[\d,.]*)\s*(?:oz|ounces|koz|tonnes|tons|boe|mw|gwh|mmlbs|lbs|units)\b/i },
  { type: "shortInterest", w: 6, re: /(\d{1,3}(?:\.\d+)?)\s*%[^.]{0,20}?\b(?:short|float)\b|\bshort interest\b/i },
  { type: "insider", w: 6, re: /\b(?:insider|ceo|cfo|chairman|director|founder|[A-Z][a-z]+)\s+(?:bought|purchased|acquired|added|sold)\b[^.]{0,30}?(\d[\d,.]*)?\s*(?:shares|stock|\$)/i },
  { type: "analystTarget", w: 5, re: /\$\s*(\d[\d,.]*(?:\.\d+)?)\s*(?:price\s*target|pt\b|target|consensus)|\b(?:price target|consensus)\b[^.]{0,15}?\$\s*(\d[\d,.]*)/i },
  { type: "earningsDate", w: 5, re: /\b(?:earnings|results|report)\b[^.]{0,25}?\b(q[1-4]\s*\d{2,4}|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(?:,?\s*\d{4})?|\d{4}-\d{2}-\d{2})\b/i },
];

const CLAIM_CAP_STOP = new Set(["The", "A", "An", "And", "For", "With", "This", "That", "Its", "Inc", "Corp", "Ltd", "Limited", "Group", "Holdings", "Phase", "Topline", "Q1", "Q2", "Q3", "Q4", "AI", "US", "USA", "CEO", "CFO", "NRC", "FDA", "PEA", "PFS", "DFS", "YoY", "May"]);

function claimFirstVal(m: RegExpMatchArray): string | null {
  for (let i = 1; i < m.length; i++) if (m[i] != null) return m[i];
  return null;
}

// Pull a partner/proper-noun name case-SENSITIVELY, excluding the company's own name + stopwords.
function claimProperNoun(raw: string, company: string | null): string | null {
  const companyWords = new Set(String(company || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(Boolean));
  const caps = raw.match(/\b[A-Z][A-Za-z.&]{2,}\b/g) || [];
  for (const c of caps) if (!CLAIM_CAP_STOP.has(c) && !companyWords.has(c.toLowerCase())) return c;
  return null;
}

export function extractClaims(thesis: string, catalyst?: string | null, company?: string | null): ThesisClaim[] {
  const text = [thesis, catalyst].filter(Boolean).join(". ");
  // Split into CLAUSES, not just sentences — "X as revenue accelerates and the Y partnership expands"
  // is three claims, not one. Splitting on connectors keeps each claim's `raw` to its own clause (so the
  // Critical Unknown reads as the specific premise, not the whole thesis) and lets a multi-part thesis
  // decompose into multiple scorable claims. (Boundaries: , ; — and the words as/because/driven by/while/and.)
  const clauses = text
    .replace(/\s+/g, " ")
    .split(/\s*[,;]\s*|\s+(?:as|because|driven by|fueled by|while|and|due to|thanks to)\s+/i)
    .map((c) => c.trim().replace(/^(?:i\s+(?:expect|think|believe|see)|expecting)\s+/i, ""))
    .filter((c) => c.length > 3);
  const out: ThesisClaim[] = [];
  const seenType = new Set<string>(); // one claim per type — keep the first (highest-signal) instance
  for (const s of clauses) {
    for (const d of CLAIM_DETECTORS) {
      if (seenType.has(d.type)) continue;
      const m = s.match(d.re);
      if (!m) continue;
      const rawVal = d.type === "partnership" ? claimProperNoun(s, company ?? null) : claimFirstVal(m);
      const value = rawVal ? rawVal.trim().replace(/[,.]$/, "") : null;
      seenType.add(d.type);
      out.push({ type: d.type, value, weight: d.w, raw: s.slice(0, 140) });
    }
  }
  out.sort((a, b) => b.weight - a.weight);
  return out.slice(0, CLAIM_MAX);
}

// LLM claim extraction (NEXUS-THESIS — the robust replacement for the brittle regex above). Extraction is a
// LOW-JUDGMENT task → runs on the FREE model chain ($0, never the paid tier). Deterministic at temp 0. Fully
// FAIL-OPEN: any provider error/rate-limit → returns null so the caller falls back to the regex extractor.
export async function extractClaimsLLM(thesis: string, catalyst: string | null, company: string | null): Promise<ThesisClaim[] | null> {
  const who = company || "the company";
  const prompt = `Extract the discrete, checkable FACTUAL CLAIMS that this investor's thesis makes about ${who}. A claim is a specific assertion a source could confirm or refute — a partnership/deal, a revenue/earnings figure or growth, a product/contract win, a regulatory step, an operating metric (attendance/subscribers/deliveries), a margin/cash fact, or an adoption/demand trend. EXCLUDE the price target and opinion words ("I expect", "should", "will rally") — capture only the factual PREMISES the conclusion rests on.
THESIS: "${thesis}"${catalyst ? `\nCATALYST: "${catalyst}"` : ""}
Return ONLY a JSON array (max 4 items, most load-bearing first), no prose:
[{"claim":"<the factual claim, <=12 words>","type":"<revenueGrowth|partnership|backlog|trialEvent|permitStatus|operatingMetric|guidance|product|regulatory|adoption|cashBalance|insider|growthNarrative|other>","value":"<key partner name / number, or null>","weight":<1-9 importance to the thesis>}]`;
  const parse = (raw: string): ThesisClaim[] | null => {
    try {
      let s = stripThinkBlocks(raw).replace(/```json/gi, "").replace(/```/g, "").trim();
      const a = s.indexOf("["), b = s.lastIndexOf("]");
      if (a >= 0 && b > a) s = s.slice(a, b + 1);
      const arr = JSON.parse(s);
      if (!Array.isArray(arr)) return null;
      const out: ThesisClaim[] = arr
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .map((c: any) => {
          const v = c?.value != null ? String(c.value).trim() : "";
          return {
            type: String(c?.type || "other").trim() || "other",
            value: v && v.toLowerCase() !== "null" ? v : null,
            weight: Number.isFinite(+c?.weight) ? Math.max(1, Math.min(9, Math.round(+c.weight))) : 7,
            raw: String(c?.claim || "").trim().slice(0, 140),
          };
        })
        .filter((c: ThesisClaim) => c.raw);
      return out.length ? out.slice(0, CLAIM_MAX) : null;
    } catch { return null; }
  };
  if (process.env.CEREBRAS_API_KEY) { try { const r = parse(await callCerebrasText(prompt, 0)); if (r) return r; } catch { /* next provider */ } }
  if (process.env.GROQ_API_KEY) { try { const r = parse(await callGroqText(prompt, 0)); if (r) return r; } catch { /* next provider */ } }
  if (process.env.GEMINI_API_KEY) { try { const r = parse(await callGeminiText(prompt, 0)); if (r) return r; } catch { /* fall through */ } }
  return null; // → caller uses the regex extractor
}

// Targeted news query per claim — company name + the salient tokens for that claim type.
function buildClaimQuery(claim: ThesisClaim, name: string): string {
  const v = claim.value ? ` ${claim.value}` : "";
  switch (claim.type) {
    case "revenueGrowth": return `${name} revenue growth${v}`;
    case "backlog": return `${name} backlog${v}`;
    case "revenueFigure": return `${name} revenue${v}`;
    case "cashBalance": return `${name} cash balance debt`;
    case "drillResult": return `${name} drill results${v} grade`;
    case "trialEvent": return `${name} trial phase readout data`;
    case "permitStatus": return `${name} permit${v} regulatory`;
    case "operatingMetric": return `${name} attendance results`;
    case "partnership": return `${name}${v} partnership deal`;
    case "production": return `${name} production${v}`;
    case "shortInterest": return `${name} short interest float`;
    case "insider": return `${name} insider buying shares`;
    case "analystTarget": return `${name} price target analyst`;
    case "earningsDate": return `${name} earnings date`;
    default: return `${name} ${claim.raw.split(/\s+/).slice(0, 4).join(" ")}`;
  }
}

// SEC EDGAR full-text search (efts.sec.gov) — tier-1 CORROBORATION only: confirms a claim's
// subject appears in an official filing (form + date), not the figure itself. Fail-open.
export async function fetchSecFtsCorroboration(phrase: string): Promise<string | null> {
  const p = phrase.trim();
  if (p.length < 4) return null;
  try {
    const url = `https://efts.sec.gov/LATEST/search-index?q=${encodeURIComponent('"' + p + '"')}`;
    const res = await fetch(url, { headers: { "User-Agent": "Plainview Research research@plainviewintel.com", Accept: "application/json" }, cache: "no-store" });
    if (!res.ok) return null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const j: any = await res.json();
    const hits = j?.hits?.hits || [];
    if (!hits.length) return null;
    // Prefer the most recent matching filing.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    hits.sort((a: any, b: any) => String(b?._source?.file_date || "").localeCompare(String(a?._source?.file_date || "")));
    const s = hits[0]._source || {};
    const company = (s.display_names || [])[0] || "company";
    if (!s.form || !s.file_date) return null;
    return `[SEC filing · tier-1] ${company} ${s.form} dated ${s.file_date} matches "${p}" — the claim's subject appears in an official SEC disclosure.`;
  } catch {
    return null; // fail-open: EDGAR is a bonus, never required
  }
}

// Resolve a US ticker to its zero-padded CIK via the EDGAR ticker map (cached 1h). Null for
// non-US/unlisted symbols. Reusable — the same lookup fetchSecSignals/fetchCashRunwaySec do inline.
export async function tickerToCik(ticker: string): Promise<string | null> {
  try {
    const res = await fetch("https://www.sec.gov/files/company_tickers.json", { headers: SEC_HEADERS, next: { revalidate: 3600 } });
    if (!res.ok) return null;
    const map = await res.json() as Record<string, { cik_str: number; ticker: string }>;
    const clean = ticker.replace(/\..*$/, "").toUpperCase();
    const row = Object.values(map).find((t) => t.ticker.toUpperCase() === clean);
    return row ? String(row.cik_str).padStart(10, "0") : null;
  } catch { return null; }
}

// Catalyst nouns a thesis rests on that are confirmable in a filing's FULL TEXT (a grant/contract/
// award/approval/etc), independent of WHEN it was filed. These are exactly the facts the 30-day
// fetchSecSignals window misses — e.g. Infleqtion's Feb-2026 government grant 8-Ks, still load-bearing
// for a June thesis. Order = most-distinctive first so the query targets the real catalyst.
const CATALYST_KEYWORDS = ["grant", "award", "contract", "funding", "partnership", "approval", "clearance", "acquisition", "merger", "milestone", "backlog", "license", "placement", "financing", "offering", "buyback", "expansion", "facility"];
// DATE-AGNOSTIC EDGAR full-text search, scoped to ONE company (by CIK when resolvable, else by name
// phrase). Surfaces a TIER-1 filing that confirms the thesis's catalyst no matter its age — closing the
// "no source confirms" miss that the 30-day recent-filings window and recent-news-only retrieval cause.
// Ungated, capped, fail-open, $0 (EDGAR's free FTS API — no LLM).
export async function fetchThesisEdgarEvidence(ticker: string, name: string | null, thesis: string): Promise<string[]> {
  const t = (thesis || "").toLowerCase();
  const keywords = CATALYST_KEYWORDS.filter((k) => t.includes(k)).slice(0, 2);
  if (!keywords.length) return []; // no confirmable catalyst noun → nothing distinctive to search
  const cik = await tickerToCik(ticker).catch(() => null);
  const company = (name || "").replace(/\b(inc|corp|ltd|llc|plc|co|holdings|technologies|group)\b\.?/gi, "").trim();
  if (!cik && company.length < 3) return []; // can't scope the search to this company → skip (avoid false matches)
  const seen = new Set<string>();
  const lines: string[] = [];
  const cap = <T>(p: Promise<T>, ms: number, fb: T): Promise<T> => Promise.race([p, new Promise<T>((r) => setTimeout(() => r(fb), ms))]);
  for (const kw of keywords) {
    try {
      // Scope by CIK when we have it (exact, no false matches); otherwise AND the company name phrase.
      const q = cik ? `"${kw}"` : `"${company}" "${kw}"`;
      const url = `https://efts.sec.gov/LATEST/search-index?q=${encodeURIComponent(q)}${cik ? `&ciks=${cik}` : ""}&forms=8-K,10-K,10-Q,6-K,20-F`;
      const res = await cap(fetch(url, { headers: { "User-Agent": "Plainview Research research@plainviewintel.com", Accept: "application/json" }, cache: "no-store" }), 5000, null as Response | null);
      if (!res || !res.ok) continue;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const j: any = await res.json();
      const hits = (j?.hits?.hits || []) as Array<{ _source?: { form?: string; file_date?: string; display_names?: string[] } }>;
      if (!hits.length) continue;
      hits.sort((a, b) => String(b._source?.file_date || "").localeCompare(String(a._source?.file_date || "")));
      // When unscoped by CIK, keep only hits whose filer name actually matches the company (guard false matches).
      const filtered = cik ? hits : hits.filter((h) => (h._source?.display_names || []).some((d) => d.toLowerCase().includes(company.toLowerCase().split(" ")[0])));
      const top = filtered[0];
      if (!top || !top._source?.form || !top._source?.file_date) continue;
      const s = top._source;
      const key = `${s.form}|${s.file_date}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const filer = (s.display_names || [])[0]?.replace(/\s*\(CIK.*$/, "").trim() || company || ticker;
      lines.push(`${filer} ${s.form} dated ${s.file_date} — full text contains "${kw}" (SEC EDGAR full-text search, tier-1; confirms the catalyst's subject appears in an official filing).`);
    } catch { /* fail-open per keyword */ }
  }
  return lines;
}

// Build the single most-distinctive EDGAR phrase from the claim set (proper noun / backlog /
// permit / drill). Returns null when nothing distinctive enough to be worth a tier-1 lookup.
function bestEdgarPhrase(claims: ThesisClaim[]): string | null {
  const partner = claims.find((c) => c.type === "partnership" && c.value);
  if (partner) return String(partner.value);
  const backlog = claims.find((c) => c.type === "backlog");
  if (backlog) return "royalty backlog";
  const permit = claims.find((c) => c.type === "permitStatus");
  if (permit) return "permit";
  return null;
}

// `evidence` exposes the SOURCES fetched per claim (structured), so the deterministic Phase-1 scorer can
// tier each claim in code (NEXUS-THESIS §2.1) instead of relying on the LLM's classification.
export type ClaimEvidence = { claim: ThesisClaim; sources: { kind: "edgar" | "news"; source: string; title: string; date: string }[] };
export type ClaimVerifyResult = { block: string | null; claims: ThesisClaim[]; evidence: ClaimEvidence[] };

// Orchestrator: extract → retrieve (capped, parallel, fail-open) → assemble a claim-tagged
// evidence block for the thesis-check prompt. Returns { block, claims } (claims exposed for tests).
export async function verifyClaims(input: {
  thesis: string; catalyst?: string | null; name: string | null; ticker: string;
}): Promise<ClaimVerifyResult> {
  const name = (input.name || input.ticker || "").trim();
  // LLM extraction (free chain) with the regex extractor as the fail-open fallback — robust decomposition
  // even for number-less / unusually-phrased claims the regex misses. $0 (free tier), deterministic (temp 0).
  const claims = (await extractClaimsLLM(input.thesis, input.catalyst ?? null, name).catch(() => null))
    || extractClaims(input.thesis, input.catalyst, name);
  if (!claims.length || !name) return { block: null, claims, evidence: [] };

  const cap = <T>(p: Promise<T>, ms: number, fb: T): Promise<T> =>
    Promise.race([p, new Promise<T>((r) => setTimeout(() => r(fb), ms))]);

  // Per-claim news (≤4 claims × 1 query, parallel) + a single EDGAR corroboration. ≤5 fetches.
  const newsPerClaim = await Promise.all(
    claims.map((c) => cap(fetchNewsEvidence([buildClaimQuery(c, name)], 3, 3), 6000, [] as NewsEvidenceItem[]))
  );
  const edgarPhrase = bestEdgarPhrase(claims);
  const edgar = edgarPhrase ? await cap(fetchSecFtsCorroboration(edgarPhrase), 5000, null) : null;

  const lines: string[] = [];
  const evidence: ClaimEvidence[] = [];
  claims.forEach((c, i) => {
    const label = c.value ? `${c.type} ("${c.raw}")` : `${c.type} ("${c.raw}")`;
    lines.push(`Claim ${i + 1} — ${label}:`);
    const news = newsPerClaim[i] || [];
    const srcs: ClaimEvidence["sources"] = [];
    let any = false;
    for (const n of news) {
      any = true;
      lines.push(`  - [news] "${n.title}"${n.source ? ` — ${n.source}` : ""}${n.ts ? ` (${new Date(n.ts).toISOString().slice(0, 10)})` : ""}`);
      srcs.push({ kind: "news", source: n.source || "", title: n.title || "", date: n.ts ? new Date(n.ts).toISOString().slice(0, 10) : "" });
    }
    // Attach EDGAR corroboration to the claim it was built from.
    if (edgar && ((c.type === "partnership" && edgarPhrase === c.value) || (c.type === "backlog" && edgarPhrase === "royalty backlog") || (c.type === "permitStatus" && edgarPhrase === "permit"))) {
      lines.push(`  - ${edgar}`);
      any = true;
      srcs.push({ kind: "edgar", source: "SEC EDGAR", title: String(edgar), date: "" });
    }
    if (!any) lines.push(`  - (no targeted source found — treat as Unverified, not Contradicted)`);
    evidence.push({ claim: c, sources: srcs });
  });

  const block =
    `CLAIM-LEVEL EVIDENCE — the thesis makes these specific factual claims; targeted sources were fetched for EACH. ` +
    `Classify every claim as Verified (a reliable source here confirms it), Contradicted (a reliable source here disproves it), ` +
    `Forecast/Guidance (a future-dated event, management/analyst expectation, or a "submitted/pending/expected" status — NOT yet a fact; submitted ≠ accepted ≠ approved), ` +
    `Unverified (no source here confirms it — NEUTRAL, never counts against the thesis), or Weak-Source (only low-quality/chatter). ` +
    `Use ONLY the sources listed below for each claim — never a Plainview-generated note. Reflect these classifications in your evidence points and let the overall status follow their weight. ` +
    `RECENCY: sources are dated (YYYY-MM-DD). When two sources CONFLICT on the same fact, the more recent one wins — a correction, restatement, or newer update supersedes the older report; never let a stale figure override a fresher one.\n\n` +
    lines.join("\n");
  return { block, claims, evidence };
}

// ---- Crypto lens ----
// Crypto isn't a business: no earnings, analysts, insiders, or "business quality". Its catalysts
// are native — regulation/ETF flows, adoption/network usage, the tokenization & settlement
// narrative (DTCC/ISO 20022), and liquidity. We DETECT crypto by Yahoo pair suffix or a known
// symbol, feed the right framing + targeted catalyst news, and — crucially — make the thesis
// engine SKEPTICAL about token value-accrual (a sector narrative is not automatically bullish for
// one specific token). No fabricated sub-scores; the AI synthesizes from real evidence.
const CRYPTO_SYMBOLS = new Set([
  "BTC", "ETH", "XRP", "SOL", "HBAR", "XLM", "XDC", "ADA", "DOGE", "LINK", "AVAX", "MATIC", "POL",
  "BNB", "DOT", "LTC", "BCH", "TRX", "ATOM", "UNI", "ALGO", "NEAR", "APT", "ARB", "OP", "SUI",
]);

export function isCryptoTicker(sym: string | null | undefined): boolean {
  const s = String(sym || "").toUpperCase();
  if (/-(USD|CAD|USDT)$/.test(s)) return true;
  return CRYPTO_SYMBOLS.has(s.replace(/-(USD|CAD|USDT)$/, ""));
}

export function buildCryptoNewsQueries(name: string | null, ticker: string): string[] {
  const base = String(name || ticker || "").replace(/-(USD|CAD|USDT)$/i, "").trim();
  if (!base) return [];
  return [
    `${base} crypto ETF regulation`,
    `${base} adoption partnership tokenization`,
  ];
}

export const CRYPTO_LENS_FRAME = `CRYPTO LENS — judge this as a crypto asset, NOT a stock. There are no earnings, analyst price targets, insiders, or "business quality" — do not look for them or penalize their absence. What matters, in order:
1. REGULATORY STATUS — the real catalyst layer for crypto: ETF approvals and flows, and legislation (e.g. GENIUS Act, CLARITY Act, stablecoin frameworks). Cite only developments that appear in the evidence.
2. ADOPTION & NETWORK USAGE — actual usage, transactions, institutional/payment partnerships, developer activity — not just price.
3. TOKENIZATION & SETTLEMENT NARRATIVE — tokenized treasuries/securities, cross-border settlement, DTCC and ISO 20022 modernization. This is the core thesis for payment coins (XRP, XLM, XDC, HBAR, ALGO).
4. LIQUIDITY & MARKET STRUCTURE — exchange flows, market cap, volume, supply/unlocks, correlation to Bitcoin.
5. THE NEXT CATALYST — an ETF decision, a regulatory vote, a major partnership, or a network upgrade.
CRYPTO SKEPTICISM (apply this hard — it is where most crypto theses are weak): a sector narrative is NOT automatically a reason THIS token rises. Pressure-test value accrual:
 - Does the narrative actually REQUIRE this token, or would blockchain/a stablecoin/a private ledger work just as well?
 - Is the COMPANY being adopted (e.g. Ripple's software) vs the TOKEN itself (XRP)? Banks using Ripple does not necessarily mean banks buy XRP.
 - Is ISO 20022 / DTCC / tokenization activity specific to this token, or generic to the industry?
 - Could a competitor (e.g. XLM vs XRP) capture the same use case?
"The financial system is modernizing toward what holders envision" is a narrative, NOT verified token demand — treat it as unproven unless the evidence shows real, token-specific adoption or flows. Only state ETF flows, regulatory status, or adoption figures that appear in the cited evidence — never invent them.`;

// ---- Universal asset profile (Phase 1) ----
// One place that turns an asset into { type, stage, label } by reusing the existing detectors.
// The LABEL is a one-line "what this is + what its thesis depends on", surfaced across features so
// every asset is framed by the right lens — fair, curated analysis without rejiggering score math.
// Frames/labels (not rigid scored checklists) keep it fluid. Falls back to "general" when unsure.
export type AssetProfile = { type: string; stage: string; label: string };

export function getAssetProfile(input: {
  name?: string | null; sector?: string | null; industry?: string | null; description?: string | null;
  isETF?: boolean; isCrypto?: boolean;
  epsVal?: number | null; opCashflow?: number | null; revTtm?: number | null; revGrowth?: number | null; netCash?: number | null;
}): AssetProfile {
  const eps = input.epsVal ?? null, ocf = input.opCashflow ?? null, rev = input.revTtm ?? null, growth = input.revGrowth ?? null, nc = input.netCash ?? null;
  // Pre-revenue / cash-burning signature (same discriminant the X-Ray relabel uses).
  const preRev = (eps == null || eps <= 0) && (ocf == null || ocf < 0) && (rev == null || rev < 5e7);
  // Leverage = debt exceeds cash (net cash negative). The key signal that separates a TURNAROUND
  // (debt-pressured, recovering) from a cash-rich SCALING growth company (IONQ burns cash but holds
  // huge net cash). Avoids the "stock is down → turnaround" trap.
  const leveraged = nc != null && nc < 0;

  if (input.isCrypto) return { type: "crypto", stage: "network", label: "Crypto asset — judged on adoption, liquidity, regulation/ETF flow & catalysts, not business fundamentals." };
  if (input.isETF) return { type: "etf", stage: "basket", label: "ETF / passive basket — judged on holdings, concentration, fees & macro exposure, not single-company fundamentals." };

  const mining = classifyMining({ name: input.name, sector: input.sector, industry: input.industry, description: input.description });
  if (mining.isMining) {
    return preRev
      ? { type: "miner", stage: "explorer", label: "Junior explorer / developer — judged on resource quality, drill results, jurisdiction, cash runway & the next technical catalyst, not earnings." }
      : { type: "miner", stage: "producer", label: "Mining producer — judged on production, costs (AISC), reserves, the commodity price & the balance sheet." };
  }
  const bio = classifyBiotech({ name: input.name, sector: input.sector, industry: input.industry, description: input.description }).isBiotech;
  if (bio) {
    return preRev
      ? { type: "biotech", stage: "clinical", label: "Clinical-stage biotech — a binary bet on trial readouts, cash runway & the regulatory path, not earnings." }
      : { type: "pharma", stage: "commercial", label: "Commercial-stage pharma — judged on drug revenue, pipeline depth, margins & the next readout." };
  }
  // Pre-revenue: healthy balance sheet → early-stage bet; debt-pressured → distressed/speculative.
  if (preRev) {
    return leveraged
      ? { type: "distressed", stage: "distressed", label: "Distressed / speculative — judged on cash runway, financing & dilution risk, survival, and proof of operational recovery, not earnings." }
      : { type: "early-stage", stage: "pre-revenue", label: "Early-stage / pre-commercial company — current fundamentals are thin; judged on cash runway, milestones, partnerships, dilution risk & catalysts." };
  }

  // Operating company. TURNAROUND requires unprofitable AND leveraged (real debt burden) — not just
  // unprofitable (a cash-rich scaling name) and not just "down". Tech/software names get the softer
  // "pivot" framing (e.g. BB) rather than "distressed".
  const unprofitable = eps != null && eps <= 0;
  if (unprofitable && leveraged) {
    const tech = /technolog|software|infrastructure|internet|semiconduct/i.test([input.sector, input.industry].filter(Boolean).join(" ").toLowerCase());
    return tech
      ? { type: "turnaround", stage: "turnaround", label: "Software turnaround / pivot — judged on segment growth, margin recovery, recurring revenue & execution, not headline numbers." }
      : { type: "turnaround", stage: "turnaround", label: "Turnaround operating company — the thesis depends on the recovery converting to cash flow before debt and dilution pressure return." };
  }

  const scaling = growth != null && growth > 0.15;
  return scaling
    ? { type: "general", stage: "scaling", label: "Operating company (scaling) — judged on revenue growth, margins, cash generation, competitive position & valuation." }
    : { type: "general", stage: "mature", label: "Operating company — judged on revenue, margins, cash flow, balance sheet & valuation." };
}

// ─── Company Intelligence Memory ──────────────────────────────────────────────
// Per-ticker persistent intelligence layer stored in Supabase Storage.
// Accumulates SEC signals, risk flags, catalysts, X-Ray snapshots, and brief
// summaries across sessions. The Intel route reads this as background context
// so the AI hive mind never starts from zero on a known ticker.
//
// Storage: bucket "plainview-state" at _ticker_memory/{TICKER}.json
// TTLs are enforced at read time — stale fields are silently excluded.
// All writes are fire-and-forget (non-blocking). Reads fail open (return null).
// Memory is non-critical infrastructure — any failure is swallowed.

const MEM_BUCKET = "plainview-state";
const MEM_PREFIX = "_ticker_memory/";

/** Structure of per-ticker accumulated intelligence. */
export type TickerMemory = {
  ticker: string;
  // Company identity (90-day TTL)
  assetProfile: string | null;
  sector: string | null;
  industry: string | null;
  // Durable "what this company does" — a sourced fact, slow to change (180-day TTL). The single most
  // grounding line for abstract/obscure tickers when live data is thin. Persisted so NEXUS always
  // knows what it's reasoning about, even on a cold/empty fetch.
  businessSummary: string | null;
  businessUpdatedAt: string | null;
  // SEC filing signals (30-day TTL)
  secSignals: Array<SecSignal & { storedAt: string }>;
  secUpdatedAt: string | null;
  // Risk flags surfaced from SEC filings or AI analysis (14-day TTL)
  riskFlags: Array<{ flag: string; source: string; date: string }>;
  // Catalysts on record (14-day TTL)
  catalysts: Array<{ event: string; date: string | null; source: string }>;
  // X-Ray financial snapshot summary (24-hour TTL)
  xraySummary: string | null;
  xrayUpdatedAt: string | null;
  // Last Intel brief summary — context only, not evidence (6-hour TTL)
  briefSummary: string | null;
  briefUpdatedAt: string | null;
  // Last thesis-check verdict — AI output, labeled as such (24-hour TTL, same as X-Ray summary)
  lastVerdict: string | null;           // e.g. "supported", "mixed", "contradicted", "unsupported"
  lastVerdictSummary: string | null;    // one-line from the AI, capped
  lastVerdictAt: string | null;
  updatedAt: string;
};

function _memClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );
}

function _memKey(ticker: string): string {
  const clean = ticker.toUpperCase().replace(/[^A-Z0-9._-]/g, "");
  return MEM_PREFIX + clean + ".json";
}

/** Read stored intelligence for a ticker. Returns null if not found or on any error. */
export async function readTickerMemory(ticker: string): Promise<TickerMemory | null> {
  try {
    const { data, error } = await _memClient().storage.from(MEM_BUCKET).download(_memKey(ticker));
    if (error || !data) return null;
    return JSON.parse(await data.text()) as TickerMemory;
  } catch { return null; }
}

/** Merge a partial patch into stored ticker intelligence, respecting TTLs.
 *  Always fire-and-forget — call with void and don't await in hot paths. */
export async function writeTickerMemory(
  ticker: string,
  patch: Partial<Omit<TickerMemory, "ticker" | "updatedAt">>
): Promise<void> {
  try {
    const clean = ticker.toUpperCase().replace(/[^A-Z0-9._-]/g, "");
    const key = _memKey(ticker);
    const sb = _memClient();

    // Read existing record for merge
    let existing: TickerMemory | null = null;
    try {
      const { data } = await sb.storage.from(MEM_BUCKET).download(key);
      if (data) existing = JSON.parse(await data.text()) as TickerMemory;
    } catch { /* start fresh */ }

    const now = Date.now();
    const msDay = 24 * 60 * 60 * 1000;

    // Merge risk flags: incoming + existing within 14 days, deduplicated, capped at 10
    const incomingRisks = patch.riskFlags ?? [];
    const existingRisks = (existing?.riskFlags ?? []).filter(r => {
      const age = now - new Date(r.date).getTime();
      const dup = incomingRisks.some(p => p.flag.slice(0, 40) === r.flag.slice(0, 40));
      return age < 14 * msDay && !dup;
    });

    // Merge catalysts: incoming + existing within 14 days, deduplicated, capped at 8
    const incomingCats = patch.catalysts ?? [];
    const existingCats = (existing?.catalysts ?? []).filter(c => {
      const dateStr = c.date ?? c.source.slice(-10);
      const age = now - new Date(dateStr).getTime();
      const dup = incomingCats.some(p => p.event.slice(0, 30) === c.event.slice(0, 30));
      return age < 14 * msDay && !dup;
    });

    const merged: TickerMemory = {
      ticker: clean,
      assetProfile: patch.assetProfile !== undefined ? patch.assetProfile : (existing?.assetProfile ?? null),
      sector: patch.sector !== undefined ? patch.sector : (existing?.sector ?? null),
      industry: patch.industry !== undefined ? patch.industry : (existing?.industry ?? null),
      // Only overwrite a stored description with a non-empty new one — never wipe known facts on a thin fetch.
      businessSummary: (patch.businessSummary && patch.businessSummary.trim())
        ? patch.businessSummary.trim() : (existing?.businessSummary ?? null),
      businessUpdatedAt: (patch.businessSummary && patch.businessSummary.trim())
        ? new Date().toISOString() : (existing?.businessUpdatedAt ?? null),
      secSignals: patch.secSignals !== undefined ? patch.secSignals : (existing?.secSignals ?? []),
      secUpdatedAt: patch.secSignals !== undefined ? new Date().toISOString() : (existing?.secUpdatedAt ?? null),
      riskFlags: [...incomingRisks, ...existingRisks].slice(0, 10),
      catalysts: [...incomingCats, ...existingCats].slice(0, 8),
      xraySummary: patch.xraySummary !== undefined ? patch.xraySummary : (existing?.xraySummary ?? null),
      xrayUpdatedAt: patch.xraySummary !== undefined ? new Date().toISOString() : (existing?.xrayUpdatedAt ?? null),
      briefSummary: patch.briefSummary !== undefined ? patch.briefSummary : (existing?.briefSummary ?? null),
      briefUpdatedAt: patch.briefSummary !== undefined ? new Date().toISOString() : (existing?.briefUpdatedAt ?? null),
      lastVerdict: patch.lastVerdict !== undefined ? patch.lastVerdict : (existing?.lastVerdict ?? null),
      lastVerdictSummary: patch.lastVerdictSummary !== undefined ? patch.lastVerdictSummary : (existing?.lastVerdictSummary ?? null),
      lastVerdictAt: patch.lastVerdict !== undefined ? new Date().toISOString() : (existing?.lastVerdictAt ?? null),
      updatedAt: new Date().toISOString(),
    };

    const blob = new Blob([JSON.stringify(merged)], { type: "application/json" });
    await sb.storage.from(MEM_BUCKET).upload(key, blob, { upsert: true, contentType: "application/json" });
  } catch { /* fail open — memory is non-critical */ }
}

/** Format stored ticker memory as a context block for injection into the Intel brief.
 *  Only includes fields within their TTL. Labels summaries as summaries (not evidence)
 *  so the AI doesn't conflate prior opinions with the live data it also receives. */
export function buildMemoryContext(memory: TickerMemory): string | null {
  const now = Date.now();
  const age = (ts: string | null | undefined) => ts ? now - new Date(ts).getTime() : Infinity;
  const msDay = 24 * 60 * 60 * 1000;
  const lines: string[] = [];

  // Identity (90-day TTL)
  const parts: string[] = [];
  if (memory.assetProfile) parts.push(memory.assetProfile);
  if (memory.sector && memory.industry) parts.push(`${memory.sector} · ${memory.industry}`);
  else if (memory.sector) parts.push(memory.sector);
  if (parts.length) lines.push(`Company profile on record: ${parts.join(" | ")}`);

  // Durable business description (180-day TTL) — grounds reasoning on abstract/obscure tickers.
  if (memory.businessSummary && age(memory.businessUpdatedAt) < 180 * msDay) {
    lines.push(`What the company does (on record): ${memory.businessSummary.slice(0, 280)}`);
  }

  // SEC signals (30-day TTL)
  if (memory.secSignals?.length && age(memory.secUpdatedAt) < 30 * msDay) {
    lines.push("SEC filings on record (classify by substance, not type alone):");
    memory.secSignals.slice(0, 5).forEach(s => {
      const icon = s.signal === "bullish" ? "✅" : s.signal === "bearish" ? "🔴" : "⚠️";
      const itemTag = s.items ? ` [Item ${s.items}]` : "";
      lines.push(`  ${icon} ${s.form} (${s.date})${itemTag}: ${s.summary}`);
    });
  }

  // Risk flags (14-day TTL)
  const freshRisks = (memory.riskFlags ?? []).filter(r => age(r.date) < 14 * msDay);
  if (freshRisks.length) {
    lines.push("Risk flags from prior analysis:");
    freshRisks.slice(0, 4).forEach(r => lines.push(`  ⚠ ${r.flag} (source: ${r.source})`));
  }

  // Catalysts (14-day TTL)
  const freshCats = (memory.catalysts ?? []).filter(c => {
    const dateStr = c.date ?? c.source.slice(-10);
    return age(dateStr) < 14 * msDay;
  });
  if (freshCats.length) {
    lines.push("Catalysts on record:");
    freshCats.slice(0, 3).forEach(c => lines.push(`  📅 ${c.event}${c.date ? ` (${c.date})` : ""}`));
  }

  // X-Ray summary (24-hour TTL)
  if (memory.xraySummary && age(memory.xrayUpdatedAt) < msDay) {
    const ts = memory.xrayUpdatedAt ? new Date(memory.xrayUpdatedAt).toLocaleDateString() : "recently";
    lines.push(`Prior X-Ray snapshot (${ts}):\n  ${memory.xraySummary}`);
  }

  // Last thesis-check verdict (24-hour TTL) — AI judgment, labeled as such. Gives the next surface
  // awareness of how the thesis was graded ("contradicted → the thesis has a known problem"), but the
  // label is CONTEXT for the AI, not standalone evidence it can cite as fact.
  if (memory.lastVerdict && age(memory.lastVerdictAt) < msDay) {
    const line = `Last thesis-check verdict: ${memory.lastVerdict.toUpperCase()}`;
    lines.push(memory.lastVerdictSummary
      ? `${line} — ${memory.lastVerdictSummary.slice(0, 200)}`
      : line);
  }

  // NEXUS EVIDENCE HIERARCHY — AI output may be stored and referenced, but must NEVER become evidence.
  // The prior Intel brief (memory.briefSummary) is AI INTERPRETATION (Tier 3); feeding it back into the
  // next brief created a self-poisoning loop ("Plainview proving Plainview") — a fabricated figure
  // (TRX "58% Q3 2026") re-cited itself every run and refreshed its own TTL. It is deliberately NOT
  // injected here. Briefs must be built ONLY from live data + real signals (SEC/financials/news/price)
  // and derived facts (X-Ray) — never from a previous brief. (briefSummary is still stored for UI/history.)

  if (!lines.length) return null;
  return `[Plainview memory — ${memory.ticker}]\nAccumulated from prior research sessions. Facts carry source labels. Summaries are labeled as summaries. Live signals above always take precedence.\n\n${lines.join("\n")}`;
}

// ── Canonical signal bundle (NEXUS step 3, slice 1) ────────────────────────────────────────────
// ONE place that gathers every per-ticker fact, each tagged with its source and as-of date, so the
// research surfaces (thesis-check, intel, X-Ray) can all read the SAME truth instead of fetching
// independently — which let them disagree (e.g. TRX showed real Q2 results on one surface and a
// fabricated Q3 on another). This wraps the EXISTING fetchers with the same timeout caps the routes
// already use; it does NOT change how any individual datum is fetched. Wiring the routes onto this
// is a later, separately-verified slice — adding the function alone changes no live behaviour.
export type SignalProvenance = { source: string; asOf: string };
export type SignalBundle = {
  ticker: string;
  asOf: string; // ISO date the bundle was assembled
  profile: { sector: string | null; industry: string | null; name: string | null };
  description: string | null;
  financials: FinancialSnapshot;
  technicals: TechnicalData;
  xray: XrayResult | null;
  analyst: AnalystTargets;
  earnings: string | null;
  baseNews: string[];
  secFilings: string[];
  secSignals: SecSignal[]; // structured filings (form/signal/summary) — for the brief's material-change radar
  filingFacts: FilingFact[]; // structured DD from 10-K/10-Q (filing_insights table — tier-1)
  btc: number | null;
  // Per-signal provenance for the NEXUS judgment layer to cite sources and reconcile across surfaces.
  sources: Record<string, SignalProvenance>;
};

const SIGNAL_FINANCIAL_NULL: FinancialSnapshot = {
  totalCash: null, totalDebt: null, netCash: null, operatingCashflow: null, grossMargins: null, revenueGrowth: null,
};
const SIGNAL_TECHNICAL_NULL: TechnicalData = {
  ma50: null, ma200: null, week52High: null, week52Low: null, avgVolume: null, currentVolume: null,
  beta: null, shortPercentOfFloat: null, floatShares: null, shortShares: null, daysToCover: null,
  rsi: null, rsiSignal: null, ma50Slope: null, prevClose: null,
};
const SIGNAL_ANALYST_NULL: AnalystTargets = { mean: null, high: null, low: null, sources: 0 };

export type SignalField =
  | "xray" | "financials" | "technicals" | "description" | "news"
  | "secFilings" | "filingFacts" | "earnings" | "analyst" | "btc" | "profile";

export async function gatherSignals(
  ticker: string,
  opts?: { price?: number | null; name?: string | null; only?: SignalField[] }
): Promise<SignalBundle> {
  const price = opts?.price ?? null;
  // Field filter: a caller that needs only a subset (e.g. intel, which has its own news/SEC paths)
  // passes `only` so we skip the fetches it won't use — no wasted API calls, same shared logic.
  const want = opts?.only ? new Set<SignalField>(opts.only) : null;
  const need = (f: SignalField) => !want || want.has(f);
  // Same race-cap the routes already apply, so timeout behaviour is unchanged.
  const cap = <T>(p: Promise<T>, ms: number, fallback: T): Promise<T> =>
    Promise.race([p, new Promise<T>((r) => setTimeout(() => r(fallback), ms))]);
  const skip = <T>(fallback: T): Promise<T> => Promise.resolve(fallback);

  const [xray, financials, technicals, description, baseNews, secSignals, filingFacts, earnings, analyst, btc, profile] =
    await Promise.all([
      need("xray") ? cap(runXray(ticker), 4000, null) : skip(null),
      need("financials") ? cap(fetchFinancialSnapshot(ticker), 3000, SIGNAL_FINANCIAL_NULL) : skip(SIGNAL_FINANCIAL_NULL),
      need("technicals") ? cap(fetchTechnicalData(ticker), 3000, SIGNAL_TECHNICAL_NULL) : skip(SIGNAL_TECHNICAL_NULL),
      need("description") ? cap(fetchCompanyDescription(ticker).catch(() => null), 2500, null) : skip(null),
      need("news") ? cap(fetchNewsForTicker(ticker, opts?.name ?? null), 3000, [] as string[]) : skip([] as string[]),
      // Fetch the STRUCTURED signals once; the string lines are derived from them below (same single SEC
      // fetch → $0). The brief's material-change radar reads the structure (form/signal); the LLM reads the lines.
      need("secFilings") ? cap(fetchSecSignals(ticker), 3500, [] as SecSignal[]) : skip([] as SecSignal[]),
      // Filing Intelligence — structured DD facts from the most recent 10-K/10-Q (tier-1, $0 read from Supabase).
      (need("filingFacts") || need("secFilings")) ? cap(fetchFilingFacts(ticker), 2000, [] as FilingFact[]) : skip([] as FilingFact[]),
      need("earnings") ? cap(fetchEarningsDate(ticker), 2500, null) : skip(null),
      need("analyst") ? cap(fetchAnalystTarget(ticker, price), 3000, SIGNAL_ANALYST_NULL) : skip(SIGNAL_ANALYST_NULL),
      need("btc") ? cap(fetchBitcoinPrice(), 2500, null) : skip(null),
      need("profile")
        ? cap(
            fetchYahooProfile(ticker).catch(() => ({ sector: null, industry: null, name: null })),
            2500,
            { sector: null, industry: null, name: null }
          )
        : skip({ sector: null, industry: null, name: null }),
    ]);

  const asOf = new Date().toISOString().slice(0, 10);
  const secFilings = formatSecSignals(secSignals);
  return {
    ticker,
    asOf,
    profile,
    description,
    financials,
    technicals,
    xray,
    analyst,
    earnings,
    baseNews,
    secFilings,
    secSignals,
    filingFacts,
    btc,
    sources: {
      financials: { source: "Yahoo financials", asOf },
      technicals: { source: "Yahoo technicals", asOf },
      xray: { source: "SEC EDGAR + Yahoo", asOf },
      analyst: { source: "analyst consensus", asOf },
      earnings: { source: "Yahoo earnings calendar", asOf },
      news: { source: "Google News", asOf },
      secFilings: { source: "SEC EDGAR", asOf },
      profile: { source: "Yahoo profile", asOf },
      btc: { source: "live BTC spot", asOf },
    },
  };
}
