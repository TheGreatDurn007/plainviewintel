import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { fetchShortInterest, classifyMining, classifyBiotech, computeCashRunway, getAssetProfile, isCryptoTicker, isCommodityTicker, writeTickerMemory } from "@/lib/market-context";
import { computePreRevScore } from "@/lib/prerev-score";
import { logUsage } from "@/lib/usage-log";

export const maxDuration = 55;

// ─── Types ───────────────────────────────────────────────────────────────────

type SecFundamentals = {
  revenueTtm: number | null;
  revGrowth: number | null;
  grossMargin: number | null;
  totalCash: number | null;
  totalDebt: number | null;
  netCash: number | null;
  sharesOutstanding: number | null;
  opCashflow: number | null;
  eps: number | null;
  operatingEps: number | null; // from OperatingIncomeLoss — excludes warrant/derivative gains
  // Extended Yahoo key-statistics fields — populated when Yahoo fundamentals path runs
  roe?: number | null;
  roa?: number | null;
  freeCashflow?: number | null;
  insiderOwnership?: number | null;
  institutionalOwnership?: number | null;
  beta?: number | null;
  forwardPE?: number | null;
  pegRatio?: number | null;
  evToEbitda?: number | null;
  dividendYield?: number | null;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObj = Record<string, any>;

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function n(v: unknown): number | null {
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
}
// Yahoo Finance grossMargins is a decimal fraction (0.75 = 75%). Values outside -1..1
// indicate bad/stale API data — treat as null rather than displaying garbage like -503%.
function safeMargin(v: unknown): number | null {
  const x = n(v);
  return x !== null && x >= -1 && x <= 1 ? x : null;
}
function mny(v: number | null): string {
  if (v === null) return "n/a";
  if (Math.abs(v) >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (Math.abs(v) >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  return `$${v.toFixed(2)}`;
}
function mlt(v: number | null): string { return v !== null ? `${v.toFixed(1)}x` : "n/a"; }
function st(v: number | null, g: (x: number) => boolean, w: (x: number) => boolean): "good" | "watch" | "bad" {
  if (v === null) return "watch";
  return g(v) ? "good" : w(v) ? "watch" : "bad";
}

// ─── Supabase cache ───────────────────────────────────────────────────────────

function serviceSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );
}

// Bump to invalidate all cached SEC fundamentals at once (e.g. after fixing the
// ticker-collision bug that cached the wrong company's data for some .TO tickers).
const SEC_CACHE_VERSION = "v20"; // bumped: dividendYield + evToEbitda now carried through SEC→Yahoo merge

async function getCachedSec(symbol: string): Promise<SecFundamentals | null> {
  try {
    const { data } = await serviceSupabase()
      .from("xray_cache")
      .select("data, fetched_at")
      .eq("symbol", `${symbol}@${SEC_CACHE_VERSION}`)
      .single();
    if (!data) return null;
    if (Date.now() - new Date(data.fetched_at).getTime() > CACHE_TTL_MS) return null;
    return data.data as SecFundamentals;
  } catch { return null; }
}

async function setCachedSec(symbol: string, sec: SecFundamentals): Promise<void> {
  try {
    await serviceSupabase()
      .from("xray_cache")
      .upsert({ symbol: `${symbol}@${SEC_CACHE_VERSION}`, data: sec, fetched_at: new Date().toISOString() });
  } catch { /* non-critical */ }
}

// ─── Finnhub: Earnings History + Forward Estimates ──────────────────────────

type EarningsQuarter = { period: string; actual: number | null; estimate: number | null; surprise: number | null; surprisePercent: number | null };
type EarningsHistoryResult = { quarters: EarningsQuarter[]; beats: number; total: number; avgSurprise: number | null };
type ForwardEstimatesResult = { nextQEps: number | null; fyRevenue: number | null; epsRevisionUp: boolean | null };

async function fetchEarningsHistory(symbol: string): Promise<EarningsHistoryResult | null> {
  const key = process.env.FINNHUB_API_KEY; if (!key) return null;
  const sym = symbol.replace(/\.(TO|V|CN|NE)$/i, "");
  try {
    const res = await fetch(`https://finnhub.io/api/v1/stock/earnings?symbol=${sym}&token=${key}`, { next: { revalidate: 43200 } });
    if (!res.ok) return null;
    const data = await res.json() as Array<{ period?: string; actual?: number; estimate?: number; surprise?: number; surprisePercent?: number }>;
    if (!Array.isArray(data) || data.length === 0) return null;
    const quarters: EarningsQuarter[] = data.map(d => ({
      period: d.period ?? "",
      actual: d.actual != null && Number.isFinite(d.actual) ? d.actual : null,
      estimate: d.estimate != null && Number.isFinite(d.estimate) ? d.estimate : null,
      surprise: d.surprise != null && Number.isFinite(d.surprise) ? d.surprise : null,
      surprisePercent: d.surprisePercent != null && Number.isFinite(d.surprisePercent) ? d.surprisePercent : null,
    }));
    let beats = 0;
    for (const q of quarters) { if (q.actual != null && q.estimate != null && q.actual > q.estimate) beats++; }
    const total = quarters.filter(q => q.actual != null && q.estimate != null).length;
    const surprises = quarters.map(q => q.surprisePercent).filter((v): v is number => v != null);
    const avgSurprise = surprises.length > 0 ? surprises.reduce((a, b) => a + b, 0) / surprises.length : null;
    return { quarters, beats, total, avgSurprise };
  } catch { return null; }
}

async function fetchForwardEstimates(symbol: string): Promise<ForwardEstimatesResult | null> {
  const key = process.env.FINNHUB_API_KEY; if (!key) return null;
  const sym = symbol.replace(/\.(TO|V|CN|NE)$/i, "");
  try {
    const [epsRes, revRes] = await Promise.all([
      fetch(`https://finnhub.io/api/v1/stock/eps-estimate?symbol=${sym}&freq=quarterly&token=${key}`, { next: { revalidate: 43200 } }),
      fetch(`https://finnhub.io/api/v1/stock/revenue-estimate?symbol=${sym}&freq=annual&token=${key}`, { next: { revalidate: 43200 } }),
    ]);
    let nextQEps: number | null = null;
    let epsRevisionUp: boolean | null = null;
    if (epsRes.ok) {
      const epsData = await epsRes.json();
      const est = Array.isArray(epsData?.data) ? epsData.data[0] : null;
      if (est) {
        nextQEps = est.epsAvg != null && Number.isFinite(est.epsAvg) ? est.epsAvg : null;
        // Compare 90-day-ago estimate to current to determine revision direction
        if (est.epsAvg != null && est.numberAnalysts != null) {
          const prev = est.epsAvg90dAgo ?? est.epsAvg60dAgo ?? est.epsAvg30dAgo ?? null;
          if (prev != null && Number.isFinite(prev)) epsRevisionUp = est.epsAvg > prev;
        }
      }
    }
    let fyRevenue: number | null = null;
    if (revRes.ok) {
      const revData = await revRes.json();
      const est = Array.isArray(revData?.data) ? revData.data[0] : null;
      if (est && est.revenueAvg != null && Number.isFinite(est.revenueAvg)) {
        fyRevenue = est.revenueAvg;
      }
    }
    if (nextQEps == null && fyRevenue == null) return null;
    return { nextQEps, fyRevenue, epsRevisionUp };
  } catch { return null; }
}

// ─── Yahoo v7/quote (server-side) ────────────────────────────────────────────

const YF_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36 Plainview/1.0",
  Accept: "application/json,text/plain,*/*",
};

async function fetchV7Quote(symbol: string): Promise<AnyObj | null> {
  for (const host of ["query1", "query2"]) {
    try {
      const res = await fetch(
        `https://${host}.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(symbol)}`,
        { headers: YF_HEADERS, next: { revalidate: 30 } } // price + day change — short shared cache
      );
      if (!res.ok) continue;
      const json = await res.json();
      const q = json?.quoteResponse?.result?.[0];
      if (q?.regularMarketPrice) return q;
    } catch { continue; }
  }
  // Fallback: v8/chart for price only
  try {
    const res = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1d`,
      { headers: YF_HEADERS, next: { revalidate: 30 } } // price fallback — short shared cache
    );
    if (res.ok) {
      const json = await res.json();
      const meta = json?.chart?.result?.[0]?.meta;
      if (meta?.regularMarketPrice) {
        // Derive day-change % from previous close (v8/chart doesn't carry regularMarketChangePercent directly).
        const prev = meta.previousClose ?? meta.chartPreviousClose;
        const changePct = (prev && Number.isFinite(prev) && prev > 0)
          ? (meta.regularMarketPrice - prev) / prev * 100 : undefined;
        return {
          regularMarketPrice: meta.regularMarketPrice,
          regularMarketChangePercent: changePct,
          regularMarketTime: meta.regularMarketTime,
          longName: meta.longName || meta.shortName || symbol,
          shortName: meta.shortName || symbol,
        };
      }
    }
  } catch { /* ignore */ }
  return null;
}

// Transform v7 flat quote + SEC fundamentals into v10/quoteSummary nested format
// so enrichXrayScan can compute all valuation cells (P/S, cash per share, runway, etc.)
function buildSummary(q: AnyObj | null, sec: SecFundamentals | null): AnyObj {
  const raw = (v: unknown) => { const x = Number(v); return Number.isFinite(x) && x !== 0 ? { raw: x } : null; };
  const ps = q ? Number(q.priceToSalesTrailing12Months) : NaN;
  const mc = q ? Number(q.marketCap) : NaN;
  const derivedRevenue = ps > 0 && mc > 0 ? mc / ps : null;
  return {
    financialData: {
      targetMeanPrice: raw(q?.targetMeanPrice),
      currentPrice: raw(q?.regularMarketPrice),
      // SEC data fills in the fields v7/quote doesn't have
      totalRevenue: sec?.revenueTtm ? { raw: sec.revenueTtm } : (derivedRevenue ? { raw: derivedRevenue } : null),
      grossMargins: sec?.grossMargin ? { raw: sec.grossMargin } : null,
      operatingCashflow: sec?.opCashflow != null ? { raw: sec.opCashflow } : null,
      totalCash: sec?.totalCash != null ? { raw: sec.totalCash } : null,
      totalDebt: sec?.totalDebt != null ? { raw: sec.totalDebt } : null,
      revenueGrowth: sec?.revGrowth != null ? { raw: sec.revGrowth } : null,
    },
    defaultKeyStatistics: {
      trailingEps: sec?.eps != null ? { raw: sec.eps } : raw(q?.epsTrailingTwelveMonths),
      sharesOutstanding: sec?.sharesOutstanding != null ? { raw: sec.sharesOutstanding } : raw(q?.sharesOutstanding),
      enterpriseValue: raw(q?.enterpriseValue),
      enterpriseToEbitda: raw(q?.enterpriseToEbitda),
    },
    summaryDetail: {
      marketCap: raw(q?.marketCap),
      priceToSalesTrailing12Months: raw(q?.priceToSalesTrailing12Months),
    },
    price: {
      regularMarketPrice: raw(q?.regularMarketPrice),
      longName: q?.longName || q?.shortName || null,
      shortName: q?.shortName || null,
    },
  };
}

// ─── SEC per-concept API (small parallel files, not the huge companyfacts.json) ─

type ConceptRow = { val: number; fp?: string; form?: string; end?: string; start?: string };

// 6-K = foreign private issuer quarterly report (NBIS, Nebius, Canadian ADRs, etc.)
const ALLOWED_FORMS = new Set(["10-Q", "10-K", "20-F", "40-F", "6-K"]);

function filterRows(rows: ConceptRow[]): ConceptRow[] {
  return rows
    .filter(r => Number.isFinite(r.val) && r.form && ALLOWED_FORMS.has(r.form))
    .sort((a, b) => String(b.end || "").localeCompare(String(a.end || "")));
}

function quarterlyRows(rows: ConceptRow[]): ConceptRow[] {
  const q = filterRows(rows).filter(r => {
    if (r.start && r.end) {
      const days = (Date.parse(r.end) - Date.parse(r.start)) / 86400000;
      // Slightly wider range (60-125) for foreign filers whose periods don't align exactly
      return days >= 60 && days <= 125;
    }
    return r.fp && r.fp !== "FY";
  });
  // Dedupe by period-end: the SAME quarter is re-reported in every later filing, so without this the
  // "4 most recent" can be 2 quarters listed twice → a wrong TTM (and a revenue/gross-profit mismatch
  // that zeroed gross margin). filterRows already sorted by end desc, so the first per end wins.
  const seen = new Set<string>();
  const out: ConceptRow[] = [];
  for (const r of q) { const key = r.end || ""; if (key && !seen.has(key)) { seen.add(key); out.push(r); } }
  return out;
}

// Pick the concept whose data is FRESHEST — companies switch XBRL tags over time, freezing the old one
// (NVDA's RevenueFromContract... dead-ends in 2020 while current revenue lives in Revenues). Selecting
// the first non-empty concept would sum stale years; this picks the one with the latest period-end.
function freshestConcept(...candidates: (ConceptRow[] | undefined)[]): ConceptRow[] {
  const present = candidates.filter((a): a is ConceptRow[] => !!a && a.length > 0);
  if (!present.length) return [];
  return present.sort((a, b) => (filterRows(b)[0]?.end || "").localeCompare(filterRows(a)[0]?.end || ""))[0];
}

function annualRow(rows: ConceptRow[]): ConceptRow | undefined {
  return filterRows(rows).find(r => r.fp === "FY" || r.form === "10-K");
}

function ttm(qRows: ConceptRow[], fallback: ConceptRow | undefined): number | null {
  const q = qRows.slice(0, 4);
  if (q.length >= 4) return q.reduce((s, r) => s + r.val, 0);
  return fallback?.val ?? null;
}

async function fetchSecFundamentals(symbol: string, expectedName?: string | null): Promise<SecFundamentals | null> {
  // Step 1: Get CIK from SEC company tickers (shared file, CDN-cached)
  const secHeaders = { "User-Agent": "Plainview investing tool plainview@dar-fishman.com", Accept: "application/json" };
  const tickerRes = await fetch("https://www.sec.gov/files/company_tickers.json", {
    headers: secHeaders,
    next: { revalidate: 3600 },
  });
  if (!tickerRes.ok) return null;
  const tickers = await tickerRes.json() as Record<string, { cik_str: number; ticker: string; title?: string }>;
  const clean = symbol.replace(/\..*$/, "");
  const row = Object.values(tickers).find(t => t.ticker.toUpperCase() === clean);
  if (!row) return null;
  // ACCURACY GUARD: a Canadian/foreign ticker stripped of its suffix can collide with a
  // DIFFERENT U.S. company that shares the bare symbol (e.g. L.TO=Loblaw vs U.S. L=Loews,
  // AC.TO=Air Canada vs U.S. AC=Associated Capital). Pulling that company's SEC financials
  // would show the WRONG numbers. So for suffixed tickers, require the SEC filer's name to
  // share a distinctive word with the real company name; otherwise treat as no SEC data.
  // U.S. (unsuffixed) tickers are authoritative — skip the check (zero change for them).
  if (/\.(TO|V|CN|NE|TSX)$/i.test(symbol) && expectedName) {
    const norm = (s: string) => s.toLowerCase()
      .replace(/[.,&]/g, " ")
      .replace(/\b(inc|corp|corporation|ltd|limited|plc|holdings?|company|companies|co|group|the|of|sa|nv|ag|llc|lp|trust|fund)\b/g, " ")
      .split(/\s+/).filter(w => w.length >= 4);
    const want = new Set(norm(expectedName));
    const got = norm(String(row.title || ""));
    if (!got.some(w => want.has(w))) return null; // ticker collided with a different company
  }
  const cik = String(row.cik_str).padStart(10, "0");

  // LAYER 2 OPTIMIZATION: one companyfacts call replaces ~30 individual companyconcept calls.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let facts: any = null;
  try {
    const res = await fetch(`https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`, {
      headers: secHeaders,
      next: { revalidate: 43200 },
    });
    if (res.ok) facts = await res.json();
  } catch { /* fall through — facts stays null */ }
  if (!facts) return null;

  const usGaap = facts?.facts?.["us-gaap"] ?? {};
  const ifrs = facts?.facts?.["ifrs-full"] ?? {};

  const extractRows = (taxonomy: Record<string, unknown>, concept: string): ConceptRow[] => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const entry = taxonomy[concept] as any;
    if (!entry?.units) return [];
    return [
      ...(entry.units.USD ?? []),
      ...(entry.units.shares ?? []),
      ...(entry.units.CAD ?? []),
    ] as ConceptRow[];
  };

  const neededUsGaap = [
    "RevenueFromContractWithCustomerExcludingAssessedTax",
    "Revenues", "SalesRevenueNet", "GrossProfit",
    "CostOfRevenue", "CostOfGoodsAndServicesSold", "CostOfGoodsSold",
    "OperatingIncomeLoss",
    "CashAndCashEquivalentsAtCarryingValue",
    "CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents",
    "ShortTermInvestments", "MarketableSecuritiesCurrent",
    "AvailableForSaleSecuritiesDebtSecuritiesCurrent", "AvailableForSaleSecuritiesCurrent",
    "DebtSecuritiesAvailableForSaleExcludingAccruedInterestCurrent",
    "MarketableSecuritiesNoncurrent", "AvailableForSaleSecuritiesDebtSecuritiesNoncurrent", "LongTermInvestments",
    "DebtSecuritiesAvailableForSaleExcludingAccruedInterestNoncurrent",
    "EquitySecuritiesFvNiNoncurrent", "OtherLongTermInvestments",
    "InvestmentsAndOtherNoncurrentAssets",
    "LongTermDebtNoncurrent", "LongTermDebt", "ShortTermBorrowings",
    "EntityCommonStockSharesOutstanding",
    "WeightedAverageNumberOfSharesOutstandingBasic",
    "NetCashProvidedByUsedInOperatingActivities", "NetIncomeLoss",
  ];
  const neededIfrs = [
    "Revenue", "GrossProfit", "CostOfSales",
    "CashAndCashEquivalents",
    "Borrowings", "CurrentBorrowings", "NoncurrentBorrowings",
    "OrdinarySharesNumber",
    "CashFlowsFromUsedInOperatingActivities",
    "ProfitLoss",
  ];

  const d: Record<string, ConceptRow[]> = {};
  for (const c of neededUsGaap) d[c] = extractRows(usGaap, c);
  for (const c of neededIfrs) d[c] = extractRows(ifrs, c);

  // Step 3: Compute fundamentals
  // Freshest revenue concept — NVDA's RevenueFromContract... freezes at 2020 ($10.9B TTM), current
  // revenue is under Revenues ($130B+). Pick whichever has the most recent data, never just the first.
  const revRows = freshestConcept(
    d["RevenueFromContractWithCustomerExcludingAssessedTax"],
    d["Revenues"],
    d["SalesRevenueNet"],
    d["Revenue"], // IFRS
  );

  const revQ = quarterlyRows(revRows);
  const revAnnual = annualRow(revRows);
  const revenueTtm = ttm(revQ, revAnnual);
  const revGrowth = revQ.length >= 4 && revQ[3].val > 0
    ? (revQ[0].val - revQ[3].val) / revQ[3].val
    : null;

  // Gross profit (US GAAP or IFRS GrossProfit) — freshest in case of a tag switch.
  const gpRows = freshestConcept(d["GrossProfit"]);
  const gpQ = quarterlyRows(gpRows); const gpAnnual = annualRow(gpRows);
  const gpTtm = ttm(gpQ, gpAnnual);
  // Cost of sales — pick the freshest among all the tags filers use (product cos often use
  // CostOfGoodsAndServicesSold; AAPL has no CostOfRevenue at all), then IFRS CostOfSales.
  const costRows = freshestConcept(
    d["CostOfRevenue"], d["CostOfGoodsAndServicesSold"], d["CostOfGoodsSold"], d["CostOfSales"],
  );
  const costQ = quarterlyRows(costRows); const costAnnual = annualRow(costRows);
  const costTtm = ttm(costQ, costAnnual);
  const grossMargin = revenueTtm
    ? gpTtm != null ? gpTtm / revenueTtm
      : costTtm != null ? (revenueTtm - costTtm) / revenueTtm
      : null
    : null;

  // Cash (US GAAP or IFRS CashAndCashEquivalents; include CAD units for Canadian filers)
  const cashAll = [
    ...filterRows(d["CashAndCashEquivalentsAtCarryingValue"] ?? []),
    ...filterRows(d["CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents"] ?? []),
    ...filterRows(d["CashAndCashEquivalents"] ?? []),  // IFRS
  ].sort((a, b) => String(b.end || "").localeCompare(String(a.end || "")));
  const cashRow = cashAll[0] ?? null;
  // Add short-term/marketable investments from the SAME period-end (don't mix quarters). A company
  // uses one tag, so take the first concept that has a value for that period — no double-counting.
  let shortTermInv = 0;
  if (cashRow) {
    for (const c of ["ShortTermInvestments", "MarketableSecuritiesCurrent", "AvailableForSaleSecuritiesDebtSecuritiesCurrent", "AvailableForSaleSecuritiesCurrent", "DebtSecuritiesAvailableForSaleExcludingAccruedInterestCurrent"]) {
      const m = filterRows(d[c] ?? []).find((r) => r.end === cashRow.end);
      if (m && Number.isFinite(m.val)) { shortTermInv = m.val; break; }
    }
  }
  // Long-term marketable securities from the SAME period-end — cash-rich names hold most liquidity here.
  let longTermInv = 0;
  if (cashRow) {
    for (const c of ["MarketableSecuritiesNoncurrent", "AvailableForSaleSecuritiesDebtSecuritiesNoncurrent", "LongTermInvestments", "DebtSecuritiesAvailableForSaleExcludingAccruedInterestNoncurrent", "EquitySecuritiesFvNiNoncurrent", "OtherLongTermInvestments", "InvestmentsAndOtherNoncurrentAssets"]) {
      const m = filterRows(d[c] ?? []).find((r) => r.end === cashRow.end);
      if (m && Number.isFinite(m.val)) { longTermInv = m.val; break; }
    }
  }
  const totalCash = cashRow?.val != null ? cashRow.val + shortTermInv + longTermInv : null;

  // Debt (US GAAP or IFRS Borrowings)
  const ltDebt = filterRows(d["LongTermDebtNoncurrent"] ?? []).length
    ? filterRows(d["LongTermDebtNoncurrent"] ?? [])[0].val
    : filterRows(d["LongTermDebt"] ?? []).length ? filterRows(d["LongTermDebt"] ?? [])[0].val
    : filterRows(d["NoncurrentBorrowings"] ?? []).length ? filterRows(d["NoncurrentBorrowings"] ?? [])[0].val
    : filterRows(d["Borrowings"] ?? [])[0]?.val ?? 0;
  const stDebt = (filterRows(d["ShortTermBorrowings"] ?? [])[0]?.val ?? 0)
              + (filterRows(d["CurrentBorrowings"] ?? [])[0]?.val ?? 0);
  const totalDebt = ltDebt + stDebt;
  const netCash = totalCash != null ? totalCash - totalDebt : null;

  // Shares outstanding — cover-page count is the most authoritative for total shares.
  // CommonStockSharesOutstanding (balance sheet) is excluded: for companies with multiple
  // share classes or conversion events (e.g. AMC APE→common), it only captures ONE class
  // and produces a wildly wrong count. EntityCommonStockSharesOutstanding is the cover-page
  // manual disclosure of total outstanding shares — it reflects all conversions.
  // WeightedAverageNumberOfDilutedSharesOutstanding is also excluded — it inflates with
  // in-the-money options and convertible notes (Yahoo Finance's ~754M mistake for AMC).
  const shareRows =
    filterRows(d["EntityCommonStockSharesOutstanding"] ?? []).length
      ? filterRows(d["EntityCommonStockSharesOutstanding"] ?? [])
    : filterRows(d["WeightedAverageNumberOfSharesOutstandingBasic"] ?? []).length
      ? filterRows(d["WeightedAverageNumberOfSharesOutstandingBasic"] ?? [])
    : filterRows(d["OrdinarySharesNumber"] ?? []);
  const sharesOutstanding = shareRows[0]?.val ?? null;

  // Operating cash flow (US GAAP or IFRS)
  const opCFAll = [
    ...filterRows(d["NetCashProvidedByUsedInOperatingActivities"] ?? []),
    ...filterRows(d["CashFlowsFromUsedInOperatingActivities"] ?? []),
  ].sort((a, b) => String(b.end || "").localeCompare(String(a.end || "")));
  const opCashflow = opCFAll.find(r => r.fp === "FY" || r.form === "10-K" || r.form === "20-F" || r.form === "40-F")?.val
    ?? ttm(quarterlyRows(opCFAll), undefined);

  // Net income (US GAAP NetIncomeLoss or IFRS ProfitLoss)
  const niRows = d["NetIncomeLoss"]?.length ? d["NetIncomeLoss"] : (d["ProfitLoss"] ?? []);
  const niQ = quarterlyRows(niRows); const niAnnual = annualRow(niRows);
  const netIncomeTtm = ttm(niQ, niAnnual);
  const eps = netIncomeTtm != null && sharesOutstanding ? netIncomeTtm / sharesOutstanding : null;

  // Operating income — excludes non-cash warrant/derivative fair-value adjustments.
  // Used as a fallback EPS source when net income is contaminated by one-time non-operating gains.
  const opIncRows = filterRows(d["OperatingIncomeLoss"] ?? []);
  const opIncTtm = ttm(quarterlyRows(opIncRows), annualRow(opIncRows));
  const operatingEps = opIncTtm != null && sharesOutstanding ? opIncTtm / sharesOutstanding : null;

  if (!revenueTtm && eps === null && totalCash === null) return null;

  return { revenueTtm, revGrowth, grossMargin, totalCash, totalDebt, netCash, sharesOutstanding, opCashflow, eps, operatingEps };
}

// ─── Alpha Vantage fundamentals fallback (server-side key) ─────────────────
// Used when both SEC EDGAR and Yahoo Finance have no data (TSX-V, OTC, etc.)
// Key comes from ALPHA_VANTAGE_API_KEY env var — shared for all users

/**
 * Use Yahoo Finance search to find the US OTC equivalent of a Canadian ticker.
 * Validates name similarity to avoid returning the wrong company.
 */
async function findYahooOtcTicker(companyName: string, originalSymbol: string): Promise<string | null> {
  if (!companyName) return null;
  const YF_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36 Plainview/1.0",
    Accept: "application/json,text/plain,*/*",
  };
  try {
    const query = companyName.replace(/\s+(Inc\.?|Corp\.?|Ltd\.?|Limited|Corporation|Co\.?)$/i, "").trim();
    for (const host of ["query1", "query2"]) {
      const res = await fetch(
        `https://${host}.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(query)}&quotesCount=8&newsCount=0&lang=en-US&region=US`,
        { headers: YF_HEADERS, next: { revalidate: 86400 } }
      );
      if (!res.ok) continue;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const data: any = await res.json();
      const quotes: Record<string, string>[] = data?.quotes || [];
      const base = originalSymbol.replace(/\.(TO|V|CN|NE)$/i, "").toUpperCase();
      // Name similarity check — at least 2 words in common (prevents wrong-company matches)
      const origWords = new Set(query.toLowerCase().split(/\s+/).filter(w => w.length > 2));
      const otcMatch = quotes.find(q => {
        if (q.symbol === originalSymbol) return false;           // skip the Canadian ticker itself
        if (q.symbol === base) return false;                     // skip bare base
        if (q.symbol?.includes(".")) return false;              // OTC tickers have no dots
        if (q.typeDisp !== "Equity") return false;
        const exchDisp = (q.exchDisp || q.exchange || "").toLowerCase();
        if (!exchDisp.includes("otc") && !exchDisp.includes("pink") && !exchDisp.includes("other")) return false;
        // Name similarity — require 2+ matching meaningful words
        const nameWords = (q.shortname || q.longname || "").toLowerCase().split(/\s+/).filter((w: string) => w.length > 2);
        const overlap = nameWords.filter((w: string) => origWords.has(w)).length;
        return overlap >= 2;
      });
      if (otcMatch?.symbol) return otcMatch.symbol;
    }
  } catch { /* silent */ }
  return null;
}

async function fetchAlphaFundamentals(symbol: string, companyName?: string): Promise<SecFundamentals | null> {
  const apiKey = process.env.ALPHA_VANTAGE_API_KEY;
  if (!apiKey) return null;

  const fetchOverview = async (sym: string) => {
    const res = await fetch(
      `https://www.alphavantage.co/query?function=OVERVIEW&symbol=${encodeURIComponent(sym)}&apikey=${apiKey}`,
      { next: { revalidate: 3600 } }
    );
    if (!res.ok) return null;
    return res.json();
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const parseOverview = (d: any): SecFundamentals | null => {
    if (!d || d.Note || d.Information || d["Error Message"] || !d.Symbol) return null;
    const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) && n !== 0 ? n : null; };
    const revenueTtm  = num(d.RevenueTTM);
    const grossProfit = num(d.GrossProfitTTM);
    const grossMargin = revenueTtm && grossProfit ? grossProfit / revenueTtm : null;
    const eps         = num(d.EPS);
    const sharesOutstanding = num(d.SharesOutstanding);
    const revGrowth   = num(d.QuarterlyRevenueGrowthYOY);
    if (!revenueTtm && eps === null && !sharesOutstanding) return null;
    return { revenueTtm, revGrowth, grossMargin, totalCash: null, totalDebt: null, netCash: null, sharesOutstanding, opCashflow: null, eps, operatingEps: null };
  };

  // Try the Canadian ticker variants directly
  const base = symbol.replace(/\.(TO|V|CN|NE)$/i, "");
  const candidates = symbol.includes(".") ? [base, symbol] : [symbol, `${symbol}.TRV`, `${symbol}.TSX`];
  for (const sym of candidates) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const d: any = await fetchOverview(sym);
      const result = parseOverview(d);
      if (result) return result;
    } catch { continue; }
  }

  return null;
}

// ─── Yahoo crumb (session auth for quoteSummary) ─────────────────────────────
// Yahoo Finance requires a crumb + session cookie for authenticated API calls.
// We fetch once per serverless instance lifetime and reuse. Falls back gracefully
// if Yahoo blocks the request — callers continue without crumb (partial data).
let _yahooCrumb: { crumb: string; cookie: string; at: number } | null = null;

async function getYahooCrumb(): Promise<{ crumb: string; cookie: string } | null> {
  if (_yahooCrumb && Date.now() - _yahooCrumb.at < 3_600_000) {
    return { crumb: _yahooCrumb.crumb, cookie: _yahooCrumb.cookie };
  }
  try {
    const ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36";
    // Step 1: get session cookie from Yahoo Finance
    const initRes = await fetch("https://finance.yahoo.com/", {
      headers: { "User-Agent": ua, Accept: "text/html" },
      redirect: "follow",
      cache: "no-store",
    });
    const rawCookie = initRes.headers.get("set-cookie") ?? "";
    // Extract only the essential cookie values (A3, session)
    const cookie = rawCookie.split(",").map(s => s.split(";")[0].trim()).filter(Boolean).join("; ");
    // Step 2: exchange cookie for crumb
    const crumbRes = await fetch("https://query1.finance.yahoo.com/v1/test/getcrumb", {
      headers: { "User-Agent": ua, Accept: "*/*", Cookie: cookie },
      cache: "no-store",
    });
    if (!crumbRes.ok) return null;
    const crumb = (await crumbRes.text()).trim();
    if (!crumb || crumb.length > 60 || crumb.startsWith("{")) return null;
    _yahooCrumb = { crumb, cookie, at: Date.now() };
    return { crumb, cookie };
  } catch { return null; }
}

// ─── Yahoo Finance fundamentals (Canadian / OTC / international + US enrichment) ──

async function fetchYahooFundamentals(symbol: string): Promise<SecFundamentals | null> {
  const ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36 Plainview/1.0";
  const auth = await getYahooCrumb().catch(() => null);
  const headers: Record<string, string> = {
    "User-Agent": ua,
    Accept: "application/json,text/plain,*/*",
    ...(auth?.cookie ? { Cookie: auth.cookie } : {}),
  };

  // Try financialData first (fast, works for large-caps), then fall back to
  // statement history modules which work for Canadian/OTC/international stocks
  const moduleSets = [
    "financialData,defaultKeyStatistics,summaryDetail,incomeStatementHistory,incomeStatementHistoryQuarterly",
    "incomeStatementHistory,balanceSheetHistory,cashflowStatementHistory,defaultKeyStatistics,summaryDetail",
  ];

  for (const modules of moduleSets) {
    for (const host of ["query1", "query2"]) {
      try {
        const crumbParam = auth?.crumb ? `&crumb=${encodeURIComponent(auth.crumb)}` : "";
        const res = await fetch(
          `https://${host}.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=${modules}${crumbParam}`,
          { headers, next: { revalidate: 3600 } }
        );
        if (!res.ok) continue;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const json = await res.json() as any;
        const r = json?.quoteSummary?.result?.[0];
        if (!r) continue;

        // Path 1: financialData module
        const fd = r.financialData || {};
        const ks = r.defaultKeyStatistics || {};
        let revenueTtm  = n(fd.totalRevenue?.raw);
        let revGrowth   = n(fd.revenueGrowth?.raw);
        let grossMargin = safeMargin(fd.grossMargins?.raw);
        let totalCash   = n(fd.totalCash?.raw);
        let totalDebt   = n(fd.totalDebt?.raw);
        let opCashflow  = n(fd.operatingCashflow?.raw);
        // Take the maximum of all available share counts — impliedSharesOutstanding captures
        // all share classes and conversions; sharesOutstanding is basic only. Max = most complete.
        const sharesOutstanding = [
          n(ks.sharesOutstanding?.raw),
          n(ks.impliedSharesOutstanding?.raw),
        ].filter((v): v is number => v !== null && v > 0)
         .reduce((a, b) => Math.max(a, b), 0) || null;
        const eps = n(ks.trailingEps?.raw);
        const roe = n(fd.returnOnEquity?.raw);
        const roa = n(fd.returnOnAssets?.raw);
        const freeCashflow = n(fd.freeCashflow?.raw);
        const insiderOwnership = n(ks.heldPercentInsiders?.raw);
        const institutionalOwnership = n(ks.heldPercentInstitutions?.raw);
        const beta = n(ks.beta?.raw) ?? n(ks.beta);
        const forwardPE = n(ks.forwardPE?.raw);
        const pegRatio = n(ks.pegRatio?.raw);
        const evToEbitda = n(ks.enterpriseToEbitda?.raw);
        const sd = r.summaryDetail || {};
        const yahDividendYield = n(sd.dividendYield?.raw) ?? n(sd.trailingAnnualDividendYield?.raw);

        // Derive TTM revenue by summing 4 most recent quarters (more accurate than
        // Yahoo's pre-computed totalRevenue which can be stale for large-caps like NVDA)
        const qtrStmts: AnyObj[] = r.incomeStatementHistoryQuarterly?.incomeStatementHistory ?? [];
        if (qtrStmts.length >= 4) {
          const ttmFromQtrs = qtrStmts.slice(0, 4).reduce((sum, q) => sum + (n(q.totalRevenue?.raw) ?? 0), 0);
          const ttmGrossProfit = qtrStmts.slice(0, 4).reduce((sum, q) => sum + (n(q.grossProfit?.raw) ?? 0), 0);
          if (ttmFromQtrs > 0) {
            // Only override if quarterly sum is meaningfully different (>20% gap = stale pre-computed value)
            if (!revenueTtm || Math.abs(ttmFromQtrs - revenueTtm) / ttmFromQtrs > 0.2) {
              revenueTtm = ttmFromQtrs;
            }
            if (grossMargin === null && ttmGrossProfit !== 0) {
              grossMargin = ttmGrossProfit / ttmFromQtrs;
            }
          }
        }

        // Path 2: statement history (more reliable for non-US stocks)
        if (!revenueTtm) {
          const incStmts: AnyObj[] = r.incomeStatementHistory?.incomeStatementHistory ?? [];
          if (incStmts.length >= 1) {
            const latest = incStmts[0];
            revenueTtm  = n(latest.totalRevenue?.raw);
            grossMargin = revenueTtm && n(latest.grossProfit?.raw)
              ? (n(latest.grossProfit?.raw) ?? 0) / revenueTtm : grossMargin;
            // YoY growth from first vs second statement
            if (incStmts.length >= 2 && revenueTtm && n(incStmts[1].totalRevenue?.raw)) {
              const prev = n(incStmts[1].totalRevenue?.raw)!;
              revGrowth = prev > 0 ? (revenueTtm - prev) / prev : null;
            }
          }
          const bsStmts: AnyObj[] = r.balanceSheetHistory?.balanceSheetStatements ?? [];
          if (bsStmts.length >= 1) {
            const bs = bsStmts[0];
            totalCash = n(bs.cash?.raw) ?? n(bs.cashAndCashEquivalents?.raw);
            totalDebt = n(bs.longTermDebt?.raw) ?? n(bs.shortLongTermDebt?.raw);
          }
          const cfStmts: AnyObj[] = r.cashflowStatementHistory?.cashflowStatements ?? [];
          if (cfStmts.length >= 1) {
            opCashflow = n(cfStmts[0].totalCashFromOperatingActivities?.raw);
          }
        }

        const netCash = totalCash != null ? totalCash - (totalDebt ?? 0) : null;
        // Accept partial data — even gross margin alone is useful for small-cap TSX-V stocks
        const hasAny = revenueTtm || totalCash || grossMargin !== null || eps !== null || sharesOutstanding;
        if (!hasAny) continue;
        return { revenueTtm, revGrowth, grossMargin, totalCash, totalDebt: totalDebt ?? 0, netCash, sharesOutstanding, opCashflow, eps, operatingEps: null, roe, roa, freeCashflow, insiderOwnership, institutionalOwnership, beta, forwardPE, pegRatio, evToEbitda, dividendYield: yahDividendYield };
      } catch { continue; }
    }
  }
  return null;
}

// ─── Business-quality score (decomposed) ──────────────────────────────────────
// X-Ray scores BUSINESS QUALITY only (not the trade — momentum/squeeze live in Decide
// + Opportunity Cost). It must DISCRIMINATE: a sub-$1M-revenue, cash-burning, heavily-
// diluted company should score low (~2), not float to a comfortable 5-6. Each component
// is 0-10; the headline is their weighted average over whatever data is available.
const clamp10 = (x: number) => Math.max(0, Math.min(10, x));

function computeBusinessScore(i: {
  epsVal: number | null; operatingEps?: number | null; opCashflow: number | null; grossMargin: number | null;
  netCash: number | null; totalCash: number | null; totalDebt: number | null;
  revTtm: number | null; revGrowth: number | null; ps: number | null; mc: number | null;
  roe?: number | null; freeCashflow?: number | null;
  isFinancial?: boolean; pe?: number | null;
}): { score: number | null; components: { profitability: number | null; balanceSheet: number | null; growth: number | null; valuation: number | null }; count: number } {
  const c: { profitability: number | null; balanceSheet: number | null; growth: number | null; valuation: number | null } = { profitability: null, balanceSheet: null, growth: null, valuation: null };

  // Profitability — earnings, operating cash flow, margins, and return on equity.
  const effectiveCashflow = i.opCashflow ?? i.freeCashflow ?? null;
  if (i.epsVal != null || effectiveCashflow != null) {
    let p: number;
    if (i.epsVal != null && i.epsVal > 0) {
      p = 7;
      // Cash-flow + margin bonuses don't apply to banks (operating cash flow is noise for them, and
      // they have no "gross margin"), so a profitable bank earns the solid base without those add-ons.
      if (!i.isFinancial && effectiveCashflow != null && effectiveCashflow > 0) p += 1.5;
      if (!i.isFinancial && i.grossMargin != null && i.grossMargin > 0.35) p += 1.5;
      // ROE bonus: high return on equity = efficient capital allocation (non-financial only)
      if (!i.isFinancial && i.roe != null) {
        if (i.roe > 0.30) p += 1;
        else if (i.roe > 0.15) p += 0.5;
      }
      // Quality-of-earnings: if net income is positive but operating income is negative, profitability
      // comes from non-core activities (interest income, one-time gains). Objectively less durable.
      if (!i.isFinancial && i.operatingEps != null && i.operatingEps <= 0) p = Math.min(p, 6);
      // Earnings-yield attenuation: a company with PE > 100 is technically profitable but
      // barely — don't award the same score as a genuine profit machine.
      if (!i.isFinancial && i.pe != null && i.pe > 0) {
        if (i.pe > 150) p = Math.min(p, 5);
        else if (i.pe > 80) p = Math.min(p, 6);
        else if (i.pe > 50) p = Math.min(p, 8);
      }
    } else if (i.isFinancial) {
      // Bank with no positive EPS in our data — usually Canadian SEC sparsity, NOT a real loss. Operating
      // cash flow is meaningless for a bank, so don't read it as "burning cash". Neutral unless a real
      // GAAP loss is reported.
      p = (i.epsVal != null && i.epsVal < 0) ? 3 : 5;
    } else {
      if (effectiveCashflow != null && effectiveCashflow > 0) p = 5;        // cash-flow positive despite a GAAP loss
      else if (effectiveCashflow != null && effectiveCashflow < 0) p = 2;   // unprofitable AND burning cash
      else p = 3;                                                            // loss, cash flow unknown
      if (i.grossMargin != null && i.grossMargin > 0.4) p += 1;
    }
    c.profitability = clamp10(p);
  }

  // Balance sheet & runway — net cash position, tempered by burn-rate runway and leverage.
  // BANK/FINANCIAL LENS: a bank's deposits & borrowings are its raw material, not distress debt, so
  // "net cash" is structurally hugely negative and totalDebt dwarfs market cap by design. Scoring that
  // as leverage tanks every healthy bank (the TD-at-4 bug). For financials we skip this pillar and let
  // profitability + revenue carry the score — we don't pretend to measure capital adequacy from here.
  if (i.netCash != null && !i.isFinancial) {
    let b: number;
    if (i.netCash > 0) {
      b = 6;
      if (i.mc && i.netCash > i.mc * 0.2) b += 1.5;               // cash-rich relative to size
      if (i.opCashflow != null && i.opCashflow < 0 && i.totalCash) {
        const runwayYrs = i.totalCash / Math.abs(i.opCashflow);
        if (runwayYrs < 0.5) b = Math.min(b, 2);                  // months from needing financing
        else if (runwayYrs < 1) b = Math.min(b, 4);
        else if (runwayYrs < 2) b = Math.min(b, 6);
      }
    } else {
      b = 4;
      if (i.totalDebt && i.mc && i.totalDebt > i.mc) b = 2;       // debt exceeds the whole market cap
      else if (i.totalDebt && i.totalCash && i.totalDebt > i.totalCash * 3) b = 3;
      // Investment-grade leverage adjustment: strong positive operating cash flow that covers net debt
      // within a reasonable horizon is STRATEGIC leverage (KO, MCD, SBUX style), not distress. The pure
      // debt/cash ratio penalises these the same as a cash-burning overleveraged company — which is wrong.
      // We step the score up based on how quickly OCF could clear the net debt position.
      if (i.opCashflow != null && i.opCashflow > 0) {
        const yearsToServiceDebt = Math.abs(i.netCash) / i.opCashflow;
        if (yearsToServiceDebt < 4) b = Math.max(b, 5);   // well-covered debt: modest risk
        else if (yearsToServiceDebt < 8) b = Math.max(b, 4); // stretched but serviceable
      }
    }
    c.balanceSheet = clamp10(b);
  }

  // Revenue scale & growth — absolute size matters; +% on a tiny base earns little credit.
  // Growth modifier uses 4 tiers instead of a binary >30% / >0% split. This prevents the saturation
  // where AAPL (+2% growth) and MSFT (+17% growth) both land on exactly 8.5 — fast growers should
  // score materially higher than stagnant ones. Decline tiers mirror the ascent.
  if (i.revTtm != null) {
    const r = i.revTtm;
    let g = r < 1e6 ? 1.5 : r < 1e7 ? 3 : r < 5e7 ? 5 : r < 5e8 ? 6.5 : 7.5;
    const growthWeight = r < 1e7 ? 0.4 : 1; // scale down growth bonus for sub-$10M revenue
    if (i.revGrowth != null) {
      if (i.revGrowth > 0.30)       g += 2.0 * growthWeight;  // >30%: exceptional
      else if (i.revGrowth > 0.15)  g += 1.5 * growthWeight;  // 15-30%: strong
      else if (i.revGrowth > 0.05)  g += 1.0 * growthWeight;  // 5-15%: healthy
      else if (i.revGrowth > 0)     g += 0.5 * growthWeight;  // 0-5%: marginal
      else if (i.revGrowth < -0.15) g -= 2.5;                 // >15% decline: serious
      else if (i.revGrowth < -0.05) g -= 1.5;                 // 5-15% decline: notable
      else if (i.revGrowth < 0)     g -= 0.5;                 // 0-5% decline: slight
    }
    c.growth = clamp10(g);
  }

  // NOTE: valuation (P/S) is deliberately NOT scored here. X-Ray measures BUSINESS QUALITY, and
  // valuation is a PRICE/entry signal (a great business can be expensive, junk can be cheap) —
  // penalizing premium-priced quality names (NVDA) for their P/S conflates "expensive" with "low
  // quality". Valuation lives in Decide's buy-zone + the card's P/S/P/E cells. An absurd P/S on a
  // no-revenue name is already captured by the Revenue Scale & Growth pillar. (c.valuation stays null.)

  const weights = { profitability: 0.40, balanceSheet: 0.30, growth: 0.30 };
  let acc = 0, wsum = 0, count = 0;
  (Object.keys(weights) as (keyof typeof weights)[]).forEach((k) => {
    if (c[k] != null) { acc += (c[k] as number) * weights[k]; wsum += weights[k]; count++; }
  });
  return { score: wsum > 0 ? Math.round((acc / wsum) * 10) / 10 : null, components: c, count };
}

// ─── Build response ───────────────────────────────────────────────────────────

/** Build a short plain-text snippet from the X-Ray result for ticker memory storage.
 *  Captures score + top 3 key metrics so the Intel brief has a financial anchor on repeat visits. */
function buildXraySnippet(
  result: { score?: number | null; metrics?: Array<{ label: string; value: string }> },
  sector: string | null | undefined,
  industry: string | null | undefined
): string {
  const parts: string[] = [];
  if (result.score != null) parts.push(`Score: ${result.score}/10`);
  const KEY_METRICS = ["Revenue TTM", "Net Cash", "Gross Margin", "EPS (TTM)"];
  (result.metrics ?? [])
    .filter(m => KEY_METRICS.includes(m.label))
    .forEach(m => parts.push(`${m.label}: ${m.value}`));
  if (sector) parts.push(sector);
  if (industry && industry !== sector) parts.push(industry);
  return parts.join(" · ");
}

function buildXrayResult(
  symbol: string,
  name: string,
  price: number | null,
  v7: AnyObj | null,
  sec: SecFundamentals | null,
  sector: string | null = null,
  industry: string | null = null
): AnyObj {
  // Take max across all sources — Yahoo quote, Yahoo fundamentals (via sec path), SEC EDGAR,
  // and shares derived from Yahoo's marketCap/price (most reliable — same number Yahoo uses on
  // their key-statistics page, no crumb required, always present in v7 quote).
  const mc = n(v7?.marketCap) ?? null;
  const derivedShares = (mc && price && price > 0) ? Math.round(mc / price) : null;
  const shares = [n(v7?.sharesOutstanding), sec?.sharesOutstanding, derivedShares]
    .filter((v): v is number => v != null && v > 0)
    .reduce((a, b) => Math.max(a, b), 0) || null;
  // Use marketCap from v7 if available, else derive from shares
  const mcFinal = mc ?? (price && shares ? price * shares : null);

  // v7/quote per-share fields — work for ALL Yahoo stocks incl. Canadian/OTC
  // These are used as fallback when SEC EDGAR has no data
  const v7RevPerShare   = n(v7?.revenuePerShare);
  const v7CashPerShare  = n(v7?.totalCashPerShare);
  const v7DebtPerShare  = n(v7?.debtToEquity) !== null ? null : null; // debt/equity not useful here
  const v7GrossMargin   = safeMargin(v7?.grossMargins);
  const v7ProfitMargin  = n(v7?.profitMargins);
  const v7RevTtm        = v7RevPerShare  && shares ? v7RevPerShare  * shares : null;
  const v7TotalCash     = v7CashPerShare && shares ? v7CashPerShare * shares : null;
  // totalDebt: Yahoo returns totalDebt directly in v7 for some stocks
  const v7TotalDebt     = n(v7?.totalDebt);
  const v7NetCash       = v7TotalCash != null ? v7TotalCash - (v7TotalDebt ?? 0) : null;

  const ps = n(v7?.priceToSalesTrailing12Months)
    ?? (mcFinal && (sec?.revenueTtm ?? v7RevTtm) ? mcFinal / (sec?.revenueTtm ?? v7RevTtm)! : null);
  const analystTarget = n(v7?.targetMeanPrice);
  const vsTarget = analystTarget && price ? (price - analystTarget) / analystTarget * 100 : null;
  // EPS fallback chain — three independent sources, each sanity-checked.
  // P/E < 0.5 means the value is contaminated by a non-cash one-time gain
  // (warrant fair-value remeasurements, derivative adjustments, etc.).
  const epsOk = (e: number | null | undefined): e is number => {
    if (e == null || !Number.isFinite(e)) return false;
    if (e > 0 && price != null && price / e < 0.5) return false; // impossible P/E → contaminated
    return true;
  };
  const secEpsRaw      = sec?.eps;
  const yahooEpsRaw    = n(v7?.epsTrailingTwelveMonths);
  const secOpEpsRaw    = sec?.operatingEps;
  // EPS: prefer Yahoo's professionally-aggregated TTM EPS. SEC's net-income÷shares relies on the same
  // fragile XBRL TTM summation that over/under-counts revenue for large multi-segment filers, so Yahoo
  // is the more reliable primary; SEC stays as cross-check/fallback (esp. for names Yahoo doesn't cover).
  const epsVal = epsOk(yahooEpsRaw) ? yahooEpsRaw   // 1st: Yahoo TTM EPS — reliable for covered names
               : epsOk(secEpsRaw)   ? secEpsRaw     // 2nd: SEC net income TTM / shares
               : epsOk(secOpEpsRaw) ? secOpEpsRaw   // 3rd: SEC operating income / shares (no warrant gains)
               : ((yahooEpsRaw != null && yahooEpsRaw < 0) ? yahooEpsRaw : (secEpsRaw != null && secEpsRaw < 0) ? secEpsRaw : null); // last resort: genuine loss

  // ── Revenue TTM — cross-source, Yahoo-primary ──────────────────────────────
  // Market cap ÷ Yahoo's trailing P/S is the most reliable TTM revenue (both are Yahoo primary fields,
  // no XBRL parsing). SEC's quarter-summation is fragile for large multi-segment filers — it read NVDA
  // 12× LOW ($10.9B vs ~$130B) and AAPL ~11% HIGH — so we prefer Yahoo and use SEC only when Yahoo is
  // unavailable, then guard: if the chosen revenue implies an absurd P/S, fall back to the saner source.
  const yahooPS    = n(v7?.priceToSalesTrailing12Months);
  const revFromPS  = (mcFinal && yahooPS && yahooPS > 0) ? mcFinal / yahooPS : null;
  const yahooRev   = revFromPS ?? v7RevTtm;
  let revTtm: number | null = yahooRev ?? sec?.revenueTtm ?? (mcFinal && ps ? mcFinal / ps : null);
  if (revTtm != null && mcFinal) {
    const impliedPS = mcFinal / revTtm;
    if ((impliedPS > 90 || impliedPS < 0.02) && sec?.revenueTtm && sec.revenueTtm !== revTtm) {
      const altPS = mcFinal / sec.revenueTtm;
      if (altPS <= 90 && altPS >= 0.02) revTtm = sec.revenueTtm; // chosen value implausible → SEC is saner
    }
  }
  const totalCash   = sec?.totalCash  ?? v7TotalCash;
  const netCash     = sec?.netCash    ?? v7NetCash;

  // ── Gross Margin — cross-source, never a fake 0.0% ─────────────────────────
  // Yahoo's grossMargins is a clean ratio independent of our XBRL TTM bugs, so it's primary; SEC is the
  // fallback. We reject 0 (which means "couldn't compute", not "zero margin") and out-of-range values,
  // and banks/insurers (no cost of goods) get N/A — never 0.0%.
  const isFin = /financial/i.test(sector || "") || /\b(bank|banks|insurance|insurer|capital markets|credit services|asset management|reinsurance|savings|mortgage finance)\b/i.test(industry || "");
  const validGM = (m: number | null | undefined): number | null =>
    (m != null && Number.isFinite(m) && m > 0.01 && m < 0.999) ? m : null;
  const grossMargin = isFin ? null : (validGM(v7GrossMargin) ?? validGM(safeMargin(sec?.grossMargin)) ?? null);
  const opCashflow  = sec?.opCashflow ?? (v7ProfitMargin && revTtm ? v7ProfitMargin * revTtm : null);
  const cashPerShare = totalCash != null && shares ? totalCash / shares : null;
  const cashPct = cashPerShare && price ? cashPerShare / price * 100 : null;

  const totalDebt = sec?.totalDebt ?? v7TotalDebt ?? null;
  // Banks/insurers/capital-markets names: their balance sheet runs on deposits & leverage by design,
  // so the leverage-distress pillar must not apply (see computeBusinessScore).
  const isFinancial = /financial/i.test(sector || "") || /\b(bank|banks|insurance|insurer|capital markets|credit services|asset management|reinsurance|savings|mortgage finance)\b/i.test(industry || "");
  const roe = sec?.roe ?? null;
  const roa = sec?.roa ?? null;
  const freeCashflow = sec?.freeCashflow ?? null;
  const insiderOwnership = sec?.insiderOwnership ?? null;
  const institutionalOwnership = sec?.institutionalOwnership ?? null;
  const beta = sec?.beta ?? null;
  const dividendYield = n(v7?.trailingAnnualDividendYield) ?? n(v7?.dividendYield) ?? sec?.dividendYield ?? null;
  const forwardPE = sec?.forwardPE ?? null;
  const pegRatio = sec?.pegRatio ?? null;
  const evToEbitda = sec?.evToEbitda ?? null;
  const pe = (price != null && epsVal != null && epsVal > 0) ? price / epsVal : null;
  const _bq = computeBusinessScore({ epsVal, operatingEps: sec?.operatingEps ?? null, opCashflow, grossMargin, netCash, totalCash, totalDebt, revTtm, revGrowth: sec?.revGrowth ?? null, ps, mc: mcFinal, roe, freeCashflow, isFinancial, pe });
  // No neutral-5 placebo: when there are genuinely no fundamentals to judge (obscure/foreign/brand-new
  // tickers with price only), the score is NULL — the UI shows "—  Not enough data", never a fake "5.0"
  // that reads as an average-quality verdict.
  const score = _bq.score; // number | null
  const scoreUnavailable = score == null;
  const scoreComponents = _bq.components;
  const scorePillarCount = _bq.count;

  // ── Simple DCF fair value — deterministic, $0, no AI ──────────────────────
  // 5-year projection of FCF → terminal value → discount → equity per share.
  // Only runs when we have cash flow + shares. Conservative: caps growth at 25%,
  // floors at -5%, uses 12% discount rate, 2.5% terminal growth.
  const dcfFcf = freeCashflow ?? opCashflow;
  let dcfFairValue: number | null = null;
  let dcfMarginOfSafety: number | null = null;
  if (dcfFcf != null && dcfFcf > 0 && shares && shares > 0 && price) {
    const growthRaw = sec?.revGrowth ?? 0;
    const g = Math.max(-0.05, Math.min(0.25, growthRaw));
    const r = 0.12; // discount rate
    const tg = 0.025; // terminal growth
    let pvFcf = 0;
    let projFcf = dcfFcf;
    for (let yr = 1; yr <= 5; yr++) {
      projFcf *= (1 + g);
      pvFcf += projFcf / Math.pow(1 + r, yr);
    }
    const terminalValue = (projFcf * (1 + tg)) / (r - tg);
    const pvTerminal = terminalValue / Math.pow(1 + r, 5);
    const enterpriseValue = pvFcf + pvTerminal;
    const equityValue = enterpriseValue + (netCash ?? 0);
    dcfFairValue = equityValue / shares;
    if (dcfFairValue > 0) {
      dcfMarginOfSafety = ((dcfFairValue - price) / dcfFairValue) * 100;
    }
  }

  const hasSec = !!sec;
  const hasV7Fundamentals = !!(v7RevTtm || v7TotalCash || v7GrossMargin);
  const source = hasSec ? "Yahoo Finance + SEC EDGAR"
    : hasV7Fundamentals ? "Yahoo Finance (fundamentals)"
    : v7 ? "Yahoo Finance (price only)"
    : "Price only";

  // Pre-revenue lens: a grassroots miner OR a clinical-stage biotech scores near-zero on a
  // business-QUALITY model (no revenue, no profit, burning cash) — which misleadingly reads as
  // a failing company. Flag it so the UI relabels the score: these are judged on their assets,
  // runway, and catalysts (discovery/trials), not on earnings they don't have yet.
  const mining = classifyMining({ name, sector, industry, description: null });
  const isBio = classifyBiotech({ name, sector, industry, description: null }).isBiotech;
  // The reliable "pre-revenue vs commercial" signal is operating cash flow: a pre-revenue name
  // BURNS cash (opCashflow < 0) and isn't profitable, while a producer/commercial-stage company
  // generates it. Use only REAL reported revenue (not the marketCap÷P/S fallback, which can
  // fabricate a figure), with a higher threshold since Yahoo often reports small interest/
  // collaboration income as "revenue".
  const realRevTtm = sec?.revenueTtm ?? v7RevTtm;
  const burningPreRev = (epsVal == null || epsVal <= 0)
    && (opCashflow == null || opCashflow < 0)
    && (realRevTtm == null || realRevTtm < 5e7);
  const miningExplorer = mining.isMining && burningPreRev;
  const clinicalBiotech = !mining.isMining && isBio && burningPreRev;
  const preRevenue = miningExplorer || clinicalBiotech;
  // Early-stage / pre-commercial company OUTSIDE mining/biotech (e.g. quantum, eVTOL, space,
  // newly-public SPACs): unprofitable, burning cash, minimal revenue. Unlike explorers/biotech we
  // KEEP the score (its balance-sheet signal is still useful) but flag it so the UI frames it as a
  // runway/milestone/catalyst story, not a mature-company quality verdict. Revenue-generating
  // early names (real revenue ≥ $50M) are NOT flagged — their score fairly reflects early traction.
  // A genuine early-stage name still has SOME fundamentals (e.g. a balance sheet) so it gets a real
  // score; if we have nothing at all (scoreUnavailable), it's a "no data" case, not "early-stage".
  const earlyStage = !mining.isMining && !isBio && burningPreRev && !scoreUnavailable;
  const miningRunway = (mining.isMining || isBio || earlyStage) ? computeCashRunway(totalCash, opCashflow) : null;

  // Pre-revenue OVERALL score (Gate 1): a no-revenue explorer FAILS a business-quality model by
  // construction (→ misleading low number), and "N/A" is a cop-out. Replace both with a CAPPED
  // survival grade (≤ PREREV_SCORE_CAP, strictly below the proven-company band) that never outranks a
  // real company but still separates good pre-rev from bad. This is the QUALITY axis only — the
  // "setup"/entry opportunity is a separate axis. See prerev-score.ts.
  const runwayMonths = (opCashflow != null && opCashflow < 0 && totalCash != null && totalCash > 0)
    ? (totalCash / ((-opCashflow) / 12)) : null;
  const _preRev = preRevenue
    ? computePreRevScore({ runwayMonths, netCash, totalCash, marketCap: mcFinal, dayChangePct: n(v7?.regularMarketChangePercent) })
    : null;
  const finalScore = _preRev ? _preRev.score : score;
  const finalComponents = _preRev ? _preRev.components : scoreComponents;
  const finalScoreUnavailable = _preRev ? false : scoreUnavailable;
  // scoreKind tells the UI which rubric this number is on, so it's labelled honestly and never
  // confused with a business-quality score (or mislabelled "Crypto" by the array-shaped breakdown).
  const scoreKind: "prerev" | "stock" = _preRev ? "prerev" : "stock";


  const ccy = /\.(TO|V|CN|NE|TSX)$/i.test(symbol) ? "CAD" : "USD";
  return {
    symbol,
    name,
    source,
    currency: ccy,
    score: finalScore,
    scoreComponents: finalComponents,
    scoreKind,
    // Day change + market timestamp (seconds) for the price line — abstract, null when Yahoo omits them.
    dayChangePct: n(v7?.regularMarketChangePercent),
    marketTime: n(v7?.regularMarketTime),
    isMining: mining.isMining,
    isBiotech: isBio,
    miningExplorer,
    clinicalBiotech,
    earlyStage,
    earlyStageNote: earlyStage
      ? "Early-stage / pre-revenue — this score reflects current fundamentals; for a pre-commercial company weigh runway, milestones & catalysts more heavily."
      : null,
    assetProfile: getAssetProfile({ name, sector, industry, description: null, isCrypto: isCryptoTicker(symbol), isCommodity: isCommodityTicker(symbol), epsVal, opCashflow, revTtm: realRevTtm, revGrowth: sec?.revGrowth ?? null, netCash }),
    miningCommodity: mining.commodity,
    miningRunway,
    scoreUnavailable: finalScoreUnavailable,
    // Pre-rev now shows a real CAPPED number labelled "Speculative" (not "N/A"); genuine no-data → N/A.
    scoreLabel: _preRev ? "Speculative" : ((preRevenue || scoreUnavailable) ? "N/A" : null),
    scoreNote: miningExplorer
      ? "Pre-revenue explorer — judged on discovery, runway & catalysts, not earnings"
      : clinicalBiotech
      ? "Clinical-stage biotech — judged on pipeline, trial readouts & runway, not earnings"
      : scoreUnavailable
      ? "Not enough fundamental data to score this name — showing price & identity only."
      : (scorePillarCount < 3 && !_preRev)
      ? `Score based on ${scorePillarCount} of 3 pillars — some financial data unavailable.`
      : null,
    metrics: [
      price != null && { label: "Current Price", value: `${ccy === "CAD" ? "C$" : "$"}${price.toFixed(2)}`, status: "good" },
      sec?.revGrowth != null && { label: "Revenue Trend", value: `YoY ${sec.revGrowth >= 0 ? "+" : ""}${(sec.revGrowth * 100).toFixed(1)}%`, status: sec.revGrowth > 0 ? "good" : sec.revGrowth > -0.1 ? "watch" : "bad" },
      revTtm != null && { label: "Revenue TTM", value: mny(revTtm), status: revTtm > 1e6 ? "good" : "watch" },
      netCash != null && { label: "Net Cash", value: mny(netCash), status: netCash >= 0 ? "good" : "bad" },
      epsVal != null && { label: "EPS", value: epsVal.toFixed(2), status: epsVal > 0 ? "good" : "bad" },
      grossMargin != null && { label: "Gross Margin", value: `${(grossMargin * 100).toFixed(1)}%`, status: grossMargin >= 0.4 ? "good" : grossMargin >= 0.2 ? "watch" : "bad" },
      roe != null && !isFinancial && { label: "Return on Equity", value: `${(roe * 100).toFixed(1)}%`, status: roe >= 0.20 ? "good" : roe >= 0 ? "watch" : "bad", context: roe >= 0.20 ? "Strong capital efficiency" : roe >= 0 ? "Moderate" : "Destroying equity value" },
      roa != null && !isFinancial && { label: "Return on Assets", value: `${(roa * 100).toFixed(1)}%`, status: roa >= 0.05 ? "good" : roa >= 0 ? "watch" : "bad" },
    ].filter(Boolean),
    valuation: [
      ps != null && { label: "P/S Ratio", value: mlt(ps), status: st(ps, v => v < 3, v => v <= 10), context: ps > 10 ? "Expensive - needs high growth" : "Valuation versus revenue" },
      price != null && epsVal != null && epsVal > 0 && { label: "P/E Ratio", value: `${(price / epsVal).toFixed(1)}x`, status: st(price / epsVal, v => v < 20, v => v <= 40), context: price / epsVal < 20 ? "Cheap relative to earnings" : price / epsVal <= 40 ? "Reasonable for a growing company" : "Premium valuation — needs strong growth" },
      forwardPE != null && forwardPE > 0 && { label: "Forward P/E", value: `${forwardPE.toFixed(1)}x`, status: st(forwardPE, v => v < 15, v => v <= 30), context: forwardPE < 15 ? "Cheap on forward earnings" : forwardPE <= 30 ? "Reasonable" : "Premium forward multiple" },
      pegRatio != null && pegRatio > 0 && { label: "PEG Ratio", value: `${pegRatio.toFixed(2)}x`, status: st(pegRatio, v => v < 1, v => v <= 2), context: pegRatio < 1 ? "Growth-adjusted: undervalued" : pegRatio <= 2 ? "Fairly valued for growth" : "Expensive relative to growth" },
      evToEbitda != null && evToEbitda > 0 && { label: "EV/EBITDA", value: `${evToEbitda.toFixed(1)}x`, status: st(evToEbitda, v => v < 10, v => v <= 20), context: evToEbitda < 10 ? "Cheap enterprise value vs earnings" : evToEbitda <= 20 ? "Moderate valuation" : "Premium — needs strong cash flow growth" },
      cashPerShare != null && { label: "Cash Per Share", value: `$${cashPerShare.toFixed(2)}`, status: st(cashPct, v => v > 25, v => v >= 10), context: cashPct ? `${cashPct.toFixed(0)}% of price backed by cash` : "" },
      opCashflow != null && { label: "Cash Runway", value: opCashflow > 0 ? "Cash flow positive" : "Negative cash flow", status: opCashflow > 0 ? "good" : "watch" },
      shares != null && { label: "Shares Outstanding", value: shares.toLocaleString("en", { maximumFractionDigits: 0 }), status: "watch" as const },
      insiderOwnership != null && insiderOwnership > 0 && { label: "Insider Ownership", value: `${(insiderOwnership * 100).toFixed(1)}%`, status: insiderOwnership >= 0.10 ? "good" as const : insiderOwnership >= 0.03 ? "watch" as const : "bad" as const, context: insiderOwnership >= 0.10 ? "Strong insider alignment" : insiderOwnership >= 0.03 ? "Moderate insider stake" : "Low insider skin in the game" },
      institutionalOwnership != null && institutionalOwnership > 0 && { label: "Institutional Ownership", value: `${(institutionalOwnership * 100).toFixed(1)}%`, status: institutionalOwnership >= 0.50 ? "good" as const : institutionalOwnership >= 0.20 ? "watch" as const : "watch" as const, context: institutionalOwnership >= 0.50 ? "Heavy institutional interest" : "Some institutional backing" },
      beta != null && { label: "Beta", value: beta.toFixed(2), status: (beta > 0.5 && beta < 1.5) ? "good" as const : (beta >= 1.5 && beta < 2.5) ? "watch" as const : "bad" as const, context: (beta < 0.5 ? "Very low volatility vs market" : beta < 1.5 ? "Moves roughly with market" : beta < 2.5 ? "More volatile than market" : "Highly volatile") + (/\.(TO|V|CN|NE|TSX)$/i.test(symbol) ? " (vs TSX)" : " (vs S&P 500)") },
      analystTarget != null && { label: "Analyst vs Price", value: `$${analystTarget.toFixed(2)} target`, status: vsTarget != null ? (vsTarget < 0 ? "good" as const : vsTarget <= 15 ? "watch" as const : "bad" as const) : "watch" as const, context: vsTarget != null ? `You are ${Math.abs(vsTarget).toFixed(0)}% ${vsTarget > 0 ? "ABOVE" : "BELOW"} consensus` : "No analyst target" },
      dcfFairValue != null && dcfFairValue > 0 && { label: "DCF Fair Value", value: `$${dcfFairValue >= 1 ? dcfFairValue.toFixed(2) : dcfFairValue.toFixed(4)}`, status: dcfMarginOfSafety != null ? (dcfMarginOfSafety > 25 ? "good" as const : dcfMarginOfSafety > 0 ? "watch" as const : "bad" as const) : "watch" as const, context: dcfMarginOfSafety != null ? (dcfMarginOfSafety > 0 ? `${dcfMarginOfSafety.toFixed(0)}% margin of safety` : `${Math.abs(dcfMarginOfSafety).toFixed(0)}% above fair value`) : "" },
      dividendYield != null && dividendYield > 0 && { label: "Dividend Yield", value: `${(dividendYield * 100).toFixed(2)}%`, status: dividendYield >= 0.03 ? "good" as const : dividendYield >= 0.01 ? "watch" as const : "watch" as const, context: dividendYield >= 0.04 ? "High yield — verify sustainability" : dividendYield >= 0.02 ? "Moderate income" : "Low yield" },
    ].filter(Boolean),
  };
}

// ─── Press-release 6-K parser ────────────────────────────────────────────────
// For foreign filers (e.g. NBIS) whose quarterly 6-K reports are plain HTML
// with no XBRL tagging. Fetches the most recent exhibit and extracts cash +
// revenue using tight, conservative regex patterns. Fails silently — if anything
// is ambiguous or unreasonable, we keep the XBRL baseline unchanged.

type PressReleaseData = { cash: number | null; revenueTtm: number | null };

async function fetchPressRelease6K(
  cik: string,
  xbrlDataDate: string | null   // ISO date of most recent XBRL filing (e.g. "2025-12-31")
): Promise<PressReleaseData> {
  const empty: PressReleaseData = { cash: null, revenueTtm: null };
  try {
    const secHeaders = { "User-Agent": "Plainview investing tool plainview@dar-fishman.com", Accept: "application/json" };

    // Get recent filings list
    const subRes = await fetch(`https://data.sec.gov/submissions/CIK${cik}.json`, { headers: secHeaders, next: { revalidate: 3600 } });
    if (!subRes.ok) return empty;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sub = await subRes.json() as any;
    const forms: string[]      = sub.filings?.recent?.form         ?? [];
    const dates: string[]      = sub.filings?.recent?.filingDate   ?? [];
    const accessions: string[] = sub.filings?.recent?.accessionNumber ?? [];

    // Find the most recent 6-K filed AFTER the XBRL data date
    let targetAccession: string | null = null;
    for (let i = 0; i < forms.length; i++) {
      if (forms[i] !== "6-K") continue;
      if (xbrlDataDate && dates[i] <= xbrlDataDate) break; // filings are newest-first; stop once older
      targetAccession = accessions[i];
      break;
    }
    if (!targetAccession) return empty;

    // Get the filing index to find exhibit URLs
    const accPath = targetAccession.replace(/-/g, "");
    const idxRes = await fetch(
      `https://www.sec.gov/Archives/edgar/data/${parseInt(cik)}/` +
      `${accPath}/${targetAccession}-index.htm`,
      { headers: { "User-Agent": "Plainview investing tool plainview@dar-fishman.com" }, next: { revalidate: 86400 } } // a filed index is immutable
    );
    if (!idxRes.ok) return empty;
    const idxHtml = await idxRes.text();

    // Collect all .htm exhibit URLs — pick the largest one (most likely the earnings release)
    const exhibitUrls = [...idxHtml.matchAll(/href="(\/Archives\/edgar\/data\/[^"]+\.htm[l]?)"/gi)]
      .map(m => "https://www.sec.gov" + m[1])
      .filter(u => !u.endsWith("-index.htm") && !u.endsWith("-index.html"));
    if (!exhibitUrls.length) return empty;

    // Fetch exhibits in parallel (max 3), pick the one with the most financial text
    const fetches = await Promise.allSettled(
      exhibitUrls.slice(0, 3).map(url =>
        fetch(url, { headers: { "User-Agent": "Plainview investing tool plainview@dar-fishman.com" }, next: { revalidate: 86400 } }) // filed exhibit is immutable
          .then(r => r.ok ? r.text() : "")
      )
    );
    const texts = fetches
      .map(f => f.status === "fulfilled" ? f.value : "")
      .map(html => html
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/g, " ")
        .replace(/&[a-z]+;/gi, " ")
        .replace(/&#\d+;/g, " ")
        .replace(/\s+/g, " ")
      );

    // Pick the exhibit that mentions "cash and cash equivalents" — most likely earnings release
    const text = texts.find(t => /cash and cash equivalents/i.test(t)) ?? texts[0] ?? "";
    if (!text) return empty;

    // Detect unit scale: "in millions" → 1e6, "in billions" → 1e9, "in thousands" → 1e3
    const unitMatch = text.match(/in\s+(thousands|millions|billions)\s+of\s+U\.?S\.?\s+dollars/i);
    const scale = unitMatch?.[1]?.toLowerCase() === "billions" ? 1e9
                : unitMatch?.[1]?.toLowerCase() === "thousands" ? 1e3
                : 1e6; // default millions

    // ── Extract cash ────────────────────────────────────────────────────────
    // Pattern 1: "$9,298.2 million was recorded in cash and cash equivalents"
    // Pattern 2: "cash and cash equivalents ... $X.XB" or "$X,XXX.XM"
    let cash: number | null = null;
    const cashPatterns = [
      /\$([\d,]+(?:\.\d+)?)\s*(billion|million|thousand)s?\s+(?:was recorded in|in|of)\s+cash and cash equivalents/i,
      /cash and cash equivalents[^$]{0,120}\$([\d,]+(?:\.\d+)?)\s*(billion|million|thousand)s?/i,
      /\$([\d,]+(?:\.\d+)?)\s*(billion|million|thousand)s?\s+(?:in|of)\s+cash(?:\s+and\s+cash\s+equivalents)?/i,
    ];
    for (const pat of cashPatterns) {
      const m = text.match(pat);
      if (m) {
        const raw = parseFloat(m[1].replace(/,/g, ""));
        const wordScale = m[2]?.toLowerCase() === "billion" ? 1e9 : m[2]?.toLowerCase() === "thousand" ? 1e3 : 1e6;
        cash = raw * wordScale;
        break;
      }
    }
    // Fallback: look for bare number near "cash and cash equivalents" using table scale
    if (cash === null) {
      const cashCtx = text.match(/cash and cash equivalents[^.]{0,80}?([\d,]+\.?\d*)/i);
      if (cashCtx) {
        const raw = parseFloat(cashCtx[1].replace(/,/g, ""));
        if (raw > 0) cash = raw * scale;
      }
    }

    // ── Extract quarterly revenue ─────────────────────────────────────────────
    // In earnings tables: "Revenues  50.9  399.0" — two columns, take the RIGHT (current period)
    // Also handles "Total revenues  50.9  399.0"
    let latestQuarterRevenue: number | null = null;
    const revPatterns = [
      /(?:total\s+)?revenues?\s+([\d,.]+)\s+([\d,.]+)/i,
      /(?:total\s+)?revenue\s+([\d,.]+)\s+([\d,.]+)/i,
    ];
    for (const pat of revPatterns) {
      const m = text.match(pat);
      if (m) {
        const prior  = parseFloat(m[1].replace(/,/g, ""));
        const current = parseFloat(m[2].replace(/,/g, ""));
        // Sanity: current should be >= 0 and prior should be <= current (growth company)
        // Don't enforce growth — just check they're both positive numbers
        if (current > 0 && prior >= 0) {
          latestQuarterRevenue = current * scale;
          break;
        }
      }
    }

    // ── Sanity checks before returning ────────────────────────────────────────
    // Reject if values are implausibly large (>$10T) or negative
    if (cash !== null && (cash < 0 || cash > 1e13)) cash = null;
    if (latestQuarterRevenue !== null && (latestQuarterRevenue < 0 || latestQuarterRevenue > 1e13)) latestQuarterRevenue = null;

    // Revenue from press release is a single quarter — annualise as TTM approximation
    // (4x latest quarter). This is conservative but directionally correct for fast growers.
    const revenueTtm = latestQuarterRevenue !== null ? latestQuarterRevenue * 4 : null;

    return { cash, revenueTtm };
  } catch {
    return empty; // always fail silently
  }
}

// ─── Route Handler ────────────────────────────────────────────────────────────

/** Try bare ticker first, then Canadian exchange suffixes if v7/quote returns no price */
/** True if Yahoo has a price for this EXACT symbol, checked via v8/chart.
 *  Must NOT use v7 quote here — it's crumb-blocked and returns null for valid US
 *  tickers, which made bare US tickers wrongly fall through to a Canadian listing
 *  (e.g. a US stock resolving to a different .TO company). */
async function hasChartPrice(symbol: string): Promise<boolean> {
  for (const host of ["query1", "query2"]) {
    try {
      const res = await fetch(
        `https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=5d&interval=1d`,
        { headers: YF_HEADERS, next: { revalidate: 600 } } // symbol-exists probe — cache 10m
      );
      if (!res.ok) continue;
      const j = await res.json();
      const meta = j?.chart?.result?.[0]?.meta;
      if (meta && (meta.regularMarketPrice != null || meta.chartPreviousClose != null || meta.previousClose != null)) return true;
    } catch { /* try next host */ }
  }
  return false;
}

/** Company sector + industry from Yahoo's search API — NOT crumb-blocked, so it works
 *  for Canadian/OTC listings where the detailed fundamentals feed is blocked. Lets the
 *  AI brief and the card know what the company actually does (e.g. AC.TO = Airlines). */
async function fetchYahooProfile(symbol: string): Promise<{ sector: string | null; industry: string | null; name: string | null }> {
  const empty = { sector: null, industry: null, name: null };
  for (const host of ["query1", "query2"]) {
    try {
      const res = await fetch(
        `https://${host}.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(symbol)}&quotesCount=4&newsCount=0`,
        { headers: YF_HEADERS, next: { revalidate: 86400 } }
      );
      if (!res.ok) continue;
      const data: AnyObj = await res.json();
      const quotes: AnyObj[] = Array.isArray(data?.quotes) ? data.quotes : [];
      const up = symbol.toUpperCase();
      const q = quotes.find((x) => String(x.symbol || "").toUpperCase() === up) || quotes[0];
      if (!q) continue;
      return {
        sector: q.sector ? String(q.sector) : null,
        industry: q.industry ? String(q.industry) : null,
        name: q.longname || q.shortname || null,
      };
    } catch { /* try next host */ }
  }
  return empty;
}

async function resolveCanadianSymbol(raw: string): Promise<string> {
  // Warrants: brokerages use .WS / .WT / -WT; Yahoo varies per listing (-WT, W suffix, etc.).
  const wm = raw.match(/^([A-Z]+)[.\-](WS|WT|WR|RT)$/i);
  if (wm) {
    const b = wm[1].toUpperCase();
    for (const c of [`${b}-WT`, `${b}W`, `${b}WT`, `${b}-WS`]) {
      if (await hasChartPrice(c)) return c;
    }
  }
  // Bare ticker first — a valid US listing wins. Only fall back to Canadian exchanges
  // when the bare ticker genuinely has no price (e.g. XEQT → XEQT.TO).
  if (await hasChartPrice(raw)) return raw;
  const base = raw.replace(/\.(TO|V|CN|NE)$/i, "");
  for (const suffix of [".TO", ".NE", ".V", ".CN"]) {
    const candidate = base + suffix;
    if (candidate === raw) continue;
    if (await hasChartPrice(candidate)) return candidate;
  }
  return raw;
}

// ─── ETF X-Ray ────────────────────────────────────────────────────────────────
// ETFs have no company fundamentals (no revenue/EPS/margins/SEC filings). Instead
// we build a performance + trend + risk card from 1-year daily price history — the
// metrics an ETF investor actually evaluates. All from v8/chart (no crumb needed).
// Returns the same { metrics, valuation, score } shape so the client renders it
// with zero changes. Returns null if the symbol is not an ETF.

async function fetchEtfXray(symbol: string): Promise<AnyObj | null> {
  try {
    let result: AnyObj | null = null;
    for (const host of ["query1", "query2"]) {
      const res = await fetch(
        `https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1y&interval=1d`,
        { headers: YF_HEADERS, next: { revalidate: 7200 } } // ETF 1y bars — daily; cache 2h
      ).catch(() => null);
      if (res?.ok) { result = (await res.json())?.chart?.result?.[0] ?? null; if (result) break; }
    }
    if (!result) return null;

    const meta = result.meta || {};
    // Only handle ETFs here — everything else falls through to the stock path
    if (String(meta.instrumentType || "").toUpperCase() !== "ETF") return null;

    const closes: number[] = (result.indicators?.quote?.[0]?.close ?? []).filter((v: unknown): v is number => typeof v === "number" && Number.isFinite(v));
    const timestamps: number[] = result.timestamp ?? [];
    if (closes.length < 30) return null; // not enough history to be useful

    const price = n(meta.regularMarketPrice) ?? closes[closes.length - 1];
    const name = (meta.longName || meta.shortName || symbol) as string;
    const last = closes[closes.length - 1];

    // Period returns (trading days: ~21/mo)
    const retDays = (d: number): number | null => {
      const i = closes.length - 1 - d;
      return i >= 0 && closes[i] > 0 ? (last - closes[i]) / closes[i] * 100 : null;
    };
    const ret1M = retDays(21), ret3M = retDays(63), ret6M = retDays(126), ret1Y = retDays(closes.length - 1);
    // YTD
    const yStart = new Date(new Date().getFullYear(), 0, 1).getTime() / 1000;
    const yi = timestamps.findIndex(t => t >= yStart);
    const retYTD = (yi >= 0 && closes[yi] > 0) ? (last - closes[yi]) / closes[yi] * 100 : null;

    // Moving averages, 52-week range
    const avg = (arr: number[], nn: number) => arr.length >= nn ? arr.slice(-nn).reduce((a, b) => a + b, 0) / nn : null;
    const ma50 = avg(closes, 50), ma200 = avg(closes, 200);
    const week52High = Math.max(...closes), week52Low = Math.min(...closes);
    const drawdown = week52High > 0 ? (price - week52High) / week52High * 100 : null; // negative
    const rangePos = (week52High > week52Low) ? (price - week52Low) / (week52High - week52Low) * 100 : null;

    // Annualised volatility from daily returns
    const dailyRets: number[] = [];
    for (let i = 1; i < closes.length; i++) if (closes[i - 1] > 0) dailyRets.push((closes[i] - closes[i - 1]) / closes[i - 1]);
    let volatility: number | null = null;
    if (dailyRets.length > 20) {
      const mean = dailyRets.reduce((a, b) => a + b, 0) / dailyRets.length;
      const variance = dailyRets.reduce((s, r) => s + (r - mean) ** 2, 0) / dailyRets.length;
      volatility = Math.sqrt(variance) * Math.sqrt(252) * 100;
    }

    // Trend structure
    const aboveMa50 = ma50 != null && price > ma50;
    const aboveMa200 = ma200 != null && price > ma200;
    const trendLabel = (aboveMa50 && aboveMa200) ? "Uptrend — above 50 & 200 MA"
      : (!aboveMa50 && !aboveMa200) ? "Downtrend — below 50 & 200 MA"
      : "Mixed — between 50 & 200 MA";
    const trendStatus = (aboveMa50 && aboveMa200) ? "good" : (!aboveMa50 && !aboveMa200) ? "bad" : "watch";

    // Continuous ETF score — proportional to magnitude, not binary above/below checks.
    // Base 3 + trend(0–2) + returns(–2 to +3) + risk(0–2) → realistic range 1–10.
    const cl = (v: number) => Math.max(0, Math.min(1, v));

    // Trend (0–2): how far above MAs, not just above/below
    let trendPts = 0;
    if (ma200 != null && price > ma200) trendPts += cl((price - ma200) / ma200 / 0.15); // 0–15% above → 0–1
    if (ma50 != null && price > ma50) trendPts += cl((price - ma50) / ma50 / 0.10);     // 0–10% above → 0–1

    // Returns (–2 to +3): proportional to return size
    let returnPts = 0;
    if (ret1Y != null) returnPts += ret1Y > 0 ? cl(ret1Y / 40) * 1.5 : -cl(Math.abs(ret1Y) / 30) * 1.0;
    if (retYTD != null) returnPts += retYTD > 0 ? cl(retYTD / 30) * 0.75 : -cl(Math.abs(retYTD) / 20) * 0.5;
    if (ret6M != null) returnPts += ret6M > 0 ? cl(ret6M / 25) * 0.75 : -cl(Math.abs(ret6M) / 15) * 0.5;

    // Risk (0–2): low vol & small drawdown earn full points
    let riskPts = 2;
    if (volatility != null && volatility > 15) riskPts -= cl((volatility - 15) / 30);   // 15–45% vol → 0–1 penalty
    if (drawdown != null && drawdown < -5) riskPts -= cl((Math.abs(drawdown) - 5) / 30); // –5 to –35% → 0–1 penalty

    let score = Math.round(Math.max(0, Math.min(10, 3 + trendPts + returnPts + riskPts)) * 10) / 10;

    const pct = (v: number | null) => v == null ? "n/a" : `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`;
    const retStatus = (v: number | null) => v == null ? "watch" : v > 0 ? "good" : v < -5 ? "bad" : "watch";

    const trendScore = trendPts;
    const returnScore = Math.max(0, returnPts);
    const riskScore = riskPts;
    const etfComponents = [
      { label: "Trend (50 & 200 MA)", v: Math.round(trendScore / 2 * 10 * 10) / 10 },
      { label: "Returns (YTD / 6M / 1Y)", v: Math.round(returnScore / 3 * 10 * 10) / 10 },
      { label: "Risk (volatility & drawdown)", v: Math.round(riskScore / 2 * 10 * 10) / 10 },
    ];

    return {
      symbol: symbol.toUpperCase(),
      name,
      source: "Yahoo Finance (ETF) — price-based performance & risk",
      assetClass: "etf",
      scoreKind: "etf",
      score,
      scoreComponents: etfComponents,
      metrics: [
        price != null && { label: "Current Price", value: `${/\.(TO|V|CN|NE|TSX)$/i.test(symbol) ? "C$" : "$"}${price.toFixed(2)}`, status: "good" },
        { label: "YTD Return", value: pct(retYTD), status: retStatus(retYTD) },
        { label: "1Y · 6M Returns", value: `1Y ${pct(ret1Y)}   ·   6M ${pct(ret6M)}`, status: retStatus(ret1Y) },
        { label: "Trend", value: trendLabel, status: trendStatus },
      ].filter(Boolean),
      valuation: [
        volatility != null && { label: "Volatility (annualized)", value: `${volatility.toFixed(0)}%`, status: st(volatility, v => v < 20, v => v <= 35), context: volatility < 20 ? "Low — relatively stable" : volatility <= 35 ? "Moderate" : "High — expect larger swings" },
        drawdown != null && { label: "Drawdown from 52wk High", value: `${drawdown.toFixed(0)}%`, status: drawdown > -10 ? "good" : drawdown > -25 ? "watch" : "bad", context: drawdown > -10 ? "Near highs — strong" : drawdown > -25 ? "Off the highs" : "Deep drawdown — value or weakness" },
        ret3M != null && { label: "3-Month Momentum", value: pct(ret3M), status: retStatus(ret3M), context: "Recent price momentum" },
        rangePos != null && { label: "52-Week Range Position", value: `${rangePos.toFixed(0)}% up from low`, status: "watch", context: `Low $${week52Low.toFixed(2)} – High $${week52High.toFixed(2)}` },
        ma200 != null && { label: "200-Day MA", value: `$${ma200.toFixed(2)}`, status: aboveMa200 ? "good" : "bad", context: aboveMa200 ? "Price above — long-term uptrend" : "Price below — long-term downtrend" },
      ].filter(Boolean),
    };
  } catch {
    return null;
  }
}

// Universal price-performance rows (YTD / 1-Year / 6-Month return + trend) from the 1y chart. These
// are NOT company-specific — every stock has them — so the company X-Ray should show them too (it only
// fetched a 1-day chart before). Makes every card richer AND lets a cross-type head-to-head (e.g. ETF
// vs company) line up on these shared rows instead of showing dashes.
async function fetchPerfCells(symbol: string): Promise<AnyObj[]> {
  try {
    let result: AnyObj | null = null;
    for (const host of ["query1", "query2"]) {
      const res = await fetch(`https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1y&interval=1d`, { headers: YF_HEADERS, next: { revalidate: 3600 } }).catch(() => null);
      if (res?.ok) { result = (await res.json())?.chart?.result?.[0] ?? null; if (result) break; }
    }
    if (!result) return [];
    const meta = result.meta || {};
    const closes: number[] = (result.indicators?.quote?.[0]?.close ?? []).filter((v: unknown): v is number => typeof v === "number" && Number.isFinite(v));
    const timestamps: number[] = result.timestamp ?? [];
    if (closes.length < 30) return [];
    const last = closes[closes.length - 1];
    const price = n(meta.regularMarketPrice) ?? last;
    const retDays = (d: number): number | null => { const i = closes.length - 1 - d; return i >= 0 && closes[i] > 0 ? (last - closes[i]) / closes[i] * 100 : null; };
    const ret6M = retDays(126), ret1Y = retDays(closes.length - 1);
    const yStart = new Date(new Date().getFullYear(), 0, 1).getTime() / 1000;
    const yi = timestamps.findIndex((t) => t >= yStart);
    const retYTD = (yi >= 0 && closes[yi] > 0) ? (last - closes[yi]) / closes[yi] * 100 : null;
    const avg = (arr: number[], nn: number) => arr.length >= nn ? arr.slice(-nn).reduce((a, b) => a + b, 0) / nn : null;
    const ma50 = avg(closes, 50), ma200 = avg(closes, 200);
    const aboveMa50 = ma50 != null && price > ma50, aboveMa200 = ma200 != null && price > ma200;
    const pct = (v: number | null) => v == null ? "—" : (v >= 0 ? "+" : "") + v.toFixed(1) + "%";
    const retStatus = (v: number | null) => v == null ? "watch" : v > 0 ? "good" : "bad";
    const cells: AnyObj[] = [];
    // One compact "Returns" row (YTD · 1Y · 6M) — like the crypto card's 24h/7d/30d — instead of three
    // separate rows. Colored by the 1-year (the headline performance number).
    if (retYTD != null) cells.push({ label: "YTD Return", value: pct(retYTD), status: retStatus(retYTD) });
    const ret1Y6Mparts: string[] = [];
    if (ret1Y != null) ret1Y6Mparts.push("1Y " + pct(ret1Y));
    if (ret6M != null) ret1Y6Mparts.push("6M " + pct(ret6M));
    if (ret1Y6Mparts.length) cells.push({ label: "1Y · 6M Returns", value: ret1Y6Mparts.join("   ·   "), status: retStatus(ret1Y) });
    if (ma50 != null && ma200 != null) cells.push({ label: "Trend", value: (aboveMa50 && aboveMa200) ? "Uptrend — above 50 & 200 MA" : (!aboveMa50 && !aboveMa200) ? "Downtrend — below 50 & 200 MA" : "Mixed — between 50 & 200 MA", status: (aboveMa50 && aboveMa200) ? "good" : (!aboveMa50 && !aboveMa200) ? "bad" : "watch" });
    return cells;
  } catch { return []; }
}

// ── Per-IP rate limit for the public X-Ray (abuse-proof) ──────────────────────
// Hourly bucket counter in Supabase. FAIL-OPEN: any error — including the table not
// existing yet — allows the request, so the scan never breaks while infra catches up.
// Cap is generous (real users scanning a portfolio won't hit it); it only stops scrapers.
const RL_CAP_PER_HOUR = 100;
const RL_GLOBAL_CAP_PER_HOUR = 2000;
async function isRateLimited(req: Request): Promise<boolean> {
  try {
    const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
    const bucket = new Date().toISOString().slice(0, 13); // yyyy-mm-ddTHH
    // GLOBAL circuit breaker across all anonymous traffic — hard ceiling so a distributed flood from
    // many IPs can't run up serverless compute. Checked before the per-IP cap.
    const gkey = `GLOBAL|${bucket}`;
    const { data: g } = await sb.from("xray_rate_limits").select("count").eq("key", gkey).maybeSingle();
    const gcount = (g?.count as number | undefined) ?? 0;
    if (gcount >= RL_GLOBAL_CAP_PER_HOUR) return true;
    const ip = (req.headers.get("x-forwarded-for") || "").split(",")[0].trim();
    if (ip) {
      const key = `${ip}|${bucket}`;
      const { data } = await sb.from("xray_rate_limits").select("count").eq("key", key).maybeSingle();
      const count = (data?.count as number | undefined) ?? 0;
      if (count >= RL_CAP_PER_HOUR) return true;
      await sb.from("xray_rate_limits").upsert({ key, count: count + 1, updated_at: new Date().toISOString() }, { onConflict: "key" });
    }
    await sb.from("xray_rate_limits").upsert({ key: gkey, count: gcount + 1, updated_at: new Date().toISOString() }, { onConflict: "key" });
    return false;
  } catch {
    return false; // fail-open — never break the scan over rate-limit bookkeeping
  }
}

// ─── Append Earnings & Forward Estimate tiles after buildXrayResult ──────────

function appendEarningsAndForwardTiles(
  result: AnyObj,
  earningsHist: EarningsHistoryResult | null,
  fwdEst: ForwardEstimatesResult | null,
) {
  if (earningsHist && earningsHist.total > 0 && Array.isArray(result.metrics)) {
    const bt = earningsHist.beats, tot = earningsHist.total;
    const pct = earningsHist.avgSurprise;
    result.metrics.push(
      { label: "Earnings Track", value: `${bt}/${tot} beats`, status: bt / tot >= 0.75 ? "good" : bt / tot >= 0.5 ? "watch" : "bad", context: pct != null ? `Avg surprise ${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%` : undefined },
      { label: "Last Earnings", value: earningsHist.quarters[0] ? `${(earningsHist.quarters[0].surprise ?? 0) >= 0 ? "Beat" : "Miss"} ${earningsHist.quarters[0].surprisePercent != null ? (earningsHist.quarters[0].surprisePercent >= 0 ? "+" : "") + earningsHist.quarters[0].surprisePercent.toFixed(1) + "%" : ""}` : "—", status: earningsHist.quarters[0] && (earningsHist.quarters[0].surprise ?? 0) >= 0 ? "good" : "bad", context: earningsHist.quarters[0]?.period ? earningsHist.quarters[0].period : undefined },
    );
  }
  if (fwdEst && Array.isArray(result.valuation)) {
    if (fwdEst.nextQEps != null) {
      result.valuation.push({ label: "Next Q EPS Est", value: `$${fwdEst.nextQEps.toFixed(2)}`, status: "watch", context: fwdEst.epsRevisionUp != null ? (fwdEst.epsRevisionUp ? "↑ Revised up (90d)" : "↓ Revised down (90d)") : undefined });
    }
    if (fwdEst.fyRevenue != null) {
      const fmtRev = fwdEst.fyRevenue >= 1e9 ? `$${(fwdEst.fyRevenue / 1e9).toFixed(0)}B` : fwdEst.fyRevenue >= 1e6 ? `$${(fwdEst.fyRevenue / 1e6).toFixed(0)}M` : `$${fwdEst.fyRevenue.toFixed(0)}`;
      result.valuation.push({ label: "FY Revenue Est", value: fmtRev, status: "watch", context: "Consensus annual estimate" });
    }
  }
}

export async function GET(req: Request, context: { params: Promise<{ symbol: string }> }) {
  if (await isRateLimited(req)) {
    return NextResponse.json({ error: "Rate limit reached — please slow down and try again shortly." }, { status: 429 });
  }
  const { symbol } = await context.params;
  // Only count a real, user-initiated X-Ray scan. Background data fetches (Capital ranking, Decide's business
  // score, thesis checks) pass ?bg=1 so they don't show up in the activity feed as "X-Ray · TICKER" searches.
  if (new URL(req.url).searchParams.get("bg") !== "1") void logUsage("xray", symbol.toUpperCase());
  const rawSym = symbol.toUpperCase();
  const sym = await resolveCanadianSymbol(rawSym);

  // ETF path — detected via chart instrumentType. Self-contained; returns the same
  // shape the client renders. If not an ETF, fetchEtfXray returns null and we
  // continue to the normal stock fundamentals path below (unchanged).
  try {
    const etf = await Promise.race([
      fetchEtfXray(sym),
      new Promise<null>(resolve => setTimeout(() => resolve(null), 8000)),
    ]);
    if (etf) {
      return NextResponse.json({ ...etf, assetProfile: getAssetProfile({ isETF: true }), _summary: null }, { headers: { "Cache-Control": "no-store" } });
    }
  } catch { /* fall through to stock path */ }

  try {
    // Parallel fast path: v7/quote + Supabase cache check (~300-500ms)
    const [v7, cachedSec, shortInt, profile, perfCells, earningsHist, fwdEst] = await Promise.all([
      fetchV7Quote(sym).catch(() => null),
      getCachedSec(sym),
      fetchShortInterest(rawSym).catch(() => ({ shortShares: null, shortPctFloat: null, daysToCover: null, shortPriorMonth: null })),
      fetchYahooProfile(sym).catch(() => ({ sector: null, industry: null, name: null })),
      fetchPerfCells(sym).catch(() => [] as AnyObj[]),
      fetchEarningsHistory(sym).catch(() => null),
      fetchForwardEstimates(sym).catch(() => null),
    ]);
    // Prepend Sector/Industry cells (real, non-crumb data) so every card — including
    // Canadian listings with no fundamentals — shows what the company actually does. Then add the
    // universal YTD/1Y/6M/Trend rows right after the price so every company shows its performance.
    const profileCells = (result: AnyObj) => {
      const cells: AnyObj[] = [];
      if (profile.sector)   cells.push({ label: "Sector", value: profile.sector, status: "watch" });
      if (profile.industry) cells.push({ label: "Industry", value: profile.industry, status: "watch" });
      if (cells.length && Array.isArray(result.metrics)) result.metrics = [...cells, ...result.metrics];
      if (perfCells.length && Array.isArray(result.metrics)) {
        const priceIdx = result.metrics.findIndex((m: AnyObj) => /current price/i.test(String(m.label || "")));
        if (priceIdx >= 0) result.metrics.splice(priceIdx + 1, 0, ...perfCells);
        else result.metrics = [...result.metrics, ...perfCells];
      }
      return result;
    };

    const price = v7 ? n(v7.regularMarketPrice) : null;
    const yahCurrency = (v7?.currency as string) || (/\.(TO|V|CN|NE|TSX)$/i.test(sym) ? "CAD" : "USD");
    const name = (v7?.longName as string) || (v7?.shortName as string) || sym;

    // Cache hit — instant response with full data
    if (cachedSec) {
      const result = profileCells(buildXrayResult(sym, name, price, v7, cachedSec, profile.sector, profile.industry));
      appendEarningsAndForwardTiles(result, earningsHist, fwdEst);
      // Persist identity + score snapshot to ticker memory (fire-and-forget)
      void writeTickerMemory(sym, {
        sector: profile.sector ?? null,
        industry: profile.industry ?? null,
        xraySummary: buildXraySnippet(result, profile.sector, profile.industry),
      });
      // buildSummary merges v7 + SEC so enrichXrayScan can compute all valuation cells
      return NextResponse.json({ ...result, sector: profile.sector, industry: profile.industry, shortShares: shortInt.shortShares, shortPctFloat: shortInt.shortPctFloat, daysToCover: shortInt.daysToCover, earningsHistory: earningsHist, forwardEstimates: fwdEst, _summary: buildSummary(v7, cachedSec) }, { headers: { "Cache-Control": "no-store" } });
    }

    // Cache miss — try SEC first, fall back to Yahoo fundamentals for non-US stocks.
    // Pass the real company name so the SEC matcher can reject ticker collisions (L.TO≠Loews).
    let sec = await Promise.race([
      fetchSecFundamentals(sym, name),
      new Promise<null>(resolve => setTimeout(() => resolve(null), 12000)),
    ]);

    // For companies with a CIK, try to supplement XBRL data with the most recent
    // 6-K press release (catches capital raises / earnings filed after last annual report).
    // Only overrides cash and revenue if press-release values are available and pass
    // sanity checks. Fails silently — XBRL data is always the fallback.
    if (sec) {
      try {
        const secHeaders = { "User-Agent": "Plainview investing tool plainview@dar-fishman.com", Accept: "application/json" };
        const tickerRes = await fetch("https://www.sec.gov/files/company_tickers.json", { headers: secHeaders, next: { revalidate: 3600 } });
        if (tickerRes.ok) {
          const tickers = await tickerRes.json() as Record<string, { cik_str: number; ticker: string }>;
          const clean = sym.replace(/\..*$/, "");
          const row = Object.values(tickers).find(t => t.ticker.toUpperCase() === clean);
          if (row) {
            const cik = String(row.cik_str).padStart(10, "0");
            const xbrlDataDate: string | null = null;
            const pr = await Promise.race([
              fetchPressRelease6K(cik, xbrlDataDate),
              new Promise<PressReleaseData>(resolve => setTimeout(() => resolve({ cash: null, revenueTtm: null }), 6000)),
            ]);
            // Only apply press-release values when they differ significantly from XBRL
            // (avoids noise from minor restatements)
            if (pr.cash !== null) {
              const xbrlCash = sec.totalCash ?? 0;
              // Accept if press-release cash is at least 20% different from XBRL cash
              if (Math.abs(pr.cash - xbrlCash) / (Math.abs(xbrlCash) + 1) > 0.2) {
                sec = { ...sec, totalCash: pr.cash, netCash: pr.cash - (sec.totalDebt ?? 0) };
              }
            }
            if (pr.revenueTtm !== null) {
              const xbrlRev = sec.revenueTtm ?? 0;
              if (Math.abs(pr.revenueTtm - xbrlRev) / (Math.abs(xbrlRev) + 1) > 0.2) {
                sec = { ...sec, revenueTtm: pr.revenueTtm };
              }
            }
          }
        }
      } catch { /* silent — XBRL data stands */ }
    }

    // For US stocks with SEC data, enrich with Yahoo key-statistics fields (ROE, ROA, beta,
    // insider %, institutional %, forward P/E, PEG) that EDGAR doesn't provide.
    if (sec) {
      try {
        const yf = await Promise.race([
          fetchYahooFundamentals(sym),
          new Promise<null>(resolve => setTimeout(() => resolve(null), 5000)),
        ]);
        if (yf) {
          // Cross-source CORE financials: Yahoo's financialData.totalRevenue + grossMargins are
          // professionally aggregated and reliable for large multi-segment filers where SEC's XBRL
          // quarter-summation breaks (NVDA read 12× low, AAPL ~11% high). Prefer Yahoo for revenue +
          // gross margin; SEC remains the fallback when Yahoo lacks them (foreign/micro-caps).
          const ymGM = yf.grossMargin;
          sec = {
            ...sec,
            revenueTtm: (yf.revenueTtm != null && yf.revenueTtm > 0) ? yf.revenueTtm : sec.revenueTtm,
            grossMargin: (ymGM != null && ymGM > 0.01 && ymGM < 0.999) ? ymGM : sec.grossMargin,
            roe: yf.roe ?? sec.roe,
            roa: yf.roa ?? sec.roa,
            freeCashflow: yf.freeCashflow ?? sec.freeCashflow,
            insiderOwnership: yf.insiderOwnership ?? sec.insiderOwnership,
            institutionalOwnership: yf.institutionalOwnership ?? sec.institutionalOwnership,
            beta: yf.beta ?? sec.beta,
            forwardPE: yf.forwardPE ?? sec.forwardPE,
            pegRatio: yf.pegRatio ?? sec.pegRatio,
            evToEbitda: yf.evToEbitda ?? sec.evToEbitda,
            dividendYield: yf.dividendYield ?? sec.dividendYield,
            // Also take Yahoo shares if it's larger (more complete) than EDGAR's count
            sharesOutstanding: [sec.sharesOutstanding, yf.sharesOutstanding]
              .filter((v): v is number => v != null && v > 0)
              .reduce((a, b) => Math.max(a, b), 0) || sec.sharesOutstanding,
          };
        }
      } catch { /* silent — SEC data stands */ }
    }

    // SEC EDGAR has no data for Canadian/OTC/international stocks — try Yahoo Finance
    if (!sec) {
      sec = await Promise.race([
        fetchYahooFundamentals(sym),
        new Promise<null>(resolve => setTimeout(() => resolve(null), 6000)),
      ]);
    }

    // Yahoo also has no data (common for TSX-V micro-caps) — try Alpha Vantage direct
    if (!sec) {
      sec = await Promise.race([
        fetchAlphaFundamentals(sym),
        new Promise<null>(resolve => setTimeout(() => resolve(null), 5000)),
      ]);
    }

    // Still no data — find US OTC equivalent via Yahoo search, then fetch its financials from Yahoo
    if (!sec && name) {
      try {
        const otcSym = await findYahooOtcTicker(name, sym);
        if (otcSym) {
          sec = await Promise.race([
            fetchYahooFundamentals(otcSym),
            new Promise<null>(resolve => setTimeout(() => resolve(null), 6000)),
          ]);
        }
      } catch { /* silent */ }
    }

    if (sec) void setCachedSec(sym, sec);  // cache for next time (fire and forget)

    const result = profileCells(buildXrayResult(sym, name, price, v7, sec, profile.sector, profile.industry));
    appendEarningsAndForwardTiles(result, earningsHist, fwdEst);
    // Persist identity + score snapshot to ticker memory (fire-and-forget)
    void writeTickerMemory(sym, {
      sector: profile.sector ?? null,
      industry: profile.industry ?? null,
      xraySummary: buildXraySnippet(result, profile.sector, profile.industry),
    });
    return NextResponse.json({ ...result, sector: profile.sector, industry: profile.industry, shortShares: shortInt.shortShares, shortPctFloat: shortInt.shortPctFloat, daysToCover: shortInt.daysToCover, earningsHistory: earningsHist, forwardEstimates: fwdEst, _summary: buildSummary(v7, sec) }, { headers: { "Cache-Control": "no-store" } });

  } catch (error) {
    return NextResponse.json(
      { symbol: sym, source: "x-ray failed", score: null, metrics: [], valuation: [], _summary: null, warning: error instanceof Error ? error.message : "X-Ray failed" },
      { status: 502 }
    );
  }
}
