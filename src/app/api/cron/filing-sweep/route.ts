import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { extractDeterministic, type FilingInsight } from "@/lib/filing-extract";
import { recordSignalObservations, type ObservationInput } from "@/lib/nexus-memory";
import { isAdmin } from "@/lib/usage-log";

// ════════════════════════════════════════════════════════════════════════════════
// Filing Sweep Cron — deterministic, $0 per-ticker SEC filing parser.
// Collects all tracked tickers (positions + watchlist), checks which ones LACK
// filing_insights, fetches their latest 10-K/10-Q from EDGAR, runs the regex
// extractor, and stores the structured facts. No AI = no cost = safe at any scale.
// ════════════════════════════════════════════════════════════════════════════════

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const SEC_HEADERS = {
  "User-Agent": "Plainview investing tool plainview@dar-fishman.com",
  Accept: "text/html,application/xml,text/xml,*/*",
};

const BUCKET = "plainview-state";

function admin() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );
}

async function authorized(req: Request): Promise<boolean> {
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.get("authorization") || "";
  if (secret && auth === `Bearer ${secret}`) return true;
  return await isAdmin().catch(() => false);
}

// ── Collect all unique tickers across all users ──────────────────────────────
async function collectAllTickers(): Promise<string[]> {
  const sb = admin();
  const tickers = new Set<string>();

  // List all user state files
  const { data: files } = await sb.storage.from(BUCKET).list("", { limit: 500 });
  if (!files) return [];

  // Each user directory has a state.json with positions + watchlist
  const userDirs = files.filter(f => !f.name.startsWith("_") && !f.name.includes("."));
  for (const dir of userDirs) {
    try {
      const { data, error } = await sb.storage.from(BUCKET).download(`${dir.name}/state.json`);
      if (error || !data) continue;
      const state = JSON.parse(await data.text());

      // Positions
      const positions = Array.isArray(state?.positions) ? state.positions : [];
      for (const p of positions) {
        if (p && typeof p.id === "string") tickers.add(p.id.toUpperCase());
      }

      // Watchlist
      const watchlist = Array.isArray(state?.watchlist) ? state.watchlist : [];
      for (const w of watchlist) {
        if (typeof w === "string") tickers.add(w.toUpperCase());
        else if (w && typeof w.id === "string") tickers.add(w.id.toUpperCase());
        else if (w && typeof w.ticker === "string") tickers.add(w.ticker.toUpperCase());
      }
    } catch { /* skip malformed state */ }
  }

  return [...tickers].filter(t => /^[A-Z]{1,6}(\.[A-Z]{1,2})?$/.test(t)); // US equities (including BRK.B etc)
}

// ── Check which tickers already have filing_insights ─────────────────────────
async function tickersWithInsights(): Promise<Set<string>> {
  const sb = admin();
  const { data } = await sb
    .from("filing_insights")
    .select("ticker")
    .limit(2000);
  const seen = new Set<string>();
  if (data) for (const r of data as Array<{ ticker: string }>) seen.add(r.ticker);
  return seen;
}

// ── SEC ticker→CIK lookup (fetched ONCE per run, shared across all tickers) ──
type TickerCikMap = Record<string, { cik_str: number; ticker: string }>;
let _tickerMapCache: TickerCikMap | null = null;

async function loadTickerMap(): Promise<TickerCikMap | null> {
  if (_tickerMapCache) return _tickerMapCache;
  try {
    const res = await fetch("https://www.sec.gov/files/company_tickers.json", { headers: SEC_HEADERS });
    if (!res.ok) return null;
    _tickerMapCache = await res.json() as TickerCikMap;
    return _tickerMapCache;
  } catch {
    return null;
  }
}

// ── Look up CIK and find latest 10-K or 10-Q filing from EDGAR ──────────────
type FilingRef = {
  form: string;
  date: string;
  accession: string;
  primaryDocument: string;
  cik: string;
};

async function findLatestFiling(ticker: string): Promise<FilingRef | null> {
  if (/\.(TO|V|CN|NE|TSX)$/i.test(ticker)) return null;

  try {
    const tickerMap = await loadTickerMap();
    if (!tickerMap) return null;

    const clean = ticker.replace(/\..*$/, "").toUpperCase();
    const match = Object.values(tickerMap).find(t => t.ticker.toUpperCase() === clean);
    if (!match) return null;
    const cik = String(match.cik_str).padStart(10, "0");

    const subRes = await fetch(`https://data.sec.gov/submissions/CIK${cik}.json`, {
      headers: SEC_HEADERS, cache: "no-store",
    });
    if (!subRes.ok) return null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sub = await subRes.json() as any;
    const forms: string[] = sub.filings?.recent?.form ?? [];
    const dates: string[] = sub.filings?.recent?.filingDate ?? [];
    const accNums: string[] = sub.filings?.recent?.accessionNumber ?? [];
    const primaryDocs: string[] = sub.filings?.recent?.primaryDocument ?? [];

    for (let i = 0; i < forms.length; i++) {
      if (/^10-[KQ](\/A)?$/.test(forms[i])) {
        return {
          form: forms[i].replace("/A", ""),
          date: dates[i],
          accession: accNums[i],
          primaryDocument: primaryDocs[i],
          cik: cik.replace(/^0+/, ""),
        };
      }
    }
    return null;
  } catch {
    return null;
  }
}

// ── Fetch filing HTML from EDGAR ─────────────────────────────────────────────
async function fetchFilingHtml(ref: FilingRef): Promise<string | null> {
  const dashless = ref.accession.replace(/-/g, "");
  const url = `https://www.sec.gov/Archives/edgar/data/${ref.cik}/${dashless}/${ref.primaryDocument}`;
  try {
    const res = await fetch(url, { headers: SEC_HEADERS });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

// ── Store extracted insights ─────────────────────────────────────────────────
async function storeInsights(
  ticker: string, filingType: string, filingDate: string,
  accession: string, insights: FilingInsight[]
): Promise<number> {
  if (!insights.length) return 0;
  const sb = admin();
  const rows = insights.map(i => ({
    ticker: ticker.toUpperCase(),
    filing_type: filingType,
    filing_date: filingDate,
    accession,
    category: i.category,
    fact: i.fact,
    numeric_value: i.numeric_value,
    quote: i.quote,
    source_section: i.source_section,
  }));

  const { error } = await sb.from("filing_insights").upsert(rows, {
    onConflict: "accession,category,fact",
    ignoreDuplicates: true,
  });
  if (error) {
    console.error(`[filing-sweep] store error for ${ticker}:`, error.message);
    return 0;
  }
  return rows.length;
}

// ── Pipe to NEXUS signal observations ────────────────────────────────────────
function insightsToSignals(ticker: string, insights: FilingInsight[], filingType: string): ObservationInput[] {
  return insights
    .filter(i => i.numeric_value != null)
    .map(i => ({
      signal_type: `filing_${i.category}`,
      numeric_value: i.numeric_value!,
      value: { fact: i.fact, filing_type: filingType, category: i.category },
      source: "SEC EDGAR",
      trust_tier: "authoritative" as const,
    }));
}

// ── Main handler ─────────────────────────────────────────────────────────────
export async function GET(req: Request) {
  if (!(await authorized(req))) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const started = Date.now();
  const results: Array<{ ticker: string; status: string; insights?: number }> = [];

  // 1. Collect all tracked tickers
  const allTickers = await collectAllTickers();
  if (!allTickers.length) {
    return NextResponse.json({ message: "No tracked tickers found", elapsed: Date.now() - started });
  }

  // 2. Check which already have filing_insights
  const existing = await tickersWithInsights();
  const missing = allTickers.filter(t => !existing.has(t));

  if (!missing.length) {
    return NextResponse.json({
      message: "All tracked tickers already have filing insights",
      tracked: allTickers.length,
      existing: existing.size,
      elapsed: Date.now() - started,
    });
  }

  // 3. Process missing tickers (sequential to respect SEC rate limits — 10 req/sec max)
  // Cap at 10 per run to stay within Vercel function timeout
  const batch = missing.slice(0, 10);

  for (const ticker of batch) {
    // Guard: don't run past 240s (leave 60s margin for cleanup)
    if (Date.now() - started > 240_000) {
      results.push({ ticker, status: "skipped_timeout" });
      continue;
    }

    try {
      // Rate limit: 100ms between EDGAR requests
      await new Promise(r => setTimeout(r, 100));

      const ref = await findLatestFiling(ticker);
      if (!ref) {
        results.push({ ticker, status: "no_filing_found" });
        continue;
      }

      // Check if this specific accession is already stored
      const sb = admin();
      const { data: acc } = await sb
        .from("filing_insights")
        .select("id")
        .eq("accession", ref.accession)
        .limit(1);
      if (acc && acc.length > 0) {
        results.push({ ticker, status: "already_stored" });
        continue;
      }

      await new Promise(r => setTimeout(r, 100));
      const html = await fetchFilingHtml(ref);
      if (!html || html.length < 1000) {
        results.push({ ticker, status: "html_too_short" });
        continue;
      }

      // Deterministic extraction — $0
      const insights = extractDeterministic(html, ticker, ref.form);
      if (!insights.length) {
        results.push({ ticker, status: "no_insights_extracted" });
        continue;
      }

      // Store to filing_insights
      const stored = await storeInsights(ticker, ref.form, ref.date, ref.accession, insights);

      // Pipe to NEXUS as tier-1
      const signals = insightsToSignals(ticker, insights, ref.form);
      if (signals.length > 0) {
        void recordSignalObservations(ticker, signals);
      }

      results.push({ ticker, status: "parsed", insights: stored });
    } catch (err) {
      results.push({ ticker, status: `error: ${err instanceof Error ? err.message : String(err)}` });
    }
  }

  const parsed = results.filter(r => r.status === "parsed").length;
  return NextResponse.json({
    message: `Filing sweep complete: ${parsed}/${batch.length} tickers parsed`,
    tracked: allTickers.length,
    alreadyHaveInsights: existing.size,
    missing: missing.length,
    processed: batch.length,
    results,
    elapsed: Date.now() - started,
  });
}
