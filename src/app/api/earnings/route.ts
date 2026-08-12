import { NextResponse } from "next/server";
import { readCachedEarnings, writeCachedEarnings } from "@/lib/ticker-context";

type EarningsRow = {
  symbol: string;
  earningsDate: string | null;
  epsEstimate: number | null;
  revenueEstimate: number | null;
};

function finite(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36 Plainview/1.0",
  Accept: "application/json,text/plain,*/*",
};

// Mirror the PROVEN path from /api/quote earningsData: try BOTH query1 AND query2 (the BB bug — the catalyst
// calendar hit query1 only; query1 401s for some listings like BB.TO with no failover, so it fell through to
// Finnhub's stripped "BB" which has no date, and BB vanished. Decide worked because /api/quote fails over.)
// Query the FULL symbol (BB.TO) — Yahoo keys earnings to the listing, not the stripped root.
async function yahooEarnings(symbol: string): Promise<EarningsRow | null> {
  for (const host of ["query1", "query2"]) {
    try {
      const res = await fetch(
        `https://${host}.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=calendarEvents,earnings`,
        { headers: HEADERS, next: { revalidate: 3600 } }
      );
      if (!res.ok) continue; // 401/404 on this host → try the next one (the failover that was missing)
      const json = await res.json();
      const calEvents = json?.quoteSummary?.result?.[0]?.calendarEvents;
      const earningsDates: Array<{ raw: number }> = calEvents?.earnings?.earningsDate ?? [];
      const now = Date.now() / 1000;
      const upcomingRaw = earningsDates.map((d) => d.raw).filter((ts) => ts > now - 86400).sort((a, b) => a - b)[0];
      if (!upcomingRaw) return null; // host answered but no upcoming date → done, don't double-fetch
      return {
        symbol,
        earningsDate: new Date(upcomingRaw * 1000).toISOString(),
        epsEstimate: finite(calEvents?.earnings?.epsEstimate?.avg?.raw),
        revenueEstimate: finite(calEvents?.earnings?.revenueEstimate?.avg?.raw),
      };
    } catch { /* try next host */ }
  }
  return null;
}

// Finnhub fallback — Yahoo's calendarEvents is crumb-gated and usually empty. Free tier, needs a date range.
// Retries once on a 429 (rate-limit): the batch can otherwise drop symbols that got throttled (the BB bug —
// it showed in Decide's single fetch but vanished from the catalyst calendar's concurrent burst).
async function finnhubEarnings(symbol: string): Promise<EarningsRow | null> {
  const key = process.env.FINNHUB_API_KEY; if (!key) return null;
  const from = new Date().toISOString().slice(0, 10);
  const to = new Date(Date.now() + 120 * 86400000).toISOString().slice(0, 10);
  const sym = symbol.replace(/\..*$/, "");
  const u = `https://finnhub.io/api/v1/calendar/earnings?symbol=${encodeURIComponent(sym)}&from=${from}&to=${to}&token=${key}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(u, { cache: "no-store" }); // no-store so a rate-limited FAILURE can't get cached for 1h (the BB bug — a cached 429 defeated the retry)
      if (res.status === 429) { await new Promise((r) => setTimeout(r, 1200)); continue; } // throttled → back off, retry once
      if (!res.ok) return null;
      const j = await res.json();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const cal: any[] = Array.isArray(j?.earningsCalendar) ? j.earningsCalendar : [];
      const next = cal.filter((e) => typeof e?.date === "string" && e.date >= from).sort((a, b) => String(a.date).localeCompare(String(b.date)))[0];
      if (!next) return null;
      return { symbol, earningsDate: new Date(next.date + "T00:00:00Z").toISOString(), epsEstimate: finite(next.epsEstimate), revenueEstimate: finite(next.revenueEstimate) };
    } catch { return null; }
  }
  return null;
}

async function fetchEarnings(symbol: string): Promise<EarningsRow> {
  const y = await yahooEarnings(symbol).catch(() => null);
  if (y && y.earningsDate) { void writeCachedEarnings(y); return y; }
  const f = await finnhubEarnings(symbol);
  if (f && f.earningsDate) { void writeCachedEarnings(f); return f; }
  // Live sources came up empty — likely a throttled burst. Fall back to the last real date we ever saw
  // (the BB flicker fix: a date doesn't disappear just because Finnhub rate-limited this one reload).
  const cached = await readCachedEarnings(symbol).catch(() => null);
  if (cached) return cached;
  return f || { symbol, earningsDate: null, epsEstimate: null, revenueEstimate: null };
}

export const maxDuration = 30;

// Bounded-concurrency map — fire at most `limit` requests at once so Finnhub's free tier doesn't 429 the batch
// (the BB bug: an all-at-once Promise.all silently dropped throttled symbols).
async function mapLimit<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  const worker = async () => { while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx]); } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const symbols = [
    ...new Set(
      (url.searchParams.get("symbols") || "")
        .split(",")
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean)
    ),
  ].slice(0, 20);

  if (!symbols.length) return NextResponse.json({ earnings: [] });

  const earnings = await mapLimit(symbols, 3, async (symbol) => {
    try {
      return await fetchEarnings(symbol);
    } catch {
      return { symbol, earningsDate: null, epsEstimate: null, revenueEstimate: null };
    }
  });

  // Only return rows with an upcoming date — filter out noise
  const filtered = earnings.filter((r) => r.earningsDate !== null);

  return NextResponse.json({ earnings: filtered, updatedAt: new Date().toISOString() });
}
