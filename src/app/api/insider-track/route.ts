import { NextResponse } from "next/server";

// ════════════════════════════════════════════════════════════════════════════════════════════
// INSIDER TRACK RECORD — grades every historical open-market buy against actual price returns.
// ════════════════════════════════════════════════════════════════════════════════════════════
// An insider open-market buy IS a falsifiable prediction — they bet it goes up from their buy
// price. We grade each one deterministically: return from buy price to current price. Zero AI,
// Tier-1 SEC facts + exchange price. Un-clonable (ChatGPT has no post-filing memory).
//
// GET /api/insider-track?ticker=AMC → { buys: [...], summary, trackRecord }

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const UA = "Plainview investing tool plainview@dar-fishman.com";
const SEC_H = { "User-Agent": UA, Accept: "application/json" };
const YF_H = { "User-Agent": "Mozilla/5.0" };

type InsiderBuy = {
  name: string;
  role: string;
  date: string;
  price: number;
  shares: number;
  value: number;
  returnPct: number | null;
  currentPrice: number | null;
  daysHeld: number;
};

type TrackRecord = {
  totalBuys: number;
  avgReturnPct: number | null;
  medianReturnPct: number | null;
  winnersCount: number;
  losersCount: number;
  bestReturn: number | null;
  worstReturn: number | null;
  distinctInsiders: number;
  buys: InsiderBuy[];
  summary: string;
};

function roleName(xml: string): { name: string; role: string } {
  const nameM = xml.match(/<rptOwnerName>([^<]+)<\/rptOwnerName>/);
  const name = nameM ? nameM[1].trim() : "Unknown";
  const isOfficer = /<isOfficer>(?:true|1)<\/isOfficer>/i.test(xml);
  const isDirector = /<isDirector>(?:true|1)<\/isDirector>/i.test(xml);
  const is10pct = /<isTenPercentOwner>(?:true|1)<\/isTenPercentOwner>/i.test(xml);
  const titleM = xml.match(/<officerTitle>([^<]+)<\/officerTitle>/);
  let role = "Insider";
  if (isOfficer && titleM) {
    const t = titleM[1];
    if (/chief exec/i.test(t)) role = "CEO";
    else if (/chief financ/i.test(t)) role = "CFO";
    else if (/chief oper/i.test(t)) role = "COO";
    else if (/chief tech/i.test(t)) role = "CTO";
    else role = t.length <= 24 ? t : "Officer";
  } else if (isOfficer) role = "Officer";
  else if (isDirector) role = "Director";
  else if (is10pct) role = "10% Owner";
  return { name, role };
}

async function fetchCurrentPrice(ticker: string): Promise<number | null> {
  for (const host of ["query1", "query2"]) {
    try {
      const r = await fetch(
        `https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=1d&interval=1d`,
        { headers: YF_H, next: { revalidate: 300 } }
      );
      if (!r.ok) continue;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const j: any = await r.json();
      const price = j?.chart?.result?.[0]?.meta?.regularMarketPrice;
      if (typeof price === "number" && price > 0) return price;
    } catch { continue; }
  }
  return null;
}

export async function GET(request: Request) {
  const ticker = (new URL(request.url).searchParams.get("ticker") || "").trim().toUpperCase();
  if (!ticker) return NextResponse.json({ error: "Missing ticker" }, { status: 400 });

  try {
    // 1. Resolve CIK
    const tRes = await fetch("https://www.sec.gov/files/company_tickers.json", { headers: SEC_H, next: { revalidate: 86400 } });
    if (!tRes.ok) return NextResponse.json({ trackRecord: null, reason: "ticker map unavailable" });
    const tickers = await tRes.json() as Record<string, { cik_str: number; ticker: string }>;
    const clean = ticker.replace(/\..*$/, "");
    const row = Object.values(tickers).find(t => t.ticker.toUpperCase() === clean);
    if (!row) return NextResponse.json({ trackRecord: null, reason: "no SEC data (non-US / ETF)" });
    const cik = String(row.cik_str).padStart(10, "0");
    const cikNum = String(row.cik_str);

    // 2. Fetch submissions — look back 12 months for Form 4s
    const subRes = await fetch(`https://data.sec.gov/submissions/CIK${cik}.json`, { headers: SEC_H, next: { revalidate: 7200 } });
    if (!subRes.ok) return NextResponse.json({ trackRecord: null, reason: "submissions unavailable" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sub = await subRes.json() as any;
    const forms: string[] = sub.filings?.recent?.form ?? [];
    const dates: string[] = sub.filings?.recent?.filingDate ?? [];
    const accs: string[] = sub.filings?.recent?.accessionNumber ?? [];
    const cutoff = Date.now() - 365 * 86400000;
    const form4Accs: { acc: string; date: string }[] = [];
    for (let i = 0; i < forms.length && form4Accs.length < 30; i++) {
      if (forms[i] !== "4") continue;
      if (Date.parse(dates[i]) < cutoff) break;
      form4Accs.push({ acc: accs[i], date: dates[i] });
    }
    if (!form4Accs.length) return NextResponse.json({ trackRecord: null, buys: [], reason: "no Form 4 in 12 months" });

    // 3. Fetch current price in parallel with Form 4 parsing
    const [currentPrice, ...parsedFilings] = await Promise.all([
      fetchCurrentPrice(ticker),
      ...form4Accs.map(({ acc, date }) => parseForm4Buy(cikNum, acc, date)),
    ]);

    const buys: InsiderBuy[] = [];
    const today = Date.now();
    for (const filing of parsedFilings) {
      if (!filing) continue;
      for (const buy of filing.buys) {
        const daysHeld = Math.round((today - Date.parse(filing.date)) / 86400000);
        const returnPct = (currentPrice != null && buy.price > 0)
          ? Math.round(((currentPrice - buy.price) / buy.price) * 1000) / 10
          : null;
        buys.push({
          name: filing.name,
          role: filing.role,
          date: filing.date,
          price: Math.round(buy.price * 100) / 100,
          shares: Math.round(buy.shares),
          value: Math.round(buy.shares * buy.price),
          returnPct,
          currentPrice,
          daysHeld,
        });
      }
    }

    if (!buys.length) return NextResponse.json({ trackRecord: null, buys: [], reason: "no open-market buys in 12 months" });

    // 4. Aggregate into track record
    const returns = buys.map(b => b.returnPct).filter((r): r is number => r !== null);
    const sorted = [...returns].sort((a, b) => a - b);
    const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
    const avg = returns.length ? Math.round(returns.reduce((s, r) => s + r, 0) / returns.length * 10) / 10 : null;
    const distinctInsiders = new Set(buys.map(b => b.name)).size;

    const winners = returns.filter(r => r > 0).length;
    const losers = returns.filter(r => r <= 0).length;

    // Summary sentence
    let summary = `${buys.length} insider buy${buys.length === 1 ? "" : "s"} in the last year`;
    if (avg !== null) {
      summary += ` — avg return ${avg >= 0 ? "+" : ""}${avg}% from buy price`;
      summary += ` (${winners}W / ${losers}L)`;
    }
    if (distinctInsiders > 1) summary += `, ${distinctInsiders} distinct insiders`;

    const trackRecord: TrackRecord = {
      totalBuys: buys.length,
      avgReturnPct: avg,
      medianReturnPct: median,
      winnersCount: winners,
      losersCount: losers,
      bestReturn: sorted.length ? sorted[sorted.length - 1] : null,
      worstReturn: sorted.length ? sorted[0] : null,
      distinctInsiders,
      buys: buys.sort((a, b) => b.date.localeCompare(a.date)).slice(0, 15),
      summary,
    };

    return NextResponse.json({ trackRecord }, { headers: { "Cache-Control": "public, s-maxage=7200, stale-while-revalidate=3600" } });
  } catch (e) {
    return NextResponse.json({ trackRecord: null, error: e instanceof Error ? e.message : "failed" });
  }
}

type ParsedBuy = { name: string; role: string; date: string; buys: { shares: number; price: number }[] };

async function parseForm4Buy(cikNum: string, acc: string, date: string): Promise<ParsedBuy | null> {
  const accNo = acc.replace(/-/g, "");
  try {
    const res = await fetch(
      `https://www.sec.gov/Archives/edgar/data/${cikNum}/${accNo}/${acc}.txt`,
      { headers: { "User-Agent": UA }, next: { revalidate: 86400 } }
    );
    if (!res.ok) return null;
    const txt = await res.text();

    const { name, role } = roleName(txt);

    // Extract transaction codes, shares, and prices
    const codes = [...txt.matchAll(/<transactionCode>([^<]+)<\/transactionCode>/g)].map(m => m[1].trim());
    const shares = [...txt.matchAll(/<transactionShares>\s*<value>([^<]+)<\/value>/g)].map(m => parseFloat(m[1]));
    const prices = [...txt.matchAll(/<transactionPricePerShare>\s*<value>([^<]+)<\/value>/g)].map(m => parseFloat(m[1]));

    const buys: { shares: number; price: number }[] = [];
    for (let i = 0; i < codes.length; i++) {
      if (codes[i] !== "P") continue; // open-market purchase only
      const sh = Number.isFinite(shares[i]) ? shares[i] : 0;
      const px = Number.isFinite(prices[i]) ? prices[i] : 0;
      if (sh > 0 && px > 0) buys.push({ shares: sh, price: px });
    }

    if (!buys.length) return null;
    return { name, role, date, buys };
  } catch {
    return null;
  }
}
