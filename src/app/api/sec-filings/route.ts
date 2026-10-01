import { NextResponse } from "next/server";

const SEC_HEADERS = {
  "User-Agent": "Plainview investing tool plainview@dar-fishman.com",
  Accept: "application/json",
};

type Filing = {
  ticker: string;
  formType: string;
  entityName: string;
  fileDate: string | null;
  accessionNumber: string | null;
  url: string | null;
  contentUrl: string | null; // direct URL to the primary filing document
};

export async function GET(request: Request) {
  const url = new URL(request.url);
  const ticker = (url.searchParams.get("ticker") || "").trim().toUpperCase();
  if (!ticker) return NextResponse.json({ filings: [] });

  try {
    // Step 1: resolve CIK from SEC's company tickers index
    const tickerRes = await fetch("https://www.sec.gov/files/company_tickers.json", {
      headers: SEC_HEADERS,
      next: { revalidate: 3600 },
    });
    if (!tickerRes.ok) return NextResponse.json({ filings: [] });

    const tickers = await tickerRes.json() as Record<string, { cik_str: number; ticker: string; title: string }>;
    const clean = ticker.replace(/\..*$/, "");
    const match = Object.values(tickers).find(t => t.ticker.toUpperCase() === clean);
    if (!match) return NextResponse.json({ filings: [] });

    // ACCURACY GUARD: foreign tickers (e.g. CNR.TO) stripped of suffix can collide with a
    // different US company (CNR = Core Natural Resources ≠ Canadian National Railway).
    // If an expectedName is provided, require a distinctive word match; otherwise skip
    // foreign tickers entirely — showing wrong filings is worse than showing none.
    const expectedName = url.searchParams.get("name") || "";
    if (/\.(TO|V|CN|NE|TSX)$/i.test(ticker)) {
      if (!expectedName) return NextResponse.json({ filings: [] });
      const norm = (s: string) => s.toLowerCase()
        .replace(/[.,&]/g, " ")
        .replace(/\b(inc|corp|corporation|ltd|limited|plc|holdings?|company|companies|co|group|the|of|sa|nv|ag|llc|lp|trust|fund)\b/g, " ")
        .split(/\s+/).filter(w => w.length >= 4);
      const want = new Set(norm(expectedName));
      const got = norm(String(match.title || ""));
      if (!got.some(w => want.has(w))) return NextResponse.json({ filings: [] });
    }

    const cik = String(match.cik_str).padStart(10, "0");
    const cikInt = match.cik_str;
    const entityName = match.title;

    // Step 2: fetch company submissions (sorted newest-first, filings BY this company)
    const subRes = await fetch(`https://data.sec.gov/submissions/CIK${cik}.json`, {
      headers: SEC_HEADERS,
      cache: "no-store",
    });
    if (!subRes.ok) return NextResponse.json({ filings: [] });

    const sub = await subRes.json() as {
      filings: {
        recent: {
          form: string[];
          filingDate: string[];
          accessionNumber: string[];
          primaryDocument: string[];
        };
      };
    };

    const { form, filingDate, accessionNumber, primaryDocument } = sub.filings.recent;
    const TARGET_FORMS = new Set(["8-K", "4", "10-Q", "10-K"]);

    function makeFiling(i: number): Filing {
      const acc = accessionNumber[i].replace(/-/g, "");
      const docFile = primaryDocument?.[i] || null;
      return {
        ticker,
        formType: form[i],
        entityName,
        accessionNumber: accessionNumber[i],
        fileDate: filingDate[i] ?? null,
        url: `https://www.sec.gov/Archives/edgar/data/${cikInt}/${acc}/`,
        contentUrl: docFile ? `https://www.sec.gov/Archives/edgar/data/${cikInt}/${acc}/${docFile}` : null,
      };
    }

    const filings: Filing[] = [];
    const seen = new Set<string>();
    let found10K = false, found10Q = false, found8K = false;

    // Pass 1: collect up to 5 recent filings of any target type
    for (let i = 0; i < form.length && filings.length < 5; i++) {
      if (!TARGET_FORMS.has(form[i])) continue;
      filings.push(makeFiling(i));
      seen.add(accessionNumber[i]);
      if (/^10-K/.test(form[i])) found10K = true;
      if (/^10-Q/.test(form[i])) found10Q = true;
      if (/^8-K/.test(form[i])) found8K = true;
    }

    // Pass 2: ensure we always include the latest 10-K, 10-Q, 8-K for Filing Intelligence
    if (!found10K || !found10Q || !found8K) {
      for (let i = 0; i < form.length; i++) {
        if (seen.has(accessionNumber[i])) continue;
        if (!found10K && /^10-K/.test(form[i])) { filings.push(makeFiling(i)); found10K = true; seen.add(accessionNumber[i]); }
        else if (!found10Q && /^10-Q/.test(form[i])) { filings.push(makeFiling(i)); found10Q = true; seen.add(accessionNumber[i]); }
        else if (!found8K && /^8-K/.test(form[i])) { filings.push(makeFiling(i)); found8K = true; seen.add(accessionNumber[i]); }
        if (found10K && found10Q && found8K) break;
      }
    }

    return NextResponse.json({ filings, updatedAt: new Date().toISOString() });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ filings: [], error: msg });
  }
}
