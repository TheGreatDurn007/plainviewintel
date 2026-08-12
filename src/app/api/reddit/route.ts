import { NextResponse } from "next/server";

const SUBREDDITS = "wallstreetbets+stocks+investing+StockMarket+pennystocks+SecurityAnalysis+Biotechplays+smallstreetbets+Shortsqueeze+weedstocks+RocketLab+SpaceXLounge+SPACs";

// Crude sentiment from post title/body keywords
function scoreSentiment(text: string): "bull" | "bear" | "neutral" {
  const t = text.toLowerCase();
  const bullWords = ["buy", "long", "calls", "moon", "bullish", "squeeze", "breakout", "hold", "upside", "catalyst", "positive", "beat", "strong"];
  const bearWords = ["sell", "short", "puts", "crash", "bearish", "dump", "drop", "overvalued", "avoid", "miss", "weak", "loss", "decline"];
  const bulls = bullWords.filter(w => t.includes(w)).length;
  const bears = bearWords.filter(w => t.includes(w)).length;
  if (bulls > bears) return "bull";
  if (bears > bulls) return "bear";
  return "neutral";
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const symbol = (url.searchParams.get("symbol") || "").trim().toUpperCase();
  if (!symbol) return NextResponse.json({ mentions: [], error: "symbol required" });

  try {
    // Reddit public JSON API — no auth needed for reading public subreddits
    const query = encodeURIComponent(`${symbol} stock`);
    const res = await fetch(
      `https://www.reddit.com/r/${SUBREDDITS}/search.json?q=${query}&sort=new&t=week&limit=25&type=link`,
      {
        headers: {
          "User-Agent": "Plainview investing tool plainview@dar-fishman.com",
          "Accept": "application/json",
        },
        next: { revalidate: 900 }, // cache 15 min
      }
    );

    if (!res.ok) {
      return NextResponse.json({ mentions: [], error: `Reddit ${res.status}` });
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data = await res.json() as any;
    const posts = data?.data?.children ?? [];

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mentions = posts.map((child: any) => {
      const p = child.data;
      return {
        title: p.title as string,
        url: `https://reddit.com${p.permalink}` as string,
        subreddit: p.subreddit as string,
        score: p.score as number,
        comments: p.num_comments as number,
        created: p.created_utc as number,
        sentiment: scoreSentiment((p.title || "") + " " + (p.selftext || "")),
      };
    }).filter((m: { title: string }) => {
      // Only keep posts that actually mention the ticker symbol
      const t = m.title.toUpperCase();
      return t.includes(symbol) || t.includes(`$${symbol}`);
    });

    const bulls = mentions.filter((m: { sentiment: string }) => m.sentiment === "bull").length;
    const bears = mentions.filter((m: { sentiment: string }) => m.sentiment === "bear").length;
    const total = mentions.length;

    return NextResponse.json({
      symbol,
      total,
      bullish: total > 0 ? Math.round(bulls / total * 100) : null,
      bearish: total > 0 ? Math.round(bears / total * 100) : null,
      mentions: mentions.slice(0, 10), // top 10 posts
      updatedAt: new Date().toISOString(),
    });
  } catch (e) {
    return NextResponse.json({ mentions: [], error: e instanceof Error ? e.message : "Reddit fetch failed" });
  }
}
