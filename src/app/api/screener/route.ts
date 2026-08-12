import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

// Curated universe — the top liquid names worth screening. Crypto + ETFs are excluded (no DCF).
const UNIVERSE = [
  "AAPL","MSFT","GOOGL","AMZN","NVDA","META","TSLA","AVGO","AMD","NFLX","ADBE","CRM","ORCL","INTC","CSCO",
  "QCOM","TXN","IBM","NOW","AMAT","PLTR","SOFI","HOOD","COIN","UBER","ABNB","DKNG","SHOP","SQ","PYPL",
  "MU","ARM","SMCI","MRVL","ASML","TSM","ON","LRCX","KLAC",
  "JPM","BAC","WFC","GS","MS","V","MA","BLK","COF",
  "UNH","JNJ","LLY","PFE","MRK","ABBV","TMO","ABT","BMY","AMGN","GILD","MRNA","CVS",
  "WMT","COST","HD","LOW","NKE","SBUX","MCD","TGT","DIS","KO","PEP","PG","CMG","LULU",
  "XOM","CVX","COP","SLB","BA","CAT","GE","HON","LMT","RTX","DE","UPS","F","GM",
  "T","VZ","TMUS","CMCSA",
  "PANW","CRWD","ZS","NET","SNOW","DDOG","MDB","WDAY","HUBS","TTD",
  "ENPH","FSLR",
  "SPOT","MELI","BABA",
  "CELH","MNST","CAVA",
  "CRSP","EXAS",
  "PATH","AI","SOUN","IONQ",
];

type ScreenerRow = {
  ticker: string;
  name: string;
  sector: string;
  industry: string;
  price: number | null;
  dayChangePct: number | null;
  score: number | null;
  scoreKind: string | null;
  grossMargin: number | null;
  roe: number | null;
  roa: number | null;
  eps: number | null;
  netCash: number | null;
  revGrowth: number | null;
  ps: number | null;
  pe: number | null;
  forwardPE: number | null;
  peg: number | null;
  opCashflow: number | null;
  fcf: number | null;
  revTtm: number | null;
};

let _cache: { rows: ScreenerRow[]; ts: number } | null = null;
const CACHE_TTL = 3600_000; // 1 hour

function parseNum(v: string | undefined | null): number | null {
  if (v == null) return null;
  const n = parseFloat(String(v).replace(/[,$%x]/g, ""));
  return isFinite(n) ? n : null;
}

function findMetric(arr: any[], label: string): string | null {
  const m = arr.find((x: any) => x?.label === label);
  return m ? String(m.value) : null;
}

function rowFromXray(ticker: string, d: any): ScreenerRow | null {
  if (!d || d.scoreUnavailable) return null;
  const m = d.metrics || [];
  const v = d.valuation || [];
  const price = parseNum(findMetric(m, "Current Price"));
  const score = typeof d.score === "number" ? d.score : null;
  if (score == null && price == null) return null;

  const grossMarginStr = findMetric(m, "Gross Margin");
  const grossMargin = grossMarginStr ? parseNum(grossMarginStr) : null;
  const gm = grossMargin != null ? (grossMargin > 1 ? grossMargin / 100 : grossMargin) : null;

  const roeStr = findMetric(m, "Return on Equity");
  const roeRaw = roeStr ? parseNum(roeStr) : null;
  const roe = roeRaw != null ? (roeRaw > 1 || roeRaw < -1 ? roeRaw / 100 : roeRaw) : null;

  const roaStr = findMetric(m, "Return on Assets");
  const roaRaw = roaStr ? parseNum(roaStr) : null;
  const roa = roaRaw != null ? (roaRaw > 1 || roaRaw < -1 ? roaRaw / 100 : roaRaw) : null;

  const epsStr = findMetric(m, "EPS");
  const eps = epsStr ? parseNum(epsStr) : null;

  const netCashStr = findMetric(m, "Net Cash");
  const netCash = netCashStr ? parseNum(netCashStr.replace(/[BMK]/g, (c: string) => ({ B: "e9", M: "e6", K: "e3" }[c] || ""))) : null;

  const revTrendStr = findMetric(m, "Revenue Trend");
  const revGrowthMatch = revTrendStr?.match(/([\-+]?\d+\.?\d*)%/);
  const revGrowth = revGrowthMatch ? parseFloat(revGrowthMatch[1]) / 100 : null;

  const revTtmStr = findMetric(m, "Revenue TTM");

  const ps = parseNum(findMetric(v, "P/S Ratio"));
  const pe = parseNum(findMetric(v, "P/E Ratio"));
  const forwardPE = parseNum(findMetric(v, "Forward P/E"));
  const peg = parseNum(findMetric(v, "PEG Ratio"));

  const cashRunway = findMetric(v, "Cash Runway");
  const opCashflow = cashRunway === "Cash flow positive" ? 1 : cashRunway === "Negative cash flow" ? -1 : null;

  return {
    ticker,
    name: d.name || ticker,
    sector: d.sector || "",
    industry: d.industry || "",
    price,
    dayChangePct: typeof d.dayChangePct === "number" ? d.dayChangePct : null,
    score,
    scoreKind: d.scoreKind || null,
    grossMargin: gm,
    roe,
    roa,
    eps,
    netCash,
    revGrowth,
    ps,
    pe,
    forwardPE,
    peg,
    opCashflow,
    fcf: null, // future: derive from SEC data for DCF
    revTtm: revTtmStr ? parseNum(revTtmStr.replace(/\$/, "").replace(/[BMK]/g, (c: string) => ({ B: "e9", M: "e6", K: "e3" }[c] || ""))) : null,
  };
}

async function fetchUniverse(origin: string): Promise<ScreenerRow[]> {
  const CONCURRENCY = 8;
  const rows: ScreenerRow[] = [];
  const queue = [...UNIVERSE];

  async function worker() {
    while (queue.length) {
      const ticker = queue.shift()!;
      try {
        const r = await fetch(`${origin}/api/xray/${encodeURIComponent(ticker)}?bg=1`, {
          headers: { "x-screener": "1" },
          signal: AbortSignal.timeout(12_000),
        });
        if (!r.ok) continue;
        const d = await r.json();
        const row = rowFromXray(ticker, d);
        if (row) rows.push(row);
      } catch {
        // skip failed tickers
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  return rows;
}

type Filter = "undervalued" | "moat" | "profitable" | "balance" | "growth" | "universe";

function filterRows(rows: ScreenerRow[], filter: Filter): ScreenerRow[] {
  switch (filter) {
    case "undervalued":
      return rows
        .filter(r => r.pe != null && r.pe > 0 && r.pe < 20 && r.score != null && r.score >= 4)
        .sort((a, b) => (a.pe ?? 999) - (b.pe ?? 999));
    case "moat":
      return rows
        .filter(r => (r.grossMargin ?? 0) >= 0.4 && (r.roe ?? 0) >= 0.15 && r.score != null && r.score >= 6)
        .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    case "profitable":
      return rows
        .filter(r => (r.eps ?? 0) > 0 && (r.grossMargin ?? 0) >= 0.3 && (r.roa ?? 0) >= 0.05)
        .sort((a, b) => (b.grossMargin ?? 0) - (a.grossMargin ?? 0));
    case "balance":
      return rows
        .filter(r => r.opCashflow != null && r.opCashflow > 0 && r.score != null && r.score >= 4)
        .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    case "growth":
      return rows
        .filter(r => (r.revGrowth ?? 0) > 0.05 && r.forwardPE != null && r.forwardPE > 0 && r.forwardPE < 40)
        .sort((a, b) => (b.revGrowth ?? 0) - (a.revGrowth ?? 0));
    case "universe":
      return rows.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  }
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const filter = (url.searchParams.get("filter") || "undervalued") as Filter;
  const refresh = url.searchParams.get("refresh") === "1";

  const origin = url.origin;

  if (!_cache || Date.now() - _cache.ts > CACHE_TTL || refresh) {
    try {
      const rows = await fetchUniverse(origin);
      _cache = { rows, ts: Date.now() };
    } catch (e) {
      if (_cache) {
        // serve stale on error
      } else {
        return NextResponse.json({ error: "Failed to build screener" }, { status: 500 });
      }
    }
  }

  const filtered = filterRows(_cache!.rows, filter);
  return NextResponse.json({
    filter,
    total: filtered.length,
    universe: _cache!.rows.length,
    ts: _cache!.ts,
    rows: filter === "universe" ? filtered : filtered.slice(0, 25),
  }, {
    headers: { "Cache-Control": "private, max-age=300" },
  });
}
