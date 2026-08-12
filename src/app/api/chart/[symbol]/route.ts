import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const UA = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36 Plainview/1.0",
  Accept: "application/json,text/plain,*/*",
};

const RANGES: Record<string, { range: string; interval: string; revalidate: number }> = {
  "1D":  { range: "1d",  interval: "5m",  revalidate: 60 },
  "5D":  { range: "5d",  interval: "15m", revalidate: 120 },
  "1M":  { range: "1mo", interval: "1d",  revalidate: 300 },
  "3M":  { range: "3mo", interval: "1d",  revalidate: 300 },
  "6M":  { range: "6mo", interval: "1d",  revalidate: 600 },
  "1Y":  { range: "1y",  interval: "1d",  revalidate: 600 },
};

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ symbol: string }> }
) {
  const { symbol: rawSymbol } = await params;
  // Warrants: brokerages use .WS / .WT; Yahoo uses TICKER-WT
  const wm = rawSymbol.match(/^([A-Z]+)[.\-](WS|WT|WR|RT)$/i);
  const symbol = wm ? `${wm[1].toUpperCase()}-WT` : rawSymbol;
  const url = new URL(_req.url);
  const rangeKey = (url.searchParams.get("r") || "1Y").toUpperCase();
  const cfg = RANGES[rangeKey];
  if (!cfg) {
    return NextResponse.json({ error: "Invalid range" }, { status: 400 });
  }

  for (const host of ["query1", "query2"]) {
    try {
      const res = await fetch(
        `https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${cfg.range}&interval=${cfg.interval}&includePrePost=false`,
        { headers: UA, next: { revalidate: cfg.revalidate } }
      );
      if (!res.ok) continue;
      const json = await res.json();
      const result = json?.chart?.result?.[0];
      if (!result) continue;

      const meta = result.meta;
      const timestamps = result.timestamp || [];
      const quotes = result.indicators?.quote?.[0] || {};
      const opens: (number | null)[] = quotes.open || [];
      const highs: (number | null)[] = quotes.high || [];
      const lows: (number | null)[] = quotes.low || [];
      const closes: (number | null)[] = quotes.close || [];
      const volumes: (number | null)[] = quotes.volume || [];

      const r2 = (n: number) => Math.round(n * 100) / 100;
      const points: { t: number; o: number; h: number; l: number; c: number; v: number }[] = [];
      for (let i = 0; i < timestamps.length; i++) {
        const c = closes[i];
        if (c != null && Number.isFinite(c)) {
          const o = opens[i] != null && Number.isFinite(opens[i]) ? opens[i]! : c;
          const h = highs[i] != null && Number.isFinite(highs[i]) ? highs[i]! : c;
          const l = lows[i] != null && Number.isFinite(lows[i]) ? lows[i]! : c;
          points.push({ t: timestamps[i], o: r2(o), h: r2(h), l: r2(l), c: r2(c), v: volumes[i] ?? 0 });
        }
      }

      return NextResponse.json({
        symbol: meta.symbol || symbol,
        currency: meta.currency || "USD",
        previousClose: meta.chartPreviousClose ?? meta.previousClose ?? null,
        points,
      }, {
        headers: { "Cache-Control": `private, max-age=${cfg.revalidate}` },
      });
    } catch {
      continue;
    }
  }

  return NextResponse.json({ error: "Chart data unavailable" }, { status: 502 });
}
