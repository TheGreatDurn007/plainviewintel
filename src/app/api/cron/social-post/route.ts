import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { postTweet, uploadMedia } from "@/lib/x-post";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const APP = process.env.NEXT_PUBLIC_APP_URL || "https://plainviewintel.com";

function admin() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );
}

function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.get("authorization") || "";
  return !!(secret && auth === `Bearer ${secret}`);
}

// ── Hashtag system (light touch — 0-2 tags, ~50% of posts get none) ──────
const TAG_POOL = [
  "#investing", "#stockmarket", "#stocks", "#duediligence",
  "#fundamentals", "#valueinvesting", "#stockanalysis",
  "#financialliteracy", "#stockresearch", "#longterminvesting",
];

function maybeAddTag(text: string): string {
  const roll = Math.random();
  if (roll > 0.5) return text;
  const shuffled = TAG_POOL.sort(() => Math.random() - 0.5);
  const count = roll < 0.25 ? 2 : 1;
  const tags = shuffled.slice(0, count).join(" ");
  const maxText = 280 - tags.length - 2;
  if (text.length > maxText) text = text.slice(0, maxText - 3) + "...";
  return `${text}\n\n${tags}`;
}

// ── Expanded ticker pools ─────────────────────────────────────────────────
// Mega-caps: saturated on FinTwit, low discovery value for a shadow-banned account
const MEGA_CAPS = ["AAPL", "MSFT", "NVDA", "GOOGL", "AMZN", "META"];

// Retail favorites: high search volume, passionate communities, less competition
const RETAIL_FAVORITES = [
  "PLTR", "SOFI", "HOOD", "RIVN", "SMCI", "ARM", "CRWD", "MSTR",
  "COIN", "SQ", "SHOP", "SNOW", "NET", "DKNG", "RBLX", "UBER",
  "ABNB", "ROKU", "PINS", "SNAP", "LYFT", "UPST", "AFRM", "PATH",
];

// Quality mid-caps: underserved on FinTwit, good X-Ray scores, engaged communities
const QUALITY_MIDCAPS = [
  "AXON", "TOST", "DUOL", "HUBS", "VEEV", "BILL", "PCOR",
  "MNDY", "CELH", "CAVA", "BIRK", "ONON", "DECK", "ELF",
  "WDAY", "ZS", "PANW", "FTNT", "DDOG", "MDB",
];

// Full pool: weighted toward retail favorites (highest search volume for our niche)
function pickTicker(): string {
  const roll = Math.random();
  if (roll < 0.5) {
    return RETAIL_FAVORITES[Math.floor(Math.random() * RETAIL_FAVORITES.length)];
  } else if (roll < 0.8) {
    return QUALITY_MIDCAPS[Math.floor(Math.random() * QUALITY_MIDCAPS.length)];
  } else {
    return MEGA_CAPS[Math.floor(Math.random() * MEGA_CAPS.length)];
  }
}

// ── Conversational posts (engagement bait — drives replies to lift shadow ban) ──
const CONVERSATIONAL = [
  // "This or that" — forces a reply
  { template: (t: string, s: number) => `$${t} scores ${s.toFixed(1)}/10 on business quality.\n\nAre you bullish or bearish at these levels?\n\n👇 Drop your take`, needsScore: true },
  { template: (t: string, s: number) => `$${t}: ${s.toFixed(1)}/10 fundamentals.\n\nWould you buy here, wait for a dip, or stay away entirely?`, needsScore: true },
  { template: (t: string, s: number) => `$${t} — ${s >= 7 ? "strong" : s >= 5 ? "decent" : "weak"} fundamentals (${s.toFixed(1)}/10).\n\nBut fundamentals ≠ timing. What's your read on the setup right now?`, needsScore: true },

  // Opinion poll — low effort reply = high conversion
  { template: (t: string, _s: number) => `Hot take: $${t} is one of the most misunderstood stocks on the market right now.\n\nAgree or disagree? 👇`, needsScore: false },
  { template: (t: string, _s: number) => `Unpopular opinion: Most people buying $${t} haven't read a single page of the 10-K.\n\nAm I wrong?`, needsScore: false },

  // "Fill in the blank" — irresistible reply format
  { template: (_t: string, _s: number) => `The most overrated stock in 2025 is ________.\n\nDrop your pick 👇`, needsScore: false },
  { template: (_t: string, _s: number) => `One stock you'd hold for 10 years without checking the price: ________`, needsScore: false },
  { template: (_t: string, _s: number) => `Best stock under $50 right now? Go. 👇`, needsScore: false },
  { template: (_t: string, _s: number) => `Name a stock you think is overvalued but keeps going up.\n\nI'll start: ________`, needsScore: false },

  // "Teach me" — positions Plainview as the expert, drives saves + replies
  { template: (t: string, s: number) => `$${t}'s gross margin is what separates it from its competitors.\n\nScored ${s.toFixed(1)}/10 on business quality. The 10-K shows why.\n\nWhat's your biggest question about reading SEC filings? 👇`, needsScore: true },
];

// ── Evergreen content library ───────────────────────────────────────────────
const EVERGREEN = [
  "A stock thesis should have a kill condition. If you can't name the thing that would make you sell, you don't have a thesis — you have hope.",
  "Revenue growth without free cash flow is a story, not a business. The 10-K tells you which one you're holding.",
  "The best entry isn't always the best company. The best company isn't always the best entry. That's why setup matters.",
  "SEC filings are written under penalty of law. Headlines are written for clicks. Know which one you're reading.",
  "Conviction without evidence is gambling. Evidence without conviction is paralysis. The goal is both.",
  "If your investment thesis hasn't changed but the price dropped 20%, that's information about the market — not necessarily about the company.",
  "Gross margin tells you pricing power. Operating margin tells you discipline. Free cash flow tells you reality.",
  "Insider buying is a clue, not a conclusion. Size, timing, and context matter more than the headline.",
  "The most dangerous words in investing: 'This time it's different.' The second most dangerous: 'It's always been this way.'",
  "A stock can be overvalued and still go up. A stock can be undervalued and still go down. Price is not the same as value.",
  "Short interest is a sentiment indicator, not a thesis. High short interest means smart money disagrees — find out why before you pick a side.",
  "The difference between a good investor and a great one isn't the winners — it's how they handle the losers.",
  "Volume confirms. Price suggests. Fundamentals decide. Don't skip steps.",
  "If you wouldn't buy a stock at this price, you probably shouldn't be holding it either. That's what opportunity cost means.",
  "Debt isn't automatically bad. Cash isn't automatically good. Context is everything — what are they doing with it?",
  "A 10-K takes 30 minutes to scan. A bad trade takes 30 seconds to make. The math is clear.",
  "Most 'due diligence' is reading other people's opinions. Real DD means reading the filing yourself.",
  "Earnings surprises move stocks. But the surprise is in the guidance, not the beat. Always read the forward outlook.",
  "Diversification is not owning 30 stocks. It's owning uncorrelated theses. Ten meme stocks is not diversified.",
  "The market rewards patience and punishes urgency. Almost every great entry started with waiting.",
  "Don't confuse a stock going up with being right. Don't confuse it going down with being wrong. Focus on the thesis, not the ticker.",
  "Cash on the balance sheet is the company's margin of safety. Cash in your account is yours. Respect both.",
  "Price targets from analysts are marketing, not prophecy. Their models are worth reading. Their conclusions are worth questioning.",
  "Research. Track. Decide. In that order. Most retail investors skip straight to decide.",
  "Every position should answer three questions: What do I believe? What would change my mind? When do I check again?",
  "The best investors aren't the ones who are always right. They're the ones who update fastest when they're wrong.",
  "A stock scoring 8/10 on fundamentals with a weak setup is not the same as an 8/10 with a strong setup. Timing is a separate skill.",
  "Net cash positive means the company could pay off all its debt tomorrow and still have money left. That matters more than most metrics.",
  "The filing says what the company did. The earnings call says what they want you to think. Read both, trust the first.",
  "Your portfolio is a collection of beliefs about the future. Each position should be one you can defend with evidence, not just emotion.",
];

// ── Data-driven content generators ──────────────────────────────────────────

async function getXrayScore(ticker: string): Promise<{ score: number; name: string; ticker: string } | null> {
  try {
    const res = await fetch(`${APP}/api/xray/${ticker}?bg=1`);
    if (!res.ok) return null;
    const data = await res.json() as Record<string, unknown>;
    const score = data.score as number | null;
    const name = data.name as string | null;
    if (score == null || !name) return null;
    return { score, name, ticker };
  } catch { return null; }
}

async function getXrayPost(): Promise<{ text: string; ticker: string } | null> {
  const ticker = pickTicker();
  const xray = await getXrayScore(ticker);
  if (!xray) return null;
  const { score, name } = xray;
  const grade = score >= 8 ? "strong" : score >= 6 ? "solid" : score >= 4 ? "mixed" : "weak";

  const templates = [
    `$${ticker} (${name}) — ${score.toFixed(1)}/10 on business quality.\n\n${grade === "strong" ? "Strong profitability, healthy balance sheet, growing revenue." : grade === "solid" ? "Solid fundamentals with areas to watch." : "Mixed signals — worth digging into the filing."}\n\nScored from SEC filings. No opinions.`,
    `Ran $${ticker} through the X-Ray.\n\n${score.toFixed(1)}/10 — ${grade} business quality. Profitability, balance sheet, revenue trajectory all scored from the actual 10-K.\n\nThe filing doesn't lie.`,
    `$${ticker} business quality: ${score.toFixed(1)}/10\n\nProfitability: ${grade === "strong" || grade === "solid" ? "healthy" : "needs a closer look"}\nBalance sheet: scored from SEC data\nRevenue: real numbers, not estimates\n\nAlways start with the filing.`,
    `$${ticker} — ${score.toFixed(1)}/10.\n\nNot a price target. Not a prediction. A fundamentals score built from the 10-K.\n\n${grade === "strong" ? "This one checks the boxes." : grade === "solid" ? "Decent business, but read the details." : "The numbers raise questions."}`,
  ];
  return { ticker, text: templates[Math.floor(Math.random() * templates.length)] };
}

async function getFilingHighlight(): Promise<{ text: string; ticker: string } | null> {
  try {
    const sb = admin();
    const { data } = await sb
      .from("filing_insights")
      .select("ticker, category, fact, filing_type")
      .order("created_at", { ascending: false })
      .limit(50);
    if (!data || !data.length) return null;

    const revenue = data.filter(r => r.category === "revenue" && r.fact.includes("Revenue"));
    if (!revenue.length) return null;
    const pick = revenue[Math.floor(Math.random() * revenue.length)];

    const templates = [
      `What does $${pick.ticker}'s ${pick.filing_type} actually say?\n\n${pick.fact}\n\nSource: SEC EDGAR, filed under penalty of law.`,
      `$${pick.ticker} — straight from the ${pick.filing_type}:\n\n${pick.fact}\n\nNot an estimate. Not a headline. The actual filing.`,
      `Pulled this from $${pick.ticker}'s latest ${pick.filing_type}:\n\n${pick.fact}\n\nSEC filings > analyst opinions.`,
    ];
    return { ticker: pick.ticker, text: templates[Math.floor(Math.random() * templates.length)] };
  } catch { return null; }
}

async function getMoversContent(): Promise<{ text: string; topTicker: string } | null> {
  try {
    const res = await fetch(`${APP}/api/movers`);
    if (!res.ok) return null;
    const data = await res.json() as { gainers?: Array<{ symbol: string; name: string; change: number }>; losers?: Array<{ symbol: string; name: string; change: number }> };
    const gainers = data.gainers?.slice(0, 3);
    const losers = data.losers?.slice(0, 3);
    if (!gainers?.length && !losers?.length) return null;

    let topTicker = "";
    const lines: string[] = ["Today's biggest moves:\n"];
    if (gainers?.length) {
      topTicker = gainers[0].symbol;
      lines.push("📈 Gainers:");
      for (const g of gainers) lines.push(`  $${g.symbol} +${g.change.toFixed(1)}%`);
    }
    if (losers?.length) {
      if (!topTicker) topTicker = losers[0].symbol;
      lines.push("\n📉 Losers:");
      for (const l of losers) lines.push(`  $${l.symbol} ${l.change.toFixed(1)}%`);
    }
    lines.push("\nMovement is data, not a signal. Research before you act.");
    return { text: lines.join("\n"), topTicker };
  } catch { return null; }
}

// Fetch a mover ticker for conversational posts — tweet about what people are already searching
async function getTrendingTicker(): Promise<string> {
  try {
    const res = await fetch(`${APP}/api/movers`);
    if (res.ok) {
      const data = await res.json() as { gainers?: Array<{ symbol: string }>; losers?: Array<{ symbol: string }> };
      const all = [...(data.gainers || []), ...(data.losers || [])];
      if (all.length) return all[Math.floor(Math.random() * Math.min(all.length, 6))].symbol;
    }
  } catch { /* fall through */ }
  return pickTicker();
}

// ── Conversational post generator (the shadow-ban breaker) ────────────────
async function getConversationalPost(): Promise<{ text: string; ticker: string } | null> {
  const template = CONVERSATIONAL[Math.floor(Math.random() * CONVERSATIONAL.length)];
  const ticker = await getTrendingTicker();

  if (template.needsScore) {
    const xray = await getXrayScore(ticker);
    if (!xray) return null;
    return { ticker, text: template.template(ticker, xray.score) };
  }
  return { ticker, text: template.template(ticker, 0) };
}

// ── Earnings-timed post ───────────────────────────────────────────────────
async function getEarningsPost(): Promise<{ text: string; ticker: string } | null> {
  try {
    // Check popular tickers for upcoming earnings (today or tomorrow)
    const candidates = [...RETAIL_FAVORITES, ...MEGA_CAPS, ...QUALITY_MIDCAPS];
    const shuffled = candidates.sort(() => Math.random() - 0.5).slice(0, 8);

    for (const ticker of shuffled) {
      const res = await fetch(`${APP}/api/earnings?tickers=${ticker}`);
      if (!res.ok) continue;
      const data = await res.json() as Array<{ symbol: string; earningsDate: string | null }>;
      if (!data?.[0]?.earningsDate) continue;

      const earningsDate = new Date(data[0].earningsDate);
      const now = new Date();
      const diffHours = (earningsDate.getTime() - now.getTime()) / (1000 * 60 * 60);

      // Earnings within next 48 hours
      if (diffHours > -12 && diffHours < 48) {
        const xray = await getXrayScore(ticker);
        if (!xray) continue;

        const isPast = diffHours < 0;
        const templates = isPast ? [
          `$${ticker} just reported earnings.\n\nBefore you react to the headline: the business scored ${xray.score.toFixed(1)}/10 on fundamentals going in.\n\nDid the filing confirm or challenge that? 👇`,
          `$${ticker} earnings are out.\n\nThe beat/miss headline will dominate, but what matters is the guidance. The business was ${xray.score.toFixed(1)}/10 on quality before this print.\n\nWhat stood out to you?`,
        ] : [
          `$${ticker} reports earnings soon.\n\nBusiness quality going in: ${xray.score.toFixed(1)}/10, scored from the last 10-K.\n\nAre you holding through, trimming, or adding? 👇`,
          `$${ticker} earnings coming up.\n\n${xray.score.toFixed(1)}/10 on fundamentals. ${xray.score >= 7 ? "Strong business quality heading into the print." : "Some mixed signals heading in."}\n\nWhat's your play? 👇`,
        ];
        return { ticker, text: templates[Math.floor(Math.random() * templates.length)] };
      }
    }
  } catch { /* no earnings found */ }
  return null;
}

// ── Slot system ───────────────────────────────────────────────────────────
type ContentSlot = "open" | "midday" | "close" | "weekend" | "thread";
type ContentResult = { text: string; imageTicker?: string };

function slotContent(slot: ContentSlot): () => Promise<ContentResult | null> {
  switch (slot) {
    case "open":
      return async () => {
        // Morning: earnings check first (highest engagement), then X-Ray score
        const earnings = await getEarningsPost();
        if (earnings) return { text: earnings.text, imageTicker: earnings.ticker };
        const r = await getXrayPost();
        return r ? { text: r.text, imageTicker: r.ticker } : null;
      };
    case "midday":
      return async () => {
        // Midday: conversational post (the shadow-ban breaker)
        // Alternate between engagement bait and filing highlights
        if (Math.random() < 0.6) {
          const conv = await getConversationalPost();
          if (conv) return { text: conv.text, imageTicker: conv.ticker };
        }
        const r = await getFilingHighlight();
        return r ? { text: r.text, imageTicker: r.ticker } : null;
      };
    case "close":
      return async () => {
        const day = new Date().getUTCDay();
        if (day === 2) {
          const promoTicker = pickTicker();
          const products = [
            "We built a tool that scores any stock 0-10 on business quality — from SEC filings and market data.\n\nNo AI opinions. No paywalled ratings. Just the numbers.\n\nLink in bio if you want to try it.",
            "Your investment thesis should be pressure-tested, not just confirmed.\n\nWe red-team reasoning against real filings and market data.\n\nFree to use — link in bio.",
            "What if you could scan any stock's 10-K in seconds?\n\nProfitability, balance sheet, revenue — scored 0-10 from the actual filing.\n\nThat's what we built. Link in bio.",
          ];
          return { text: products[Math.floor(Math.random() * products.length)], imageTicker: promoTicker };
        }
        // Close: movers (timely, discoverable via $cashtags)
        const movers = await getMoversContent();
        if (movers) return { text: movers.text, imageTicker: movers.topTicker };
        const xray = await getXrayPost();
        if (xray) return { text: xray.text, imageTicker: xray.ticker };
        const dayOfYear = Math.floor((Date.now() - new Date(new Date().getUTCFullYear(), 0, 0).getTime()) / 86400000);
        return { text: EVERGREEN[dayOfYear % EVERGREEN.length], imageTicker: pickTicker() };
      };
    case "weekend":
      return async () => {
        // Weekend: conversational posts (people browse and engage more on weekends)
        const conv = await getConversationalPost();
        if (conv) return { text: conv.text, imageTicker: conv.ticker };
        const dayOfYear = Math.floor((Date.now() - new Date(new Date().getUTCFullYear(), 0, 0).getTime()) / 86400000);
        return { text: EVERGREEN[dayOfYear % EVERGREEN.length], imageTicker: pickTicker() };
      };
    case "thread":
      return async () => null;
  }
}

// ── Thread generator ───────────────────────────────────────────────────────
async function generateThread(): Promise<ContentResult[] | null> {
  try {
    const sb = admin();
    const { data } = await sb
      .from("filing_insights")
      .select("ticker, category, fact, filing_type")
      .order("created_at", { ascending: false })
      .limit(100);
    if (!data || data.length < 5) return null;

    const tickers = [...new Set(data.map(r => r.ticker))];
    const pick = tickers[Math.floor(Math.random() * tickers.length)];
    const facts = data.filter(r => r.ticker === pick);

    const revenue = facts.find(f => f.category === "revenue");
    const margin = facts.find(f => f.category === "margins");
    const debt = facts.find(f => f.category === "debt");
    const cash = facts.find(f => f.category === "cash_flow");

    if (!revenue) return null;
    const filingType = revenue.filing_type || "10-K";

    const tweets: ContentResult[] = [];

    const hooks = [
      `I read $${pick}'s latest ${filingType} so you don't have to.\n\nHere's what the filing actually says — straight from SEC EDGAR. 🧵`,
      `$${pick} just filed their ${filingType}.\n\nMost people will read the headline. Here's what the actual document says. 🧵`,
      `What does $${pick}'s ${filingType} really say?\n\nI pulled the key numbers. Thread 🧵`,
    ];
    tweets.push({ text: hooks[Math.floor(Math.random() * hooks.length)], imageTicker: pick });

    tweets.push({
      text: `$${pick} Revenue:\n\n${revenue.fact}\n\nThis is what the company reported. Not what an analyst predicted.`,
    });

    if (margin) {
      tweets.push({ text: `$${pick} Margins:\n\n${margin.fact}\n\nMargins tell you whether the company is actually keeping the money it makes.` });
    } else {
      const rev2 = facts.find(f => f.category === "revenue" && f !== revenue);
      if (rev2) tweets.push({ text: `$${pick} Revenue detail:\n\n${rev2.fact}` });
    }

    if (debt) {
      tweets.push({ text: `$${pick} Balance Sheet:\n\n${debt.fact}\n\nUnderstanding what the company owes is step one of knowing what you own.` });
    } else if (cash) {
      tweets.push({ text: `$${pick} Cash Flow:\n\n${cash.fact}\n\nCash flow is how a company stays alive. Everything else is accounting.` });
    }

    // Final tweet: conversational CTA (drives replies on the thread)
    tweets.push({
      text: `That's $${pick} from the actual filing.\n\nAre you bullish or bearish on this one? What did I miss? 👇\n\nFollow for more breakdowns.`,
    });

    return tweets.length >= 3 ? tweets : null;
  } catch { return null; }
}

async function generateCardImage(ticker: string): Promise<string | null> {
  try {
    const res = await fetch(`${APP}/api/og/xray/${ticker}`);
    if (!res.ok) return null;
    const buf = await res.arrayBuffer();
    if (buf.byteLength < 1000) return null;
    return await uploadMedia(buf);
  } catch { return null; }
}

async function postThread(tweets: ContentResult[]): Promise<Array<{ status: string; id?: string }>> {
  const results: Array<{ status: string; id?: string }> = [];
  let replyToId: string | undefined;

  for (let i = 0; i < tweets.length; i++) {
    const tweet = tweets[i];
    let text = tweet.text;
    if (text.length > 280) text = text.slice(0, 277) + "...";

    let mediaId: string | undefined;
    if (tweet.imageTicker) {
      const mid = await generateCardImage(tweet.imageTicker);
      if (mid) mediaId = mid;
    }

    const result = await postTweet(text, mediaId, replyToId);
    if (result.success && result.id) {
      results.push({ status: "posted", id: result.id });
      replyToId = result.id;
    } else {
      results.push({ status: `error: ${result.error}` });
    }

    if (i < tweets.length - 1) await new Promise(r => setTimeout(r, 5000));
  }
  return results;
}

// ── Main handler ────────────────────────────────────────────────────────────
export async function GET(req: Request) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if (!process.env.X_ACCESS_TOKEN || !process.env.X_API_KEY) {
    return NextResponse.json({ error: "X API credentials not configured" }, { status: 500 });
  }

  const url = new URL(req.url);
  const slot = (url.searchParams.get("slot") || "open") as ContentSlot;

  if (slot === "thread") {
    const thread = await generateThread();
    if (!thread) {
      return NextResponse.json({ message: "Thread: no filing data available", results: [] });
    }
    const results = await postThread(thread);
    const posted = results.filter(r => r.status === "posted").length;
    return NextResponse.json({ message: `Thread: ${posted}/${thread.length} tweets posted`, results });
  }

  const generator = slotContent(slot);
  const content = await generator();

  if (!content) {
    const dayOfYear = Math.floor((Date.now() - new Date(new Date().getUTCFullYear(), 0, 0).getTime()) / 86400000);
    const fallbackIdx = (dayOfYear + slot.charCodeAt(0)) % EVERGREEN.length;
    const text = maybeAddTag(EVERGREEN[fallbackIdx]);
    const result = await postTweet(text);
    return NextResponse.json({
      message: `Social (${slot}): fallback evergreen posted`,
      results: [{ slot, status: result.success ? "posted" : `error: ${result.error}`, id: result.id }],
    });
  }

  const text = maybeAddTag(content.text);

  let mediaId: string | undefined;
  if (content.imageTicker) {
    const mid = await generateCardImage(content.imageTicker);
    if (mid) mediaId = mid;
  }

  const result = await postTweet(text, mediaId);
  return NextResponse.json({
    message: `Social (${slot}): ${result.success ? "posted" : "failed"}`,
    results: [{ slot, status: result.success ? (mediaId ? "posted+image" : "posted") : `error: ${result.error}`, id: result.id, preview: text.slice(0, 80) }],
  });
}
