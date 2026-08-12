import { NextRequest, NextResponse } from "next/server";

const STOCKTWITS_BASE = "https://api.stocktwits.com/api/2";

async function fetchStocktwits(path: string) {
  const response = await fetch(`${STOCKTWITS_BASE}${path}`, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36",
      "Accept": "application/json,text/plain,*/*",
      "Referer": "https://stocktwits.com/",
      "Origin": "https://stocktwits.com",
    },
    next: { revalidate: 900 }, // 15 min cache — reduces rate limiting from Vercel IPs
  });

  if (response.status === 404) {
    return NextResponse.json({ error: "not_found" }, { status: 200 });
  }

  if (response.status === 429) {
    return NextResponse.json({ error: "rate_limited" }, { status: 200 });
  }

  if (!response.ok) {
    return NextResponse.json({ error: response.status === 403 ? "stocktwits_blocked" : "stocktwits_unavailable", status: response.status }, { status: 200 });
  }

  return NextResponse.json(await response.json());
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const trending = searchParams.get("trending");
  const symbol = searchParams.get("symbol")?.trim();

  if (trending) {
    return fetchStocktwits("/trending/symbols.json");
  }

  if (!symbol) {
    return NextResponse.json({ error: "symbol_required" }, { status: 400 });
  }

  const clean = symbol.toUpperCase().replace(/[^A-Z0-9._-]/g, "");
  return fetchStocktwits(`/streams/symbol/${encodeURIComponent(clean)}.json`);
}


