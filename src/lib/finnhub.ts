// ─── Finnhub: free, datacenter-friendly second source ─────────────────────────
// Yahoo's "enriched" endpoints (analyst targets, beta, margins) are crumb-protected and BLOCKED from
// Vercel's datacenter IPs. Finnhub is not — its free tier (~60 req/min) reliably serves quotes, company
// metrics, and analyst price targets from a server. We use it as the unblocked fallback for exactly the
// fields Yahoo's block costs us. Everything here is KEY-GATED: with no FINNHUB_API_KEY it returns null and
// the callers behave exactly as before (zero regression). Long cache TTLs since these change slowly.
const BASE = "https://finnhub.io/api/v1";

function key(): string | null {
  return process.env.FINNHUB_API_KEY || null;
}
export function finnhubEnabled(): boolean {
  return !!key();
}
function num(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function posNum(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Analyst consensus price targets — the clearest gap Yahoo's crumb block leaves (used by the Buy Zone nudge). */
export async function fetchFinnhubPriceTarget(symbol: string): Promise<{ mean: number | null; high: number | null; low: number | null } | null> {
  const k = key();
  if (!k) return null;
  try {
    const r = await fetch(`${BASE}/stock/price-target?symbol=${encodeURIComponent(symbol)}&token=${k}`, { next: { revalidate: 43200 } });
    if (!r.ok) return null;
    const j = await r.json();
    const mean = posNum(j?.targetMean);
    if (!mean) return null;
    return { mean, high: posNum(j?.targetHigh), low: posNum(j?.targetLow) };
  } catch { return null; }
}

/** Company fundamental metrics (beta, margins, P/S, 52-week range) — a cross-source for validation. */
export async function fetchFinnhubMetrics(symbol: string): Promise<{
  beta: number | null;
  grossMargin: number | null;       // fraction (0–1)
  psTtm: number | null;
  week52High: number | null;
  week52Low: number | null;
} | null> {
  const k = key();
  if (!k) return null;
  try {
    const r = await fetch(`${BASE}/stock/metric?symbol=${encodeURIComponent(symbol)}&metric=all&token=${k}`, { next: { revalidate: 43200 } });
    if (!r.ok) return null;
    const m = (await r.json())?.metric || {};
    const gm = num(m.grossMarginTTM); // Finnhub reports margins in PERCENT
    return {
      beta: num(m.beta),
      grossMargin: gm != null ? gm / 100 : null,
      psTtm: posNum(m.psTTM),
      week52High: posNum(m["52WeekHigh"]),
      week52Low: posNum(m["52WeekLow"]),
    };
  } catch { return null; }
}

/** Real-time-ish quote — price backup for when Yahoo's chart endpoint is unavailable. */
export async function fetchFinnhubQuote(symbol: string): Promise<{ price: number | null; previousClose: number | null; changePercent: number | null } | null> {
  const k = key();
  if (!k) return null;
  try {
    const r = await fetch(`${BASE}/quote?symbol=${encodeURIComponent(symbol)}&token=${k}`, { next: { revalidate: 30 } });
    if (!r.ok) return null;
    const j = await r.json();
    const price = posNum(j?.c);
    if (!price) return null;
    return { price, previousClose: posNum(j?.pc), changePercent: num(j?.dp) };
  } catch { return null; }
}
