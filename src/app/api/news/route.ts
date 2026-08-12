import { NextResponse } from "next/server";

type NewsItem = {
  ticker: string;
  title: string;
  source: string;
  url?: string;
  datetime?: string;
};

function isoDate(daysAgo: number) {
  const date = new Date();
  date.setDate(date.getDate() - daysAgo);
  return date.toISOString().slice(0, 10);
}

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36 Plainview/1.0";

function decodeXml(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

const grab = (block: string, tag: string) => decodeXml((block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`)) || [])[1] || "").trim();

/** Google News RSS — aggregates hundreds of outlets, no API key. Relevance-filtered. */
async function fetchGoogleNews(ticker: string, nameWords: string[]): Promise<NewsItem[]> {
  try {
    const res = await fetch(
      `https://news.google.com/rss/search?q=${encodeURIComponent(ticker + " stock")}&hl=en-US&gl=US&ceid=US:en`,
      { headers: { "User-Agent": UA }, next: { revalidate: 600 } }
    );
    if (!res.ok) return [];
    const xml = await res.text();
    const out: NewsItem[] = [];
    const itemRe = /<item>([\s\S]*?)<\/item>/g;
    let m: RegExpExecArray | null;
    while ((m = itemRe.exec(xml)) && out.length < 6) {
      const block = m[1];
      const rawTitle = grab(block, "title");
      if (!rawTitle) continue;
      // Google titles read "Headline - Publisher"; split off the publisher for a clean source.
      const dash = rawTitle.lastIndexOf(" - ");
      const title = dash > 20 ? rawTitle.slice(0, dash).trim() : rawTitle;
      const source = grab(block, "source") || (dash > 20 ? rawTitle.slice(dash + 3).trim() : "Google News");
      const link = grab(block, "link");
      const pub = grab(block, "pubDate");
      // Relevance: must name the ticker or a distinctive company word (kills noise for
      // common-word tickers). If no company name was resolved, the "{ticker} stock" query is
      // already finance-scoped, so accept.
      const low = title.toLowerCase();
      if (nameWords.length > 0 && !low.includes(ticker.toLowerCase()) && !nameWords.some((w) => low.includes(w))) continue;
      out.push({ ticker, title, source, url: link, datetime: pub ? new Date(pub).toISOString() : undefined });
    }
    return out;
  } catch { return []; }
}

async function fetchFinnhub(ticker: string, token: string, from: string, to: string): Promise<NewsItem[]> {
  try {
    const res = await fetch(`https://finnhub.io/api/v1/company-news?symbol=${encodeURIComponent(ticker)}&from=${from}&to=${to}&token=${token}`, { next: { revalidate: 300 } });
    if (!res.ok) return [];
    const rows = await res.json();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (Array.isArray(rows) ? rows : []).slice(0, 4).map((item: any) => ({
      ticker,
      title: item.headline || "Untitled headline",
      source: item.source || "Finnhub",
      url: item.url,
      datetime: item.datetime ? new Date(item.datetime * 1000).toISOString() : undefined,
    }));
  } catch { return []; }
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const symbols = [...new Set((url.searchParams.get("symbols") || "")
    .split(",")
    .map(symbol => symbol.trim().toUpperCase())
    .filter(Boolean))]
    .slice(0, 12);

  if (!symbols.length) return NextResponse.json({ news: [], message: "No symbols yet." });

  const finnhub = process.env.FINNHUB_API_KEY;
  const from = isoDate(7);
  const to = isoDate(0);
  const all: NewsItem[] = [];

  await Promise.all(symbols.map(async ticker => {
    const yahooItems: NewsItem[] = [];
    let nameWords: string[] = [];
    // --- Yahoo Finance search: resolves the company name AND relevance-filtered headlines ---
    try {
      const res = await fetch(`https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(ticker)}&quotesCount=1&newsCount=12&enableFuzzyQuery=false`, {
        headers: { "User-Agent": UA }, next: { revalidate: 300 }
      });
      if (res.ok) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const rows: any = await res.json();
        const companyName = String(rows.quotes?.[0]?.shortname || rows.quotes?.[0]?.longname || "").toLowerCase();
        nameWords = companyName
          .replace(/[.,]/g, " ")
          .replace(/\b(inc|corp|corporation|ltd|limited|plc|holdings?|company|co|group|the|sa|nv|ag)\b/g, " ")
          .split(/\s+/).filter((w: string) => w.length >= 4);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const newsItems: any[] = Array.isArray(rows.news) ? rows.news : [];
        const isRelevant = (item: { relatedTickers?: string[]; title?: string }) => {
          const related = (item.relatedTickers || []).map((t) => String(t).toUpperCase());
          if (related.includes(ticker)) return true;
          const title = String(item.title || "").toLowerCase();
          return nameWords.length > 0 && nameWords.some((w) => title.includes(w));
        };
        const relevant = newsItems.filter(isRelevant);
        for (const item of (relevant.length ? relevant : newsItems).slice(0, 6)) {
          yahooItems.push({
            ticker,
            title: item.title || "Untitled headline",
            source: item.publisher || "Yahoo Finance",
            url: item.link,
            datetime: item.providerPublishTime ? new Date(item.providerPublishTime * 1000).toISOString() : undefined
          });
        }
      }
    } catch { /* ignore — other sources may still return */ }

    // --- Google News RSS (always) + Finnhub (if key) in parallel ---
    const [googleItems, finnhubItems] = await Promise.all([
      fetchGoogleNews(ticker, nameWords),
      finnhub ? fetchFinnhub(ticker, finnhub, from, to) : Promise.resolve([] as NewsItem[]),
    ]);

    // Merge all sources, dedupe by normalized headline, newest first, cap per ticker.
    const seen = new Set<string>();
    const merged = [...finnhubItems, ...yahooItems, ...googleItems].filter((it) => {
      const key = String(it.title || "").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 60);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    merged.sort((a, b) => (Date.parse(b.datetime || "") || 0) - (Date.parse(a.datetime || "") || 0));
    for (const it of merged.slice(0, 5)) all.push(it);
  }));

  return NextResponse.json({
    news: all.slice(0, 60),
    source: "Yahoo Finance + Google News" + (finnhub ? " + Finnhub" : ""),
    updatedAt: new Date().toISOString()
  });
}
