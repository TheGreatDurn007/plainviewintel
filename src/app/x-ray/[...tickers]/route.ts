import { readFile } from "node:fs/promises";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import type { XrayResult } from "@/types";

// `/x-ray/AMC`, `/x-ray/AMC-vs-GME`, etc. — one page; the client parses the ticker(s) from the path. For
// SEO we inject a UNIQUE <title>, description, canonical + Open Graph per ticker (and per head-to-head) so
// every ticker URL is its own indexable page — the programmatic-SEO lever. Auth flag injected for the header.
// IMPORTANT: does NOT import cookies() from next/headers — that would force Next.js to mark the route as
// dynamic/uncacheable. Instead we parse auth from the raw Cookie header so our s-maxage sticks at the edge.

const BASE = "https://plainviewintel.com";

// Check auth from the raw Cookie header — avoids importing next/headers (which marks the route dynamic
// and overrides our cache-control). For Googlebot (no sb- cookie) this skips entirely (fast path).
async function isLoggedIn(req: Request): Promise<boolean> {
  try {
    const raw = req.headers.get("cookie") || "";
    if (!raw.includes("sb-")) return false;
    // Extract the access token from Supabase's chunked cookie (sb-<ref>-auth-token.0, .1, etc.)
    const parts = raw.split(";").map(c => c.trim());
    const authParts = parts
      .filter(c => /sb-.*-auth-token/.test(c))
      .sort()
      .map(c => c.split("=").slice(1).join("="));
    if (!authParts.length) return false;
    const decoded = decodeURIComponent(authParts.join(""));
    let token: string | null = null;
    try {
      const parsed = JSON.parse(decoded.startsWith("base64-") ? Buffer.from(decoded.slice(7), "base64").toString() : decoded);
      token = parsed?.access_token || null;
    } catch { return false; }
    if (!token) return false;
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      { auth: { persistSession: false } }
    );
    const { data: { user } } = await supabase.auth.getUser(token);
    return !!user;
  } catch { return false; }
}

function cleanTk(s: string): string {
  return String(s || "").toUpperCase().replace(/[^A-Z0-9.\-]/g, "").slice(0, 12);
}
function escAttr(s: string): string {
  return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Re-join crypto pairs the client splits on "-" (BTC-USD, ETH-CAD…) so a dash-separated stack keeps them
// whole — mirrors the client's parsePath so the SEO head matches what actually renders.
function mergeCrypto(parts: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    if (i + 1 < parts.length && /^(USD|CAD|USDT)$/i.test(parts[i + 1])) { out.push(parts[i] + "-" + parts[i + 1]); i++; }
    else out.push(parts[i]);
  }
  return out;
}

// Build the per-ticker SEO head from the URL path: single ticker, "A-vs-B" comparison, or an "A-B-C" stack.
function seoFor(raw: string): { title: string; desc: string; canonical: string } {
  if (/-vs-/i.test(raw)) {
    const parts = raw.split(/-vs-/i).map(cleanTk).filter(Boolean);
    if (parts.length >= 2) {
      const [a, b] = parts;
      return {
        title: `${a} vs ${b} — Head-to-Head Stock Comparison | Plainview X-Ray`,
        desc: `Compare ${a} vs ${b} side by side: 0–10 business-quality scores, fundamentals, valuation and momentum straight from SEC filings — see which has the better setup, free on Plainview.`,
        canonical: `${BASE}/x-ray/${a}-vs-${b}`,
      };
    }
  }
  // Split the stack into individual tickers FIRST, then clean each (so a multi-ticker path isn't truncated
  // by cleanTk's 12-char cap, which was chopping the last ticker, e.g. AMC-TSLA-NVDA → "AMC-TSLA-NVD").
  const stack = mergeCrypto(raw.split("-")).map(cleanTk).filter(Boolean);
  if (stack.length === 1) {
    const t = stack[0];
    return {
      title: `${t} Stock Analysis — Score, Fundamentals & Buy Zone | Plainview X-Ray`,
      desc: `${t} X-Ray: a 0–10 business-quality score built from SEC filings — revenue, margins, cash, short interest and a confluence buy zone. Know ${t} in seconds, free on Plainview.`,
      canonical: `${BASE}/x-ray/${t}`,
    };
  }
  if (stack.length >= 2) {
    const list = stack.slice(0, 5); // cap the head at 5 names so the title stays sane
    const human = list.length === 2 ? `${list[0]} & ${list[1]}` : `${list.slice(0, -1).join(", ")} & ${list[list.length - 1]}`;
    return {
      title: `${human} — Stock Analysis & Scores | Plainview X-Ray`,
      desc: `Side-by-side X-Ray of ${list.join(", ")}: 0–10 business-quality scores, fundamentals, valuation and buy zones straight from SEC filings — free on Plainview.`,
      canonical: `${BASE}/x-ray/${list.join("-")}`,
    };
  }
  return {
    title: "Plainview X-Ray — know any stock in seconds",
    desc: "X-Ray any stock, ETF, or crypto — SEC filings, fundamentals, and a 0–10 health score. Then stress-test your thesis.",
    canonical: `${BASE}/x-ray`,
  };
}

// Internal linking — sector peers from the sitemap set. Gives Google a link web between X-Ray pages.
const SECTOR_PEERS: Record<string, string[]> = {
  "Technology":["AAPL","MSFT","GOOGL","AMZN","NVDA","META","TSLA","AVGO","AMD","NFLX","ADBE","CRM","ORCL","INTC","CSCO","QCOM","TXN","IBM","NOW","AMAT","MU","ARM","SMCI","MRVL","ASML","TSM","ON","LRCX","KLAC","WOLF","PLTR","SHOP","SQ","PYPL","COIN","ROKU","RBLX","SNAP","UBER","LYFT","ABNB","DKNG","PINS","HOOD"],
  "Financial Services":["JPM","BAC","WFC","GS","MS","C","SCHW","V","MA","AXP","BRK-B","BLK","COF","SOFI"],
  "Healthcare":["UNH","JNJ","LLY","PFE","MRK","ABBV","TMO","ABT","BMY","AMGN","GILD","MRNA","CVS"],
  "Consumer":["WMT","COST","HD","LOW","NKE","SBUX","MCD","TGT","DIS","KO","PEP","PG","CMG","LULU","AMC","GME","RIVN","LCID","NIO","F","GM"],
  "Energy":["XOM","CVX","COP","OXY","SLB"],
  "Industrial":["BA","CAT","GE","HON","LMT","RTX","DE","UPS","FDX"],
  "Communication Services":["T","VZ","TMUS","CMCSA","WBD"],
};
function sectorPeers(ticker: string): string[] {
  const t = ticker.toUpperCase();
  for (const peers of Object.values(SECTOR_PEERS)) { if (peers.includes(t)) return peers.filter(p => p !== t); }
  return [];
}

// JSON-LD structured data — helps Google understand the page as financial analysis (can earn rich snippets).
function buildJsonLd(t: string, x: XrayResult, canonical: string): string {
  const name = x.name || t;
  const all = [...(x.metrics || []), ...(x.valuation || [])];
  const pick = (label: string) => { const c = all.find(m => m.label === label); return c?.value != null ? String(c.value).trim() : null; };
  const sector = pick("Sector");
  const price = pick("Current Price");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ld: Record<string, any> = {
    "@context": "https://schema.org",
    "@type": "Dataset",
    name: `${name} (${t}) — Business Quality Analysis`,
    description: `Plainview X-Ray analysis of ${name} (${t})${sector ? ` in ${sector}` : ""}: a ${typeof x.score === "number" ? x.score.toFixed(1) + "/10" : ""} business-quality score built from SEC filings.`,
    url: canonical,
    creator: { "@type": "Organization", name: "Plainview", url: "https://plainviewintel.com" },
    license: "https://plainviewintel.com/terms",
    isAccessibleForFree: true,
    keywords: [t, name, "stock analysis", "SEC filings", "business quality score", sector].filter(Boolean),
  };
  if (price) ld.variableMeasured = { "@type": "PropertyValue", name: "Business Quality Score", value: x.score, unitText: "out of 10" };
  return `<script type="application/ld+json">${JSON.stringify(ld)}</script>`;
}

// Crawlable per-ticker content (the SEO ranking lever) — server-rendered into #results so the page isn't
// a thin shell. The client's scan replaces it the moment JS runs, so users never see a duplicate. Built
// from the same deterministic X-Ray facts. Kept text-light + honest (no claims).
function buildSeoBlock(t: string, x: XrayResult): string {
  const name = escAttr(x.name || t);
  const all = [...(x.metrics || []), ...(x.valuation || [])];
  const pick = (label: string) => { const c = all.find((m) => m.label === label); const v = c && c.value != null ? String(c.value).trim() : ""; return v && !/^n\/a$/i.test(v) ? escAttr(v) : null; };
  const sub = [pick("Sector"), pick("Industry")].filter(Boolean).join(" · ");
  const score = typeof x.score === "number" ? x.score.toFixed(1) : "—";
  const stats: string[] = [];
  for (const lbl of ["Current Price", "YTD Return", "Revenue TTM", "Revenue Trend", "Gross Margin", "Net Cash", "EPS", "P/S Ratio"]) {
    const v = pick(lbl); if (v) stats.push(`<li><strong>${lbl}:</strong> ${v}</li>`);
  }
  const statsHtml = stats.length ? `<ul style="margin:10px 0 0;padding-left:18px;color:#c4c9d1;line-height:1.7;list-style:disc">${stats.join("")}</ul>` : "";
  // Derived fundamentals prose — richer, unique per-ticker body text (the SEO ranking lever), $0/deterministic.
  const rev = pick("Revenue TTM"), gm = pick("Gross Margin"), nc = pick("Net Cash"), eps = pick("EPS"), ps = pick("P/S Ratio"), rsi = pick("RSI");
  const fin: string[] = [];
  if (rev) fin.push(`trailing revenue of ${rev}`);
  if (gm) fin.push(`a ${gm} gross margin`);
  if (nc) fin.push(/-/.test(nc) ? `net debt of ${nc.replace(/-/g, "")}` : `net cash of ${nc}`);
  if (eps) fin.push(/-/.test(eps) ? `a loss per share of ${eps}` : `EPS of ${eps}`);
  const finP = fin.length ? `<p style="color:#c4c9d1;line-height:1.6;margin:9px 0 0">On the fundamentals, ${name} shows ${fin.join(", ")}${ps ? `, valued at about ${ps} times sales` : ""}.${rsi ? ` Its 14-day RSI reads ${rsi}.` : ""} X-Ray measures business quality only — momentum and entry timing live in Decide and Opportunity Cost.</p>` : "";
  const peers = sectorPeers(t).slice(0, 6);
  const peerLinks = peers.length >= 2
    ? `<p style="color:#7e8794;font-size:13px;line-height:1.7;margin:12px 0 0">`
      + `Compare: ${peers.slice(0, 3).map(p => `<a href="${BASE}/x-ray/${escAttr(t)}-vs-${escAttr(p)}" style="color:#1fdf64;text-decoration:none">${escAttr(t)} vs ${escAttr(p)}</a>`).join(" · ")} `
      + `| Also: ${peers.map(p => `<a href="${BASE}/x-ray/${escAttr(p)}" style="color:#b4bac3;text-decoration:none">${escAttr(p)}</a>`).join(", ")}</p>`
    : "";
  return `<section class="xr-seo" style="max-width:760px;margin:0 auto;padding:6px 2px 0">`
    + `<h1 style="font-size:21px;font-weight:700;color:#e8eaed;margin:0 0 8px">${name} (${escAttr(t)}) stock analysis</h1>`
    + `<p style="color:#c4c9d1;line-height:1.6;margin:0">${name}${sub ? ` — ${sub}` : ""} carries a Plainview business-quality score of <strong>${score}/10</strong>, built deterministically from SEC filings and Yahoo Finance: revenue, margins, cash, valuation, and a confluence buy zone. The live X-Ray loads below.</p>`
    + finP
    + statsHtml
    + peerLinks
    + `</section>`;
}

export async function GET(req: Request, context: { params: Promise<{ tickers?: string[] }> }) {
  let html = await readFile(path.join(process.cwd(), "src", "app", "x-ray.html"), "utf8");

  const { tickers } = await context.params;
  const raw = (Array.isArray(tickers) ? tickers.join("/") : String(tickers || "")).trim();
  const { title, desc, canonical } = seoFor(raw);

  // Swap the generic title + description for the per-ticker ones, and inject canonical + Open Graph.
  html = html.replace(/<title>[\s\S]*?<\/title>/, `<title>${escAttr(title)}</title>`);
  html = html.replace(/<meta name="description"[^>]*>/, `<meta name="description" content="${escAttr(desc)}">`);
  const ogHead =
    `<link rel="canonical" href="${canonical}">` +
    `<meta property="og:type" content="website">` +
    `<meta property="og:site_name" content="Plainview">` +
    `<meta property="og:title" content="${escAttr(title)}">` +
    `<meta property="og:description" content="${escAttr(desc)}">` +
    `<meta property="og:url" content="${canonical}">` +
    `<meta name="twitter:card" content="summary_large_image">` +
    `<meta name="twitter:title" content="${escAttr(title)}">` +
    `<meta name="twitter:description" content="${escAttr(desc)}">`;
  html = html.replace("</head>", ogHead + "</head>");

  // SEO content lever — for a single (non-crypto) ticker, server-render real content from the CANONICAL
  // /api/xray route (same score + full metrics array the client renders). The lite `runXray` path was
  // missing fundamentals (Revenue, Margins, EPS all n/a) + diverged on score (AMC 5.0 lite vs 4.1 card).
  // bg=1 prevents the fetch from logging as a user "X-Ray" search in the activity feed.
  // Bounded by a short timeout so a human never waits on the crawler path.
  const isCompare = /-vs-/i.test(raw);
  const stack = isCompare ? [] : mergeCrypto(raw.split("-")).map(cleanTk).filter(Boolean);
  const single = (!isCompare && stack.length === 1) ? stack[0] : null;
  if (single && !/-(USD|CAD|USDT)$/i.test(single)) {
    try {
      const xray: XrayResult | null = await Promise.race([
        fetch(`${BASE}/api/xray/${encodeURIComponent(single)}?bg=1`, { cache: "no-store" })
          .then(r => r.ok ? r.json() as Promise<XrayResult> : null)
          .catch(() => null),
        new Promise<null>((r) => setTimeout(() => r(null), 4500)),
      ]);
      if (xray && typeof xray.score === "number") {
        html = html.replace('<div id="results"></div>', `<div id="results">${buildSeoBlock(single, xray)}</div>`);
        // Enrich meta description + OG with live data so Google snippets and social previews carry the score.
        const xName = escAttr(xray.name || single);
        const all = [...(xray.metrics || []), ...(xray.valuation || [])];
        const sectorVal = all.find(m => m.label === "Sector")?.value;
        const xSector = sectorVal ? escAttr(String(sectorVal)) : null;
        const liveDesc = `${xName} scores ${xray.score.toFixed(1)}/10 on Plainview X-Ray${xSector ? ` (${xSector})` : ""} — revenue, margins, cash, valuation and a buy zone built from SEC filings. Free.`;
        const liveTitle = `${xName} (${escAttr(single)}) — ${xray.score.toFixed(1)}/10 Business Quality | Plainview X-Ray`;
        html = html.replace(/<meta name="description" content="[^"]*">/, `<meta name="description" content="${liveDesc}">`);
        html = html.replace(/<meta property="og:description" content="[^"]*">/, `<meta property="og:description" content="${liveDesc}">`);
        html = html.replace(/<meta name="twitter:description" content="[^"]*">/, `<meta name="twitter:description" content="${liveDesc}">`);
        html = html.replace(/<title>[^<]*<\/title>/, `<title>${liveTitle}</title>`);
        html = html.replace(/<meta property="og:title" content="[^"]*">/, `<meta property="og:title" content="${liveTitle}">`);
        html = html.replace(/<meta name="twitter:title" content="[^"]*">/, `<meta name="twitter:title" content="${liveTitle}">`);
        html = html.replace("</head>", buildJsonLd(single, xray, canonical) + "</head>");
      }
    } catch { /* fail-soft — serve the shell */ }
  }

  const loggedIn = await isLoggedIn(req);
  if (loggedIn) html = html.replace("window.__pvAuth=false", "window.__pvAuth=true");
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": loggedIn ? "no-store" : "public, s-maxage=3600, stale-while-revalidate=86400",
    },
  });
}
