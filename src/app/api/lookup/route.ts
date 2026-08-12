import { NextResponse } from "next/server";

type LookupResult = {
  symbol: string;
  name: string;
  exchange: string;
  currency: string;
  price: number | null;
};

async function getChart(symbol: string) {
  const res = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=1d`, {
    headers: {
      "User-Agent": "Plainview Command Center",
      "Accept": "application/json,text/plain,*/*"
    },
    next: { revalidate: 60 }
  });
  if (!res.ok) return null;
  const json = await res.json();
  const meta = json?.chart?.result?.[0]?.meta || {};
  return {
    price: (Number.isFinite(Number(meta.regularMarketPrice)) && Number(meta.regularMarketPrice) > 0) ? Number(meta.regularMarketPrice) : (Number.isFinite(Number(meta.previousClose)) && Number(meta.previousClose) > 0 ? Number(meta.previousClose) : null),
    currency: meta.currency || "USD",
    exchange: meta.fullExchangeName || meta.exchangeName || ""
  };
}

function exchangeLabel(symbol: string, exchDisp: string, exchange: string, currency: string): string {
  const sym = symbol.toUpperCase();
  const exch = String(exchDisp || exchange || "").toUpperCase();
  if (sym.endsWith(".TO") || exch.includes("TORONTO") || exchange === "TOR") return "TSX CAD";
  if (sym.endsWith(".V")  || exch.includes("VENTURE") || exchange === "VAN") return "TSX-V CAD";
  if (exch.includes("NASDAQ") || ["NMS","NGM","NCM"].includes(exchange)) return "NASDAQ USD";
  if (exch.includes("NYSE") || exchange === "NYQ") return "NYSE USD";
  if (exch.includes("AMEX") || exchange === "ASE") return "NYSE American USD";
  if (currency === "CAD") return "TSX CAD";
  return exchDisp || exchange || "";
}

async function yahooSearch(query: string): Promise<LookupResult | null> {
  for (const host of ["query1", "query2"]) {
    try {
      const res = await fetch(
        `https://${host}.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(query)}&quotesCount=6&newsCount=0`,
        { headers: { "User-Agent": "Plainview/1.0", "Accept": "application/json" }, next: { revalidate: 60 } }
      );
      if (!res.ok) continue;
      const json = await res.json();
      const quotes: any[] = Array.isArray(json?.quotes) ? json.quotes : [];
      const clean = query.trim().toUpperCase();
      const quote =
        quotes.find(q => String(q.symbol || "").toUpperCase() === clean) ||
        quotes.find(q => ["EQUITY","ETF","MUTUALFUND","CRYPTOCURRENCY"].includes(String(q.quoteType || ""))) ||
        quotes[0];
      if (!quote?.symbol) return null;
      const chart = await getChart(String(quote.symbol));
      const sym = String(quote.symbol).toUpperCase();
      const cur = chart?.currency || quote.currency || "USD";
      return {
        symbol: sym,
        name: quote.longname || quote.shortname || quote.name || sym,
        exchange: exchangeLabel(sym, quote.exchDisp || "", quote.exchange || "", cur),
        currency: cur,
        price: chart?.price ?? null,
      };
    } catch { /* try next host */ }
  }
  return null;
}

// Try an exact chart fetch first (fastest path when we know the exact Yahoo symbol)
async function tryExact(symbol: string): Promise<LookupResult | null> {
  const chart = await getChart(symbol);
  if (!chart?.price || chart.price <= 0) return null;
  return {
    symbol: symbol.toUpperCase(),
    name: symbol.toUpperCase(),
    exchange: exchangeLabel(symbol, "", "", chart.currency),
    currency: chart.currency,
    price: chart.price,
  };
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const query = (url.searchParams.get("query") || "").trim().toUpperCase();
  const currency = (url.searchParams.get("currency") || "USD").toUpperCase();
  if (!query) return NextResponse.json({ error: "Missing query." }, { status: 400 });

  // Build candidate list: prefer currency-appropriate suffix variants first
  const candidates: string[] = [];
  if (query.includes(".")) {
    candidates.push(query); // already has suffix — trust the user
  } else if (currency === "CAD") {
    candidates.push(query + ".TO", query + ".V", query);
  } else {
    candidates.push(query, query + ".TO");
  }

  // 1. Try exact chart fetches for each candidate (fast, no search needed)
  for (const candidate of candidates) {
    const exact = await tryExact(candidate);
    if (exact) {
      // Enrich with name from search if the exact path just returned the raw symbol
      if (exact.name === candidate.toUpperCase()) {
        const searched = await yahooSearch(candidate);
        if (searched?.name) exact.name = searched.name;
      }
      return NextResponse.json(exact);
    }
  }

  // 2. Fall back to Yahoo search for any candidate
  for (const candidate of candidates) {
    const result = await yahooSearch(candidate);
    if (result) return NextResponse.json(result);
  }

  return NextResponse.json(
    { error: `No match found for "${query}". Try the full Yahoo symbol, e.g. USA.TO, TSLA, or BTC-USD.` },
    { status: 404 }
  );
}
