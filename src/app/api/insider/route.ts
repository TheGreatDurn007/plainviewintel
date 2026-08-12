import { NextResponse } from "next/server";

// Reads recent SEC Form 4 (insider transaction) filings and classifies whether
// insiders are net BUYING, net SELLING, just HOLDING (grants/options, no open-market
// conviction trade), or whether there's no data. Maps to the Decide "Do insiders
// own or buy shares?" dropdown values: buying | selling | owns | unknown.
//
// Why this exists: counting Form 4 filings is misleading — a Form 4 is filed for
// sales too. We parse the actual transaction codes (P = open-market purchase,
// S = open-market sale) to get an honest read.

export const maxDuration = 30;

const UA = "Plainview investing tool plainview@dar-fishman.com";
const SEC_HEADERS = { "User-Agent": UA, Accept: "application/json" };

type ParsedFiling = { buy: number; sell: number; grant: boolean } | null;

export async function GET(request: Request) {
  const ticker = (new URL(request.url).searchParams.get("ticker") || "").trim().toUpperCase();
  if (!ticker) return NextResponse.json({ classification: "unknown", error: "Missing ticker" }, { status: 400 });

  try {
    // 1. Resolve CIK from ticker
    const tRes = await fetch("https://www.sec.gov/files/company_tickers.json", { headers: SEC_HEADERS, next: { revalidate: 86400 } });
    if (!tRes.ok) return NextResponse.json({ classification: "unknown", reason: "ticker map unavailable" });
    const tickers = await tRes.json() as Record<string, { cik_str: number; ticker: string }>;
    const clean = ticker.replace(/\..*$/, "");
    const row = Object.values(tickers).find(t => t.ticker.toUpperCase() === clean);
    // No CIK = non-US listing or ETF — no SEC insider data
    if (!row) return NextResponse.json({ classification: "unknown", filings: 0, reason: "no SEC insider data (non-US / ETF)" });
    const cik = String(row.cik_str).padStart(10, "0");
    const cikNum = String(row.cik_str);

    // 2. Find Form 4 filings in the last 90 days (newest first)
    const subRes = await fetch(`https://data.sec.gov/submissions/CIK${cik}.json`, { headers: SEC_HEADERS, cache: "no-store" });
    if (!subRes.ok) return NextResponse.json({ classification: "unknown", reason: "submissions unavailable" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sub = await subRes.json() as any;
    const forms: string[] = sub.filings?.recent?.form ?? [];
    const dates: string[] = sub.filings?.recent?.filingDate ?? [];
    const accs: string[]  = sub.filings?.recent?.accessionNumber ?? [];
    const cutoff = Date.now() - 90 * 86400000;
    const recent: string[] = [];
    for (let i = 0; i < forms.length && recent.length < 14; i++) {
      if (forms[i] !== "4") continue;
      if (Date.parse(dates[i]) < cutoff) break; // newest-first — stop once older than 90 days
      recent.push(accs[i]);
    }
    if (!recent.length) return NextResponse.json({ classification: "unknown", filings: 0, reason: "no Form 4 in 90 days" });

    // 3. Fetch + parse each Form 4 full submission, summing open-market buys vs sells
    const parseOne = async (acc: string): Promise<ParsedFiling> => {
      const accNo = acc.replace(/-/g, "");
      try {
        const res = await fetch(`https://www.sec.gov/Archives/edgar/data/${cikNum}/${accNo}/${acc}.txt`, { headers: { "User-Agent": UA }, cache: "no-store" });
        if (!res.ok) return null;
        const txt = await res.text();
        const codes  = [...txt.matchAll(/<transactionCode>([^<]+)<\/transactionCode>/g)].map(m => m[1].trim());
        const shares = [...txt.matchAll(/<transactionShares>\s*<value>([^<]+)<\/value>/g)].map(m => parseFloat(m[1]));
        let buy = 0, sell = 0, grant = false;
        for (let i = 0; i < codes.length; i++) {
          const sh = Number.isFinite(shares[i]) ? shares[i] : 0;
          if (codes[i] === "P") buy += sh;            // open-market purchase
          else if (codes[i] === "S") sell += sh;      // open-market sale
          else if (codes[i] === "A" || codes[i] === "M") grant = true; // grant / option exercise
        }
        return { buy, sell, grant };
      } catch { return null; }
    };

    const cap = <T>(p: Promise<T>, ms: number, fb: T) => Promise.race([p, new Promise<T>(r => setTimeout(() => r(fb), ms))]);
    const parsed = (await Promise.all(recent.map(a => cap(parseOne(a), 8000, null)))).filter(Boolean) as Exclude<ParsedFiling, null>[];

    if (!parsed.length) return NextResponse.json({ classification: "unknown", filings: recent.length, reason: "could not parse filings" });

    const buyShares  = parsed.reduce((s, r) => s + r.buy, 0);
    const sellShares = parsed.reduce((s, r) => s + r.sell, 0);
    const buyCount   = parsed.filter(r => r.buy > 0).length;
    const sellCount  = parsed.filter(r => r.sell > 0).length;

    // Classify (maps to dropdown values)
    let classification: "buying" | "selling" | "owns";
    if (buyShares > 0 && buyShares >= sellShares) classification = "buying";   // active open-market buying — strongest bullish signal
    else if (sellShares > buyShares) classification = "selling";               // net open-market selling
    else classification = "owns";                                              // filings exist (grants/options/holdings) but no open-market tilt

    const parts: string[] = [];
    if (buyCount)  parts.push(`${buyCount} buy`);
    if (sellCount) parts.push(`${sellCount} sell`);
    const summary = parts.length ? `${parts.join(" / ")} (90d)` : `${recent.length} insider filing${recent.length !== 1 ? "s" : ""} (90d)`;

    return NextResponse.json({
      classification,
      filings: recent.length,
      buyCount, sellCount,
      buyShares: Math.round(buyShares),
      sellShares: Math.round(sellShares),
      summary,
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return NextResponse.json({ classification: "unknown", error: e instanceof Error ? e.message : "failed" });
  }
}
