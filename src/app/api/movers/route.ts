import { NextResponse } from "next/server";

type Mover = {
  symbol: string;
  name: string;
  price: number | null;
  changePercent: number | null;
  volume: number | null;
  avgVolume: number | null;
  volumeRatio: number | null;
};

function finite(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export async function GET() {
  try {
    // Yahoo Finance most-active screener
    const url =
      "https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved" +
      "?scrIds=most_actives&count=25&start=0&fields=symbol,shortName,regularMarketPrice,regularMarketChangePercent,regularMarketVolume,averageDailyVolume3Month";

    const res = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36 Plainview/1.0",
        Accept: "application/json,text/plain,*/*",
      },
      next: { revalidate: 300 },
    });

    if (!res.ok) throw new Error(`Yahoo screener ${res.status}`);

    const json = await res.json();
    const quotes: Record<string, unknown>[] =
      json?.finance?.result?.[0]?.quotes ?? [];

    const movers: Mover[] = quotes.map((q) => {
      const vol = finite(q.regularMarketVolume);
      const avg = finite(q.averageDailyVolume3Month);
      return {
        symbol: String(q.symbol ?? ""),
        name: String(q.shortName ?? q.longName ?? q.symbol ?? ""),
        price: finite(q.regularMarketPrice),
        changePercent: finite(q.regularMarketChangePercent),
        volume: vol,
        avgVolume: avg,
        volumeRatio: vol && avg && avg > 0 ? vol / avg : null,
      };
    });

    return NextResponse.json({ movers, updatedAt: new Date().toISOString() });
  } catch (e) {
    // Fallback: return empty so the UI shows "no data" gracefully
    return NextResponse.json({ movers: [], error: String(e), updatedAt: new Date().toISOString() });
  }
}
