import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { isAdmin } from "@/lib/usage-log";
import { postTweet, uploadMedia } from "@/lib/x-post";

export const dynamic = "force-dynamic";
export const maxDuration = 55;

const APP = process.env.NEXT_PUBLIC_APP_URL || "https://plainviewintel.com";

function admin() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );
}

// ── Reply draft type ───────────────────────────────────────────────────────
type ReplyDraft = {
  ticker: string;
  reason: string;
  draft: string;
  score: number | null;
  category: "mover" | "filing" | "xray";
  searchQueries: string[];
  replyVariants: { context: string; reply: string }[];
};

// ── Curated accounts: high-engagement investing accounts to reply to ───────
const REPLY_TARGETS = [
  { handle: "jimcramer", name: "Jim Cramer", why: "Massive reach, strong opinions — your data-backed reply stands out" },
  { handle: "TruthGundlach", name: "Jeffrey Gundlach", why: "Bond king, macro takes — reply with stock-level data" },
  { handle: "chaaborvornkit", name: "Chamath Palihapitiya", why: "Tech investing, big audience" },
  { handle: "unusual_whales", name: "Unusual Whales", why: "Options flow — reply with fundamental context" },
  { handle: "StockMKTNewz", name: "Stock Market News", why: "Breaking headlines — be first with the filing data" },
  { handle: "elerianm", name: "Mohamed El-Erian", why: "Macro commentary — reply with company-level nuance" },
  { handle: "BillAckman", name: "Bill Ackman", why: "High-profile activist investor, massive engagement" },
  { handle: "gabormadaras", name: "Gabor Madaras", why: "Value investing community" },
  { handle: "ValueStockGeek", name: "Value Stock Geek", why: "Same audience — your data adds value" },
  { handle: "FinanceLancelot", name: "Finance Lancelot", why: "Retail investing community, educational content" },
];

async function generateReplyQueue(): Promise<{ drafts: ReplyDraft[]; targets: typeof REPLY_TARGETS }> {
  const drafts: ReplyDraft[] = [];

  // 1. Top movers — people are actively searching these $cashtags
  try {
    const res = await fetch(`${APP}/api/movers`);
    if (res.ok) {
      const data = await res.json() as { gainers?: Array<{ symbol: string; name: string; change: number }>; losers?: Array<{ symbol: string; name: string; change: number }> };
      const movers = [...(data.gainers?.slice(0, 3) || []), ...(data.losers?.slice(0, 3) || [])];
      for (const m of movers) {
        const dir = m.change >= 0 ? "up" : "down";
        const pct = Math.abs(m.change).toFixed(1);
        drafts.push({
          ticker: m.symbol,
          reason: `${dir} ${pct}% today — high search volume right now`,
          draft: `$${m.symbol} ${dir} ${pct}%. The move gets attention but the fundamentals tell the real story — business quality matters more than a single session.`,
          score: null,
          category: "mover",
          searchQueries: [
            `$${m.symbol}`,
            `$${m.symbol} ${dir === "up" ? "buy OR sell" : "buying opportunity OR oversold"}`,
            `$${m.symbol} ${dir === "up" ? "overvalued OR bubble" : "undervalued OR dip"}`,
          ],
          replyVariants: [
            {
              context: "Someone asking if they should buy/sell",
              reply: `$${m.symbol} is ${dir} ${pct}% but one day doesn't change the thesis. Before reacting, check the business quality — profitability, balance sheet, revenue trajectory. The filing tells you more than the candle.`,
            },
            {
              context: "Someone celebrating/panicking about the move",
              reply: `Price moves are data, not signals. $${m.symbol} scored on business quality from actual SEC filings, not headlines. Focus on the fundamentals — they don't change because of one ${dir === "up" ? "green" : "red"} day.`,
            },
            {
              context: "An analyst/influencer making a prediction",
              reply: `Interesting take on $${m.symbol}. The ${m.change >= 0 ? "strength" : "weakness"} today is notable but the SEC filing tells you what the company actually did vs. what people think it will do. Evidence > predictions.`,
            },
          ],
        });
      }
    }
  } catch { /* skip */ }

  // 2. Recent filing insights — authoritative, fact-based replies
  try {
    const sb = admin();
    const { data } = await sb
      .from("filing_insights")
      .select("ticker, category, fact, filing_type")
      .order("created_at", { ascending: false })
      .limit(30);
    if (data) {
      const tickers = [...new Set(data.map(r => r.ticker))].slice(0, 3);
      for (const t of tickers) {
        const facts = data.filter(r => r.ticker === t);
        const rev = facts.find(f => f.category === "revenue" && f.fact.includes("Revenue"));
        const margin = facts.find(f => f.category === "margins");
        if (rev) {
          drafts.push({
            ticker: t,
            reason: `Fresh ${rev.filing_type} filing data — you have facts others don't`,
            draft: `$${t}'s latest ${rev.filing_type}: ${rev.fact}. Source: SEC EDGAR, filed under penalty of law — not headlines, not estimates.`,
            score: null,
            category: "filing",
            searchQueries: [
              `$${t} earnings`,
              `$${t} revenue OR sales`,
              `$${t} ${rev.filing_type}`,
              `$${t} fundamental analysis`,
            ],
            replyVariants: [
              {
                context: "Someone discussing the stock's fundamentals",
                reply: `Here's what the actual ${rev.filing_type} says: ${rev.fact}. Filed with the SEC under penalty of law. Always go to the source.`,
              },
              {
                context: "Someone sharing an analyst opinion or price target",
                reply: `For context, $${t}'s latest ${rev.filing_type} shows: ${rev.fact}. ${margin ? margin.fact + ". " : ""}Filings > forecasts.`,
              },
              {
                context: "Someone asking for DD or analysis",
                reply: `Start with the filing. $${t}'s ${rev.filing_type}: ${rev.fact}. ${margin ? "Margins: " + margin.fact + ". " : ""}SEC EDGAR is free, public, and filed under penalty of law. That's real DD.`,
              },
            ],
          });
        }
      }
    }
  } catch { /* skip */ }

  // 3. X-Ray quality scores — add nuance to popular stock debates
  const interestingTickers = ["AAPL", "NVDA", "MSFT", "GOOGL", "AMZN", "META", "TSLA", "KO", "JNJ", "V",
    "MA", "COST", "HD", "MRK", "PEP", "AVGO", "LLY", "UNH", "PG", "ABBV"];
  const picks = interestingTickers.sort(() => Math.random() - 0.5).slice(0, 3);
  for (const ticker of picks) {
    try {
      const res = await fetch(`${APP}/api/xray/${ticker}?bg=1`);
      if (res.ok) {
        const d = await res.json() as Record<string, unknown>;
        const score = d.score as number | null;
        const name = d.name as string | null;
        if (score != null && name) {
          const grade = score >= 8 ? "strong" : score >= 6 ? "solid" : score >= 4 ? "mixed" : "questionable";
          drafts.push({
            ticker,
            reason: `${score.toFixed(1)}/10 X-Ray — ${grade} quality, always debated`,
            draft: `$${ticker} (${name}) — ${score.toFixed(1)}/10 business quality. ${grade === "strong" ? "Strong profitability, healthy balance sheet, growing revenue." : grade === "solid" ? "Solid fundamentals with some areas to watch." : "Mixed signals — dig into the filing before committing."} Scored from SEC filings, not opinions.`,
            score,
            category: "xray",
            searchQueries: [
              `$${ticker} buy OR sell OR hold`,
              `$${ticker} overvalued OR undervalued`,
              `$${ticker} worth buying`,
              `"${name}" stock`,
            ],
            replyVariants: [
              {
                context: "Someone asking if they should buy",
                reply: `$${ticker} scores ${score.toFixed(1)}/10 on business quality — profitability, balance sheet, revenue. That's a ${grade} grade from actual SEC data. Whether to buy depends on your thesis and entry, but the business itself is ${grade}.`,
              },
              {
                context: "Someone comparing stocks (AAPL vs MSFT etc.)",
                reply: `On raw business quality, $${ticker} scores ${score.toFixed(1)}/10 — measured from SEC filings: profitability, balance sheet strength, revenue trajectory. Compare the filings, not the headlines.`,
              },
              {
                context: "Someone sharing a bearish/bullish take",
                reply: `The numbers: $${ticker} is ${score.toFixed(1)}/10 on business quality (${grade}). Scored deterministically from the 10-K — profitability, debt, revenue growth. The filing doesn't have an opinion. Neither should your analysis, until you've read it.`,
              },
            ],
          });
        }
      }
    } catch { /* skip */ }
  }

  // Shuffle targets for variety
  const shuffledTargets = [...REPLY_TARGETS].sort(() => Math.random() - 0.5).slice(0, 5);

  return { drafts, targets: shuffledTargets };
}

// GET — fetch today's reply queue + targets
export async function GET() {
  if (!(await isAdmin().catch(() => false))) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const { drafts, targets } = await generateReplyQueue();
  return NextResponse.json({ drafts, targets, generated: new Date().toISOString() });
}

// POST — send a tweet directly from admin (with optional image)
export async function POST(req: Request) {
  if (!(await isAdmin().catch(() => false))) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const body = await req.json() as { text: string; ticker?: string; withImage?: boolean };
  if (!body.text || typeof body.text !== "string") {
    return NextResponse.json({ error: "text required" }, { status: 400 });
  }

  let mediaId: string | undefined;
  if (body.withImage && body.ticker) {
    try {
      const imgRes = await fetch(`${APP}/api/og/xray/${body.ticker}`);
      if (imgRes.ok) {
        const buf = await imgRes.arrayBuffer();
        const mid = await uploadMedia(buf);
        if (mid) mediaId = mid;
      }
    } catch { /* post without image */ }
  }

  const result = await postTweet(body.text, mediaId);
  return NextResponse.json(result);
}
