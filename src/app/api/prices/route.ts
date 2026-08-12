import { NextResponse } from "next/server";

// Force dynamic — never let Vercel edge-cache this route. Crypto prices must be live.
export const dynamic = "force-dynamic";

// CoinGecko ID map — mirrors the client-side CRYPTO_IDS for server-side use.
// CoinGecko is the authoritative real-time source for crypto prices; Yahoo has lag.
const CRYPTO_ID_MAP: Record<string, string> = {
  XRP:'ripple', HBAR:'hedera-hashgraph', XLM:'stellar', BTC:'bitcoin', ETH:'ethereum',
  SOL:'solana', XDC:'xdce-crowd-sale', ADA:'cardano', DOGE:'dogecoin', LINK:'chainlink',
  AVAX:'avalanche-2', MATIC:'matic-network', POL:'polygon-ecosystem-token',
  BNB:'binancecoin', TON:'the-open-network', DOT:'polkadot', BCH:'bitcoin-cash',
  LTC:'litecoin', SHIB:'shiba-inu', NEAR:'near', APT:'aptos', SUI:'sui', ICP:'internet-computer',
  ATOM:'cosmos', ETC:'ethereum-classic', FIL:'filecoin', ARB:'arbitrum', OP:'optimism',
  IMX:'immutable-x', INJ:'injective-protocol', RNDR:'render-token', RENDER:'render-token',
  ALGO:'algorand', VET:'vechain', GRT:'the-graph', AAVE:'aave', UNI:'uniswap',
  TAO:'bittensor', FLR:'flare-networks', KAS:'kaspa', TRX:'tron',
};

/** Batch CoinGecko simple/price for all crypto symbols in one or two API calls (USD + CAD). */
async function coinGeckoBatchPrices(symbols: string[]): Promise<Map<string, PriceRow>> {
  const results = new Map<string, PriceRow>();

  const byVs: Record<string, { id: string; symbol: string }[]> = { usd: [], cad: [] };
  for (const sym of symbols) {
    const m = sym.match(/^([A-Z0-9]+)-(USD|CAD)$/);
    if (!m) continue;
    const id = CRYPTO_ID_MAP[m[1]];
    if (!id) continue;
    byVs[m[2].toLowerCase()].push({ id, symbol: sym });
  }

  for (const [vs, pairs] of Object.entries(byVs)) {
    if (!pairs.length) continue;
    const ids = [...new Set(pairs.map(p => p.id))].join(",");
    try {
      const res = await fetch(
        `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=${vs}&include_24hr_change=true`,
        { cache: "no-store", headers: { Accept: "application/json" } }
      );
      if (!res.ok) continue;
      const data = await res.json() as Record<string, Record<string, number>>;
      for (const { id, symbol } of pairs) {
        const price = data?.[id]?.[vs];
        if (!Number.isFinite(price) || price <= 0) continue;
        const change = data?.[id]?.[`${vs}_24h_change`] ?? null;
        const nowSec = Math.floor(Date.now() / 1000);
        results.set(symbol, {
          symbol,
          price,
          regularMarketPrice: price,
          changePercent: Number.isFinite(change) ? change : null,
          currency: vs.toUpperCase(),
          source: "CoinGecko",
          session: "regular",
          timestamp: nowSec,
          regularMarketTime: nowSec, // enables "as of HH:MM ET" display on crypto price cells
        });
      }
    } catch { /* fall through — Yahoo handles it */ }
  }
  return results;
}

type PriceSession = "regular" | "pre-market" | "after-hours" | "previous close";

type PriceRow = {
  symbol: string;
  price: number | null;
  regularMarketPrice?: number | null;
  changePercent?: number | null;
  currency: string;
  name?: string;
  source: string;
  session: PriceSession;
  timestamp?: number | null;
  regularMarketTime?: number | null;
  marketState?: string;
};

function finite(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Like finite() but treats 0 (and negatives) as missing — Yahoo returns 0 for illiquid stocks with no trade */
function positiveFinite(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

const YF_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36";

// Yahoo returns 429/401 to datacenter IPs (Vercel) unless the request carries a consent cookie.
// We fetch that cookie once and cache it for the lifetime of the warm lambda, refreshing on expiry.
let _yfCookie: { value: string; at: number } | null = null;
async function getYahooCookie(): Promise<string> {
  if (_yfCookie && Date.now() - _yfCookie.at < 30 * 60 * 1000) return _yfCookie.value;
  for (const seed of ["https://fc.yahoo.com", "https://finance.yahoo.com"]) {
    try {
      const res = await fetch(seed, {
        headers: { "User-Agent": YF_UA, Accept: "text/html,application/xhtml+xml" },
        cache: "no-store",
        redirect: "manual",
      });
      const raw = res.headers.get("set-cookie") || "";
      // Keep only name=value pairs (strip Path/Expires/etc attributes).
      const cookie = raw
        .split(/,(?=[^ ;]+=)/)
        .map(c => c.split(";")[0].trim())
        .filter(Boolean)
        .join("; ");
      if (cookie) {
        _yfCookie = { value: cookie, at: Date.now() };
        return cookie;
      }
    } catch { /* try next seed */ }
  }
  return _yfCookie?.value || "";
}

/**
 * Fetch Yahoo chart JSON with retries. Yahoo blocks bare datacenter requests (Vercel shares IPs),
 * so we carry a consent cookie, rotate query1/query2, and add a cache-buster. This is the ONLY price
 * source — it must not come back empty, so we retry hard and re-seed the cookie if it goes stale.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function yahooChartJson(symbol: string): Promise<any> {
  const hosts = ["query1", "query2", "query1", "query2"];
  let lastStatus = 0;
  let cookie = await getYahooCookie();
  for (let attempt = 0; attempt < hosts.length; attempt++) {
    const host = hosts[attempt];
    const url = `https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1m&range=1d&includePrePost=true&_=${Date.now()}`;
    try {
      const res = await fetch(url, {
        headers: {
          "User-Agent": YF_UA,
          "Accept": "application/json,text/plain,*/*",
          "Accept-Language": "en-US,en;q=0.9",
          ...(cookie ? { Cookie: cookie } : {}),
        },
        cache: "no-store",
      });
      if (res.ok) return await res.json();
      lastStatus = res.status;
      // 401/429 → cookie likely rejected/expired; force a fresh one before the next attempt.
      if (res.status === 401 || res.status === 429) {
        _yfCookie = null;
        cookie = await getYahooCookie();
      }
    } catch {
      /* network error — rotate to next host */
    }
  }
  throw new Error(`${symbol} returned ${lastStatus || "no response"} after ${hosts.length} attempts`);
}

async function yahooChart(symbol: string): Promise<PriceRow> {
  const json = await yahooChartJson(symbol);
  const result = json?.chart?.result?.[0];
  const meta = result?.meta || {};
  const closes = result?.indicators?.quote?.[0]?.close || [];
  const timestamps = result?.timestamp || [];
  let latestMinute: number | null = null;
  let latestTimestamp: number | null = null;
  for (let i = closes.length - 1; i >= 0; i--) {
    const close = finite(closes[i]);
    if (close !== null) {
      latestMinute = close;
      latestTimestamp = finite(timestamps[i]);
      break;
    }
  }

  const regularMarketPrice = positiveFinite(meta.regularMarketPrice);
  const previousClose = positiveFinite(meta.previousClose) ?? positiveFinite(meta.chartPreviousClose);
  const preMarketPrice = positiveFinite(meta.preMarketPrice);
  const postMarketPrice = positiveFinite(meta.postMarketPrice);
  const regularMarketTime = finite(meta.regularMarketTime);
  const preMarketTime = finite(meta.preMarketTime);
  const postMarketTime = finite(meta.postMarketTime);

  // Also treat 0 as missing in intraday minute closes
  if (latestMinute !== null && latestMinute <= 0) latestMinute = null;

  let session: PriceSession = "regular";
  let price = latestMinute ?? regularMarketPrice ?? previousClose;
  let timestamp = latestTimestamp ?? regularMarketTime;

  if (postMarketPrice !== null && postMarketPrice > 0) {
    session = "after-hours";
    price = postMarketPrice;
    timestamp = postMarketTime ?? timestamp;
  } else if (preMarketPrice !== null && preMarketPrice > 0) {
    session = "pre-market";
    price = preMarketPrice;
    timestamp = preMarketTime ?? timestamp;
  } else if (latestMinute === null && regularMarketPrice === null && previousClose !== null) {
    session = "previous close";
    price = previousClose;
    timestamp = regularMarketTime;
  }

  // Day change %: prefer Yahoo's official figure, but it's often MISSING from the chart meta. When it
  // is, compute it from the displayed price vs previous close — so the % is ALWAYS fresh and consistent
  // with the price we show, and the UI never has to fall back to a stale cached d1 (the +9.6%-vs-reality bug).
  const officialChange = finite(meta.regularMarketChangePercent);
  const changePercent = (officialChange != null)
    ? officialChange
    : (previousClose !== null && previousClose > 0 && price !== null ? ((price - previousClose) / previousClose) * 100 : null);

  return {
    symbol,
    price,
    regularMarketPrice,
    changePercent,
    currency: meta.currency || "USD",
    name: meta.longName || meta.shortName,
    source: "Yahoo chart",
    session,
    timestamp,
    regularMarketTime,
    marketState: String(meta.marketState || ""),
  };
}

/** Real-time OTC quote from OTC Markets (same data as otcmarkets.com). */
async function otcMarketsPrice(symbol: string): Promise<PriceRow | null> {
  const clean = symbol.replace(/[^A-Z0-9]/g, "");
  if (!clean) return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(
      `https://backend.otcmarkets.com/otcapi/stock/trade/inside/${encodeURIComponent(clean)}?market=OTC`,
      {
        headers: { "User-Agent": "Mozilla/5.0 Plainview/1.0", "Accept": "application/json" },
        cache: "no-store",
        signal: controller.signal,
      }
    );
    if (!res.ok) return null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const d: any = await res.json();
    const price = positiveFinite(d.lastSale) ?? positiveFinite(d.askPrice) ?? positiveFinite(d.bidPrice);
    if (!price) return null;
    return {
      symbol,
      price,
      regularMarketPrice: price,
      changePercent: finite(d.percentageChange),
      currency: "USD",
      name: d.companyName,
      source: "OTC Markets",
      session: "regular" as const,
      timestamp: d.lastSaleTime ? Math.floor(new Date(d.lastSaleTime).getTime() / 1000) : null,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/** True OTC symbols: no exchange suffix, not crypto — try OTC Markets first for real-time data. */
function isLikelyOTC(symbol: string): boolean {
  return !symbol.includes(".") && !symbol.includes("-") && symbol.length <= 6;
}

/**
 * Normalize warrant/unit/right suffixes to Yahoo Finance format.
 * Brokerages use TICKER.WS / TICKER.WT / TICKER.WR; Yahoo is inconsistent — some
 * warrants trade as TICKER-WT (e.g. INFQ-WT), others as TICKERW (e.g. PSNYW).
 * Returns an array of candidates to try in order.
 */
function warrantCandidates(symbol: string): string[] | null {
  const m = symbol.match(/^([A-Z0-9]+)[.\-](WS|WT|WR|RT)$/i);
  if (!m) return null;
  const b = m[1].toUpperCase();
  return [`${b}-WT`, `${b}W`, `${b}WT`, `${b}-WS`];
}

function normalizeForYahoo(symbol: string): string {
  return symbol
    .replace(/\.U$/i,  "U");  // units
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const symbols = [...new Set((url.searchParams.get("symbols") || "")
    .split(",")
    .map(symbol => symbol.trim().toUpperCase())
    .filter(Boolean))]
    .slice(0, 120);

  if (!symbols.length) return NextResponse.json({ prices: [] });

  // Step 1: Yahoo Finance is the primary source for ALL symbols including crypto pairs
  // (XRP-CAD, XLM-USD etc.). Yahoo matches what users see on Yahoo Finance and what the
  // Edit modal's "Lookup Ticker + Price" returns. CoinGecko is kept as fallback only for
  // crypto symbols Yahoo can't price.
  const priceOne = async (symbol: string): Promise<PriceRow> => {
    if (isLikelyOTC(symbol)) {
      const otc = await otcMarketsPrice(symbol);
      if (otc?.price) return otc;
    }
    try {
      const wCandidates = warrantCandidates(symbol);
      if (wCandidates) {
        for (const c of wCandidates) {
          try {
            const row = await yahooChart(c);
            if (row?.price != null) return { ...row, symbol };
          } catch { /* try next */ }
        }
      }
      const yahooSymbol = normalizeForYahoo(symbol);
      const row = await yahooChart(yahooSymbol);
      return { ...row, symbol };
    } catch (error) {
      return {
        symbol,
        price: null,
        currency: "USD",
        source: error instanceof Error ? error.message : "price failed",
        session: "previous close",
      } satisfies PriceRow;
    }
  };

  // Throttle to a small concurrency: firing every symbol at Yahoo in parallel from one datacenter IP
  // trips its rate limiter (429 → empty prices). A pool of 4 stays live and accurate for full watchlists.
  const CONCURRENCY = 4;
  const yahooPrices: PriceRow[] = new Array(symbols.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, symbols.length) }, async () => {
      while (cursor < symbols.length) {
        const i = cursor++;
        yahooPrices[i] = await priceOne(symbols[i]);
      }
    })
  );

  // Step 2: CoinGecko fills in any crypto symbol Yahoo couldn't price.
  const yahooMissed = symbols.filter((s, i) => {
    const row = yahooPrices[i];
    return /^[A-Z0-9]+-(?:USD|CAD)$/.test(s) && !(Number.isFinite(row?.price) && (row?.price ?? 0) > 0);
  });
  const cgPrices = yahooMissed.length ? await coinGeckoBatchPrices(yahooMissed) : new Map<string, PriceRow>();

  const prices = [
    ...cgPrices.values(),
    ...yahooPrices,
  ];

  return NextResponse.json({ prices, updatedAt: new Date().toISOString() }, {
    headers: { "Cache-Control": "no-store, no-cache, must-revalidate" },
  });
}
