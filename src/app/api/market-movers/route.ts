import { NextResponse } from "next/server";

// Public, GLOBAL, free market lists for the X-Ray landing (top picks / trending / watching / candidates).
// Cost design: one set of Yahoo Finance screener calls per TTL, cached in-memory and served to EVERY
// anonymous visitor from that cache. 10k visitors = the same few upstream calls per interval, not per
// visit. Yahoo screeners need no API key. Net cost ≈ zero. Serves stale on any upstream hiccup.
export const dynamic = "force-dynamic";
export const maxDuration = 20;

const TTL = 20 * 60 * 1000; // 20 minutes — the lists are "what's popular", they don't need to be realtime
let _cache: { data: unknown; ts: number } | null = null;

const YF_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36 Plainview/1.0",
  Accept: "application/json,text/plain,*/*",
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function yfScreen(scrId: string, count: number): Promise<any[]> {
  for (const host of ["query1", "query2"]) {
    try {
      const r = await fetch(
        `https://${host}.finance.yahoo.com/v1/finance/screener/predefined/saved?scrIds=${scrId}&count=${count}`,
        { headers: YF_HEADERS, cache: "no-store" }
      );
      if (!r.ok) continue;
      const j = await r.json();
      const quotes = j?.finance?.result?.[0]?.quotes;
      if (Array.isArray(quotes) && quotes.length) return quotes;
    } catch { continue; }
  }
  return [];
}

export async function GET() {
  if (_cache && Date.now() - _cache.ts < TTL) {
    return NextResponse.json(_cache.data, { headers: { "cache-control": "public, max-age=600" } });
  }
  try {
    const [gainers, losers, actives] = await Promise.all([
      yfScreen("day_gainers", 14),
      yfScreen("day_losers", 10),
      yfScreen("most_actives", 18),
    ]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ok = (q: any) => q && q.symbol && Number.isFinite(q.regularMarketPrice) && !/[=^]/.test(q.symbol);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pick = (q: any) => ({
      symbol: q.symbol,
      name: q.shortName || q.longName || q.symbol,
      price: q.regularMarketPrice,
      changePct: Number.isFinite(q.regularMarketChangePercent) ? q.regularMarketChangePercent : null,
    });
    const g = gainers.filter(ok), l = losers.filter(ok), a = actives.filter(ok);
    const topPicks = g.slice(0, 3).map(pick);                                   // biggest movers today
    const trending = a.slice(0, 6).map((q) => q.symbol);                        // chips
    const watching = a.slice(0, 6).map(pick);                                   // popular (abstract, not personal)
    // Candidates heatmap — a VARIED mix (gainers + losers + most-active) so the treemap has range and
    // both green & red. weight = volume (tile size), changePct = color.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const seen: Record<string, boolean> = {};
    const candidates: Array<{ symbol: string; name: string; changePct: number; weight: number | null }> = [];
    for (const q of [...g.slice(0, 5), ...l.slice(0, 4), ...a.slice(0, 10)]) {
      if (seen[q.symbol]) continue;
      seen[q.symbol] = true;
      candidates.push({
        symbol: q.symbol,
        name: q.shortName || q.longName || q.symbol,
        changePct: Number.isFinite(q.regularMarketChangePercent) ? q.regularMarketChangePercent : 0,
        weight: Number.isFinite(q.regularMarketVolume) ? q.regularMarketVolume : null,
      });
      if (candidates.length >= 15) break;
    }
    const data = { topPicks, trending, watching, candidates, asOf: Date.now() };
    // Only cache a result that actually has data — otherwise keep trying (and serve old cache if present).
    if (topPicks.length || trending.length) _cache = { data, ts: Date.now() };
    else if (_cache) return NextResponse.json(_cache.data);
    return NextResponse.json(data, { headers: { "cache-control": "public, max-age=600" } });
  } catch {
    if (_cache) return NextResponse.json(_cache.data);
    return NextResponse.json({ topPicks: [], trending: [], watching: [], candidates: [], asOf: Date.now() });
  }
}
