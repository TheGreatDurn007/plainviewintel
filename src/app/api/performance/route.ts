import { NextResponse } from "next/server";

function finite(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function pctChange(from: number | null, to: number | null): number | null {
  if (!from || !to || from === 0) return null;
  return ((to - from) / Math.abs(from)) * 100;
}

// Downsample a close series to ~n evenly-spaced points (for the share-card mini chart). Keeps the
// last point exact so the line ends on the latest price.
function downsample(arr: number[], n: number): number[] {
  if (arr.length <= n) return arr;
  const step = (arr.length - 1) / (n - 1);
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(arr[Math.round(i * step)]);
  return out;
}

async function fetchPerf(symbol: string): Promise<{
  symbol: string;
  name: string | null;
  d1: number | null;
  d5: number | null;
  mo1: number | null;
  mo3: number | null;
  currentPrice: number | null;
  currentVolume: number | null;
  avgVolume: number | null;
  volumeRatio: number | null;
  spark: number[] | null;
}> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=3mo&includePrePost=false`;
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36 Plainview/1.0",
      "Accept": "application/json,text/plain,*/*",
    },
    cache: "no-store",
  });

  if (!res.ok) throw new Error(`${symbol} returned ${res.status}`);
  const json = await res.json();
  const result = json?.chart?.result?.[0];
  const meta = result?.meta || {};
  const closes: (number | null)[] = result?.indicators?.quote?.[0]?.close || [];
  const volumes: (number | null)[] = result?.indicators?.quote?.[0]?.volume || [];

  const validCloses: number[] = closes
    .map((c) => finite(c))
    .filter((c): c is number => c !== null);

  const validVolumes: number[] = volumes
    .map((v) => finite(v))
    .filter((v): v is number => v !== null && v > 0);

  const current = finite(meta.regularMarketPrice) ?? validCloses[validCloses.length - 1] ?? null;
  const prev = finite(meta.previousClose) ?? (validCloses.length >= 2 ? validCloses[validCloses.length - 2] : null);

  const d5from = validCloses.length >= 6 ? validCloses[validCloses.length - 6] : null;
  const mo1from = validCloses.length >= 22 ? validCloses[validCloses.length - 22] : validCloses[0] ?? null;
  const mo3from = validCloses[0] ?? null;

  // Volume: today vs 20-day average
  const currentVolume = finite(meta.regularMarketVolume) ?? (validVolumes.length ? validVolumes[validVolumes.length - 1] : null);
  const avgVolumeSamples = validVolumes.slice(-21, -1); // last 20 days excluding today
  const avgVolume = avgVolumeSamples.length
    ? avgVolumeSamples.reduce((a, b) => a + b, 0) / avgVolumeSamples.length
    : null;
  const volumeRatio = currentVolume && avgVolume && avgVolume > 0
    ? currentVolume / avgVolume
    : null;

  return {
    symbol,
    name: (meta.longName || meta.shortName || null) as string | null,
    currentPrice: current,
    d1: pctChange(prev, current),
    d5: pctChange(d5from, current),
    mo1: pctChange(mo1from, current),
    mo3: pctChange(mo3from, current),
    currentVolume,
    avgVolume,
    volumeRatio,
    spark: validCloses.length >= 2 ? downsample(validCloses, 40) : null,
  };
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const symbols = [...new Set(
    (url.searchParams.get("symbols") || "")
      .split(",")
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean)
  )].slice(0, 80);

  if (!symbols.length) return NextResponse.json({ performance: [] });

  const performance = await Promise.all(
    symbols.map(async (symbol) => {
      try {
        return await fetchPerf(symbol);
      } catch {
        return { symbol, name: null, d1: null, d5: null, mo1: null, mo3: null, currentPrice: null, currentVolume: null, avgVolume: null, volumeRatio: null, spark: null };
      }
    })
  );

  return NextResponse.json({ performance, updatedAt: new Date().toISOString() });
}
