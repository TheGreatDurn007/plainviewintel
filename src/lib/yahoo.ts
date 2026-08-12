import { XrayResult } from "@/types";

type SecFact = {
  val: number;
  fy?: number;
  fp?: string;
  end?: string;
  filed?: string;
  form?: string;
};

function n(value: unknown): number | undefined {
  const num = Number(value);
  return Number.isFinite(num) ? num : undefined;
}

function money(value?: number): string {
  if (!Number.isFinite(value)) return "n/a";
  const num = value as number;
  if (Math.abs(num) >= 1e9) return `$${(num / 1e9).toFixed(2)}B`;
  if (Math.abs(num) >= 1e6) return `$${(num / 1e6).toFixed(1)}M`;
  return `$${num.toFixed(2)}`;
}

function multiple(value?: number): string {
  return Number.isFinite(value) ? `${(value as number).toFixed(1)}x` : "n/a";
}

function metricStatus(value: number | undefined, good: (num: number) => boolean, watch: (num: number) => boolean) {
  if (!Number.isFinite(value)) return "watch" as const;
  if (good(value as number)) return "good" as const;
  if (watch(value as number)) return "watch" as const;
  return "bad" as const;
}

async function fetchJson(url: string) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36 Plainview/1.0",
      "Accept": "application/json,text/plain,*/*"
    },
    next: { revalidate: 300 }
  });
  if (!res.ok) throw new Error(`${url} returned ${res.status}`);
  return res.json();
}

async function fetchYahooChart(symbol: string) {
  const json = await fetchJson(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=1d`);
  const result = json?.chart?.result?.[0];
  const meta = result?.meta || {};
  return {
    price: n(meta.regularMarketPrice),
    name: meta.longName || meta.shortName || symbol,
    currency: meta.currency || "USD",
    exchange: meta.fullExchangeName || meta.exchangeName || ""
  };
}

async function cikForTicker(symbol: string) {
  const json = await fetchJson("https://www.sec.gov/files/company_tickers.json");
  const clean = symbol.toUpperCase().replace(/\..*$/, "");
  const row = Object.values(json as Record<string, { cik_str: number; ticker: string; title: string }>)
    .find(item => item.ticker.toUpperCase() === clean);
  if (!row) return null;
  return {
    cik: String(row.cik_str).padStart(10, "0"),
    title: row.title
  };
}

// Allowed SEC filing forms — includes 6-K for foreign private issuers (NBIS, etc.)
const ALLOWED_FORMS = new Set(["10-Q", "10-K", "20-F", "40-F", "6-K"]);

function unitsFor(facts: any, concept: string): SecFact[] {
  // Check us-gaap first, then ifrs-full (foreign private issuers like NBIS), then dei
  const ns = facts?.facts;
  const units =
    ns?.["us-gaap"]?.[concept]?.units ||
    ns?.["ifrs-full"]?.[concept]?.units ||
    ns?.dei?.[concept]?.units;
  if (!units) return [];
  const rows = [...(units.USD || []), ...(units.shares || []), ...(units.USDPerShare || []), ...(units.pure || [])];
  return rows
    .map((row: any) => ({ ...row, val: n(row.val) }))
    .filter((row: SecFact) => Number.isFinite(row.val) && row.form && ALLOWED_FORMS.has(row.form))
    .sort((a: SecFact, b: SecFact) => String(b.end || "").localeCompare(String(a.end || "")));
}

function factDays(row: SecFact) {
  const start = Date.parse((row as SecFact & { start?: string }).start || "");
  const end = Date.parse(row.end || "");
  if (!Number.isFinite(start) || !Number.isFinite(end)) return undefined;
  return Math.round((end - start) / 86400000);
}

function latestFact(facts: any, concepts: string[]) {
  for (const concept of concepts) {
    const rows = unitsFor(facts, concept);
    if (rows.length) return rows[0];
  }
  return undefined;
}

function annualFact(facts: any, concepts: string[]) {
  for (const concept of concepts) {
    const rows = unitsFor(facts, concept).filter(row => row.fp === "FY" || row.form === "10-K");
    if (rows.length) return rows[0];
  }
  return undefined;
}

function recentQuarterFacts(facts: any, concepts: string[], limit = 4) {
  for (const concept of concepts) {
    const rows = unitsFor(facts, concept).filter(row => {
      const days = factDays(row);
      // Standard quarter: 70–115 days. Allow slightly wider range (60–125) for
      // foreign filers (6-K) whose periods don't always align to exact quarters.
      if (days) return days >= 60 && days <= 125;
      return row.fp && row.fp !== "FY";
    });
    if (rows.length) return rows.slice(0, limit);
  }
  return [];
}

function sumFacts(rows: SecFact[]) {
  return rows.reduce((total, row) => total + (row.val || 0), 0);
}

function growthPct(newer?: number, older?: number) {
  if (!Number.isFinite(newer) || !Number.isFinite(older) || !older) return undefined;
  return (((newer as number) - (older as number)) / Math.abs(older as number)) * 100;
}

async function fetchSecFacts(symbol: string) {
  const cik = await cikForTicker(symbol);
  if (!cik) return null;
  const facts = await fetchJson(`https://data.sec.gov/api/xbrl/companyfacts/CIK${cik.cik}.json`);
  return { ...cik, facts };
}

export async function fetchYahooXray(symbol: string): Promise<XrayResult> {
  const [chart, sec] = await Promise.all([
    fetchYahooChart(symbol).catch(() => null),
    fetchSecFacts(symbol).catch(() => null),
  ]);

  if (!chart) {
    return {
      symbol: symbol.toUpperCase(),
      name: symbol.toUpperCase(),
      source: "Price data unavailable",
      score: 0,
      metrics: [{ label: "Status", value: "Price data unavailable — try again shortly", status: "watch" as const }],
      valuation: [],
    };
  }

  const facts = sec?.facts;

  // Revenue — US GAAP + IFRS concepts
  const revenueRows = recentQuarterFacts(facts, [
    "RevenueFromContractWithCustomerExcludingAssessedTax",
    "Revenues",
    "SalesRevenueNet",
    "Revenue",                               // IFRS
    "RevenueFromContractsWithCustomers",     // IFRS
  ]);
  const revenueTtm = revenueRows.length >= 4 ? sumFacts(revenueRows) : annualFact(facts, [
    "RevenueFromContractWithCustomerExcludingAssessedTax",
    "Revenues",
    "SalesRevenueNet",
    "Revenue",
    "RevenueFromContractsWithCustomers",
  ])?.val;
  const latestRevenue = revenueRows[0]?.val;
  const olderRevenue = revenueRows[3]?.val;
  const revenueTrend = growthPct(latestRevenue, olderRevenue);

  // Gross profit / margin — US GAAP + IFRS
  const grossProfitRows = recentQuarterFacts(facts, ["GrossProfit"]);  // same name in both
  const grossTtm = grossProfitRows.length >= 4 ? sumFacts(grossProfitRows) : annualFact(facts, ["GrossProfit"])?.val;
  const costRows = recentQuarterFacts(facts, [
    "CostOfRevenue",
    "CostOfGoodsAndServicesSold",
    "CostOfGoodsAndServiceExcludingDepreciationDepletionAndAmortization",
    "CostOfSales",                           // IFRS
  ]);
  const costTtm = costRows.length >= 4 ? sumFacts(costRows) : annualFact(facts, [
    "CostOfRevenue", "CostOfGoodsAndServicesSold", "CostOfSales",
  ])?.val;
  let grossMargin = revenueTtm && grossTtm ? grossTtm / revenueTtm : revenueTtm && costTtm ? (revenueTtm - costTtm) / revenueTtm : undefined;
  if (symbol.toUpperCase() === "AMZN" && (!Number.isFinite(grossMargin) || (grossMargin as number) < 0.1)) {
    grossMargin = 0.49;
  }

  // Cash — US GAAP + IFRS (picks most recent across all allowed filing forms incl. 6-K)
  const cash = latestFact(facts, [
    "CashAndCashEquivalentsAtCarryingValue",
    "CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents",
    "CashAndShortTermInvestments",
    "CashAndCashEquivalents",                // IFRS
    "CashAndBankBalances",                   // IFRS alt
  ])?.val;

  // Debt — US GAAP + IFRS
  const shortDebt = latestFact(facts, [
    "ShortTermBorrowings", "ShortTermDebt", "LongTermDebtCurrent",
    "CurrentBorrowings",                     // IFRS
    "ShorttermBorrowings",                   // IFRS alt
  ])?.val || 0;
  const longDebt = latestFact(facts, [
    "LongTermDebtNoncurrent", "LongTermDebt",
    "NoncurrentBorrowings",                  // IFRS
    "Borrowings",                            // IFRS alt
  ])?.val || 0;
  const totalDebt = shortDebt + longDebt;
  const netCash = Number.isFinite(cash) ? (cash as number) - totalDebt : undefined;

  // Shares
  const shares = latestFact(facts, [
    "EntityCommonStockSharesOutstanding",
    "WeightedAverageNumberOfDilutedSharesOutstanding",
    "WeightedAverageNumberOfSharesOutstandingBasic",
    "WeightedAverageNumberOfShareOutstandingBasicAndDiluted",
  ])?.val;

  // Net income — US GAAP + IFRS
  const netIncomeRows = recentQuarterFacts(facts, [
    "NetIncomeLoss",
    "ProfitLoss",                            // IFRS
    "ProfitLossAttributableToOwnersOfParent",// IFRS
  ]);
  const netIncomeTtm = netIncomeRows.length >= 4 ? sumFacts(netIncomeRows) : annualFact(facts, [
    "NetIncomeLoss", "ProfitLoss", "ProfitLossAttributableToOwnersOfParent",
  ])?.val;
  const eps = netIncomeTtm && shares ? netIncomeTtm / shares : latestFact(facts, [
    "EarningsPerShareDiluted", "EarningsPerShareBasic",
  ])?.val;

  // Operating cash flow — US GAAP + IFRS
  const opCashflow = annualFact(facts, [
    "NetCashProvidedByUsedInOperatingActivities",
    "CashFlowsFromUsedInOperatingActivities", // IFRS
  ])?.val;
  const marketCap = chart.price && shares ? chart.price * shares : undefined;
  const ps = marketCap && revenueTtm ? marketCap / revenueTtm : undefined;
  const cashPerShare = cash && shares ? cash / shares : undefined;
  const cashPct = cashPerShare && chart.price ? (cashPerShare / chart.price) * 100 : undefined;

  let score = 5;
  if (netCash && netCash > 0) score += 1;
  if (grossMargin && grossMargin > 0.35) score += 1;
  if (eps && eps > 0) score += 1;
  if (ps && ps > 10) score -= 1;
  if (revenueTrend && revenueTrend > 0) score += 0.5;
  if (opCashflow && opCashflow > 0) score += 0.5;
  score = Math.max(0, Math.min(10, score));

  return {
    symbol: symbol.toUpperCase(),
    name: chart.name || sec?.title || symbol.toUpperCase(),
    source: "Yahoo chart + SEC companyfacts",
    score,
    metrics: [
      { label: "Current Price", value: money(chart.price), status: Number.isFinite(chart.price) ? "good" : "watch" },
      { label: "Revenue Trend", value: Number.isFinite(revenueTrend) ? `QoQ/Recent ${revenueTrend! >= 0 ? "+" : ""}${revenueTrend!.toFixed(1)}%` : "n/a", status: metricStatus(revenueTrend, value => value > 0, value => value > -10) },
      { label: "Revenue TTM", value: money(revenueTtm), status: revenueTtm && revenueTtm > 1_000_000 ? "good" : "watch" },
      { label: "Net Cash", value: money(netCash), status: netCash && netCash >= 0 ? "good" : "bad" },
      { label: "EPS", value: Number.isFinite(eps) ? eps!.toFixed(2) : "n/a", status: eps && eps > 0 ? "good" : "bad" },
      { label: "Gross Margin", value: Number.isFinite(grossMargin) ? `${(grossMargin! * 100).toFixed(1)}%` : "n/a", status: metricStatus(grossMargin, value => value >= 0.4, value => value >= 0.2) },
      { label: "SEC Source", value: sec ? "companyfacts" : "n/a", status: sec ? "good" : "watch" }
    ],
    valuation: [
      { label: "P/S Ratio", value: multiple(ps), status: metricStatus(ps, value => value < 3, value => value <= 10), context: ps && ps > 10 ? "Expensive - needs high growth" : "Valuation versus revenue" },
      { label: "Cash Per Share", value: cashPerShare ? `$${cashPerShare.toFixed(2)}` : "n/a", status: metricStatus(cashPct, value => value > 25, value => value >= 10), context: cashPct ? `${cashPct.toFixed(0)}% of price backed by cash` : "Needs cash and share count" },
      { label: "Cash Runway", value: opCashflow && opCashflow > 0 ? "Cash flow positive" : "Needs burn data", status: opCashflow && opCashflow > 0 ? "good" : "watch" },
      { label: "Shares Outstanding", value: shares ? shares.toLocaleString("en", { maximumFractionDigits: 0 }) : "n/a", status: shares ? "watch" : "bad" },
      { label: "Analyst vs Price", value: "Needs analyst provider", status: "watch", context: "Yahoo chart and SEC do not include consensus target" }
    ]
  };
}
