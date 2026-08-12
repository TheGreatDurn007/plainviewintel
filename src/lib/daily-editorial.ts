/**
 * The Daily Editorial — Plainview's market email.
 * General editorial (same for everyone) + personal insert (active users only).
 * AI cost: $0 (free cascade: Cerebras → Groq → Gemini).
 */

import { callCerebrasText, callGroqText, callGeminiText, fetchRecentNews } from "@/lib/market-context";
import type { MarketContext } from "@/lib/daily-brief";
import { createClient } from "@supabase/supabase-js";

const APP = process.env.NEXT_PUBLIC_SITE_URL || "https://plainviewintel.com";
function admin() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
}

const C = {
  bg: "#0a0b0d", surface: "#111214", bd: "#1e2025",
  green: "#1fdf64", red: "#ff5c5c", amber: "#ff9500",
  t: "#e8e8e8", t2: "#b0b0b0", t3: "#666",
};
const MONO = "'SF Mono','Fira Code','Cascadia Code',monospace";

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function displayTicker(t: string): string {
  const wm = t.match(/^([A-Z0-9]+)[.\-](WS|WT|WR|RT)$/i);
  if (wm) return `${wm[1].toUpperCase()}-WT`;
  return t;
}

// ── EXTENDED MARKET DATA ──────────────────────────────────────────────────

type ExtendedMarket = MarketContext & {
  oil: number | null;
  gold: number | null;
  tenYear: number | null;
  oilChg: number | null;
  goldChg: number | null;
};

export async function fetchExtendedMarket(base: MarketContext): Promise<ExtendedMarket> {
  const ext: ExtendedMarket = { ...base, oil: null, gold: null, tenYear: null, oilChg: null, goldChg: null };
  try {
    const secret = process.env.CRON_SECRET;
    const r = await fetch(`${APP}/api/prices?symbols=${encodeURIComponent("CL=F,GC=F,^TNX")}`, {
      headers: secret ? { "x-cron-secret": secret } : {},
    });
    if (r.ok) {
      const j = await r.json();
      for (const p of j.prices || []) {
        const s = String(p.symbol).toUpperCase();
        const chg = typeof p.changePercent === "number" ? p.changePercent : null;
        if (s === "CL=F") { ext.oil = p.price; ext.oilChg = chg; }
        if (s === "GC=F") { ext.gold = p.price; ext.goldChg = chg; }
        if (s === "^TNX") { ext.tenYear = p.price; }
      }
    }
  } catch { /* fail-soft */ }
  return ext;
}

// ── MARKET MOVERS ─────────────────────────────────────────────────────────

type Mover = { symbol: string; name: string; changePercent: number; headline: string };

async function fetchTopMovers(limit = 6): Promise<Mover[]> {
  try {
    const secret = process.env.CRON_SECRET;
    const r = await fetch(`${APP}/api/movers`, {
      headers: secret ? { "x-cron-secret": secret } : {},
    });
    if (!r.ok) return [];
    const j = await r.json();
    const raw: Array<{ symbol: string; name: string; changePercent: number | null }> = j.movers || [];
    const sorted = raw
      .filter(m => m.changePercent != null && Math.abs(m.changePercent!) >= 1)
      .sort((a, b) => Math.abs(b.changePercent!) - Math.abs(a.changePercent!))
      .slice(0, limit);

    const withHeadlines = await Promise.all(sorted.map(async m => {
      let headline = "";
      try {
        const news = await fetchRecentNews(m.symbol);
        if (news.length) headline = news[0].replace(/^\d{4}-\d{2}-\d{2}\s+—\s+/, "").slice(0, 90);
      } catch { /* no headline */ }
      return { symbol: m.symbol, name: m.name, changePercent: m.changePercent!, headline: headline || `${m.name} moved on volume` };
    }));
    return withHeadlines;
  } catch { return []; }
}

// ── AI NARRATIVE ──────────────────────────────────────────────────────────

function buildFactPayload(market: ExtendedMarket, movers: Mover[]): string {
  const parts: string[] = [];
  if (market.sp != null) parts.push(`S&P 500: ${market.sp > 0 ? "+" : ""}${market.sp.toFixed(1)}%`);
  if (market.nasdaq != null) parts.push(`Nasdaq: ${market.nasdaq > 0 ? "+" : ""}${market.nasdaq.toFixed(1)}%`);
  if (market.vix != null) parts.push(`VIX: ${market.vix.toFixed(1)}`);
  if (market.oil != null) parts.push(`Oil (WTI): $${market.oil.toFixed(0)}${market.oilChg != null ? ` (${market.oilChg > 0 ? "+" : ""}${market.oilChg.toFixed(1)}%)` : ""}`);
  if (market.gold != null) parts.push(`Gold: $${Math.round(market.gold).toLocaleString()}${market.goldChg != null ? ` (${market.goldChg > 0 ? "+" : ""}${market.goldChg.toFixed(1)}%)` : ""}`);
  if (market.tenYear != null) parts.push(`10Y yield: ${market.tenYear.toFixed(2)}%`);

  if (market.sectors.length) {
    const top = market.sectors.slice(0, 3).map(s => `${s.name} ${s.day > 0 ? "+" : ""}${s.day.toFixed(1)}%`);
    const bot = market.sectors.slice(-3).map(s => `${s.name} ${s.day > 0 ? "+" : ""}${s.day.toFixed(1)}%`);
    parts.push(`Top sectors: ${top.join(", ")}`);
    parts.push(`Bottom sectors: ${bot.join(", ")}`);
  }

  if (movers.length) {
    parts.push("Notable movers:");
    for (const m of movers) {
      parts.push(`  ${m.symbol} (${m.name}) ${m.changePercent > 0 ? "+" : ""}${m.changePercent.toFixed(1)}% — ${m.headline}`);
    }
  }

  return parts.join("\n");
}

const EDITORIAL_PROMPT = `You are PLAINVIEW — a market analyst writing the daily close recap for an investing intelligence platform. Your readers are self-directed investors who want to know what happened today and why it matters.

VOICE: Sharp, informed, zero hype. Think Bloomberg terminal meets a smart friend who actually reads the filings. Short sentences. Active voice. Present tense for today.

Write exactly TWO sections:

RECAP (3-5 sentences): What happened in markets today and why. Lead with the headline move, connect it to what drove it (Fed, earnings, sector rotation, geopolitics), and note any divergences worth watching. If the day was boring, say so — don't inflate nothing.

ONE THING (1-2 sentences): The single most important thing going into tomorrow's session. Not a prediction — a setup. What to watch and why it matters.

RULES:
- Use ONLY the facts below. NEVER invent a number, ticker, or event.
- No greeting, no sign-off, no markdown headers, no bullet points.
- Separate the two sections with a blank line.
- No clichés ("buckle up", "all eyes on", "in conclusion"). No emojis in the text.

FACTS:
`;

async function composeEditorial(facts: string): Promise<{ recap: string; oneThing: string } | null> {
  if (!facts.trim()) return null;
  const prompt = EDITORIAL_PROMPT + facts;

  const clean = (s: string | null | undefined) => String(s || "").trim().replace(/^["']+|["']+$/g, "").trim();
  const parse = (text: string): { recap: string; oneThing: string } | null => {
    const parts = text.split(/\n\s*\n/).filter(p => p.trim());
    if (parts.length < 2) return null;
    return { recap: clean(parts[0]), oneThing: clean(parts[parts.length - 1]) };
  };
  const audit = (text: string): boolean => {
    const norm = (s: string) => s.replace(/[\s+,]/g, "");
    const f = norm(facts);
    const risky = text.match(/\$\d[\d.]*[a-zA-Z]?|-?\d[\d.]*%/g) || [];
    return risky.every(r => f.includes(norm(r)));
  };

  for (const call of [callCerebrasText, callGroqText, callGeminiText]) {
    try {
      const raw = await call(prompt, 0.3);
      const out = clean(raw);
      if (out.length > 50 && out.length < 2000 && audit(out)) {
        const parsed = parse(out);
        if (parsed && parsed.recap.length > 30 && parsed.oneThing.length > 15) return parsed;
      }
    } catch { /* next */ }
  }
  return null;
}

// ── PERSONAL INSERT ───────────────────────────────────────────────────────

type UserHolding = { ticker: string; dayMove: number };

export async function buildPersonalInsert(
  userId: string,
  dayMovesMap: Record<string, number>,
): Promise<string> {
  const sb = admin();
  // Load user's positions
  const { data: stateData } = await sb.storage.from("plainview-state").download(`${userId}/state.json`);
  if (!stateData) return "";
  const state = JSON.parse(await stateData.text());
  const positions: Array<{ id?: string }> = state?.positions || [];
  if (!positions.length) return "";

  // Fetch day changes for user's positions that aren't already in the global map
  const tickers = positions.map(p => String(p.id || "").toUpperCase()).filter(Boolean);
  const missing = tickers.filter(tk => dayMovesMap[tk] == null);
  if (missing.length) {
    try {
      const secret = process.env.CRON_SECRET;
      const r = await fetch(`${APP}/api/prices?symbols=${encodeURIComponent(missing.join(","))}`, {
        headers: secret ? { "x-cron-secret": secret } : {},
      });
      if (r.ok) {
        const j = await r.json();
        for (const p of j.prices || []) {
          if (typeof p.changePercent === "number") dayMovesMap[String(p.symbol).toUpperCase()] = Math.round(p.changePercent * 10) / 10;
        }
      }
    } catch { /* fail-soft */ }
  }

  const moved: UserHolding[] = [];
  for (const tk of tickers) {
    const day = dayMovesMap[tk];
    if (day != null && Math.abs(day) >= 1) moved.push({ ticker: tk, dayMove: day });
  }
  if (!moved.length) return "";

  moved.sort((a, b) => Math.abs(b.dayMove) - Math.abs(a.dayMove));
  const lines = moved.slice(0, 5).map(m =>
    `<span style="font-family:monospace;font-weight:700;color:${m.dayMove >= 0 ? C.green : C.red}">${esc(displayTicker(m.ticker))} ${m.dayMove > 0 ? "+" : ""}${m.dayMove.toFixed(1)}%</span>`
  );

  // Thesis status summary
  const { data: evalData } = await sb.from("nexus_thesis_evaluations")
    .select("status")
    .eq("user_id", userId)
    .order("evaluated_at", { ascending: false })
    .limit(100);
  const evals = evalData ?? [];
  const latest = new Map<string, string>();
  for (const e of evals as Array<{ status: string }>) {
    if (!latest.has(e.status)) latest.set(e.status, e.status);
  }
  let thesisLine = "";
  const supported = evals.filter(e => (e as { status: string }).status === "supported").length;
  const contradicted = evals.filter(e => (e as { status: string }).status === "contradicted").length;
  if (supported || contradicted) {
    const parts: string[] = [];
    if (supported) parts.push(`${supported} supported`);
    if (contradicted) parts.push(`<span style="color:${C.red}">${contradicted} contradicted</span>`);
    thesisLine = ` &nbsp;·&nbsp; ${parts.join(" · ")}`;
  }

  return `<tr><td style="padding:18px 26px 0">
    <div style="font-size:11px;text-transform:uppercase;letter-spacing:.1em;color:${C.t3};font-weight:700;margin-bottom:6px">Your names today</div>
    <div style="font-size:13.5px;color:${C.t2};line-height:1.7">${lines.join(" &nbsp;·&nbsp; ")}${thesisLine}</div>
    <div style="margin-top:8px"><a href="${APP}" style="font-size:12px;color:${C.green};text-decoration:none;font-weight:600">View in Plainview →</a></div>
  </td></tr>`;
}

// ── EMAIL TEMPLATE ────────────────────────────────────────────────────────

function fmtDate(): string {
  return new Date().toLocaleDateString("en-US", { timeZone: "America/New_York", weekday: "long", month: "long", day: "numeric", year: "numeric" });
}

function dayOfWeek(): string {
  return new Date().toLocaleDateString("en-US", { timeZone: "America/New_York", weekday: "long" });
}

export async function buildEditorial(
  market: MarketContext,
): Promise<{ subject: string; html: string; text: string } | null> {
  const ext = await fetchExtendedMarket(market);
  const movers = await fetchTopMovers(6);
  const facts = buildFactPayload(ext, movers);
  const editorial = await composeEditorial(facts);

  if (!editorial) return null;

  const day = dayOfWeek();
  const date = fmtDate();
  const isWeekday = !["Saturday", "Sunday"].includes(day);

  // Market numbers row
  const nums: string[] = [];
  if (ext.sp != null) nums.push(`S&P ${ext.sp > 0 ? "+" : ""}${ext.sp.toFixed(1)}%`);
  if (ext.nasdaq != null) nums.push(`Nasdaq ${ext.nasdaq > 0 ? "+" : ""}${ext.nasdaq.toFixed(1)}%`);
  if (ext.vix != null) nums.push(`VIX ${ext.vix.toFixed(1)}`);
  const numsRow2: string[] = [];
  if (ext.oil != null) numsRow2.push(`Oil $${ext.oil.toFixed(0)}${ext.oilChg != null ? ` (${ext.oilChg > 0 ? "+" : ""}${ext.oilChg.toFixed(1)}%)` : ""}`);
  if (ext.gold != null) numsRow2.push(`Gold $${Math.round(ext.gold).toLocaleString()}`);
  if (ext.tenYear != null) numsRow2.push(`10Y ${ext.tenYear.toFixed(2)}%`);

  // Sectors
  const topSectors = ext.sectors.filter(s => s.day > 0).slice(0, 3).map(s => `${s.name} +${s.day.toFixed(1)}%`);
  const botSectors = ext.sectors.filter(s => s.day < 0).slice(-3).map(s => `${s.name} ${s.day.toFixed(1)}%`);

  // Mover rows
  const moverRows = movers.map(m =>
    `<div style="font-size:13px;color:${C.t2};padding:6px 0;border-top:1px solid ${C.bd};line-height:1.5"><span style="font-family:${MONO};font-weight:700;color:${m.changePercent >= 0 ? C.green : C.red}">${esc(m.symbol)} ${m.changePercent > 0 ? "+" : ""}${m.changePercent.toFixed(1)}%</span> &nbsp;${esc(m.headline)}</div>`
  ).join("");

  const subject = `Markets ${day}: ${nums.join(" · ")}`;

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"><meta name="supported-color-schemes" content="dark"><title>${esc(subject)}</title></head>
<body style="margin:0;padding:0;background:${C.bg};color:${C.t};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%">
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;opacity:0;color:transparent">${esc(editorial.recap.slice(0, 120))}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.bg}"><tr><td align="center"><table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:${C.bg}">

    <!-- MASTHEAD -->
    <tr><td style="padding:22px 26px 0">
      <table role="presentation" cellpadding="0" cellspacing="0"><tr>
        <td style="vertical-align:middle"><span style="display:inline-block;width:26px;height:26px;background:${C.green};border-radius:7px;color:${C.bg};font-weight:800;font-size:15px;text-align:center;line-height:26px;font-family:Arial">P</span></td>
        <td style="vertical-align:middle;padding-left:9px"><span style="font-weight:800;font-size:15px;color:${C.t};letter-spacing:.05em">PLAINVIEW</span> <span style="font-size:11px;color:${C.green};font-weight:700;letter-spacing:.1em">THE BRIEF</span></td>
        <td style="vertical-align:middle;padding-left:auto;text-align:right;font-size:12px;color:${C.t3}">${esc(date)}</td>
      </tr></table>
    </td></tr>

    <!-- THE MARKET (narrative) -->
    <tr><td style="padding:24px 26px 0">
      <div style="font-size:11px;text-transform:uppercase;letter-spacing:.1em;color:${C.t3};font-weight:700;margin-bottom:8px">The market</div>
      <div style="font-size:14px;color:${C.t2};line-height:1.6">${esc(editorial.recap)}</div>
    </td></tr>

    <!-- NUMBERS -->
    <tr><td style="padding:14px 26px 0">
      <div style="font-size:13.5px;color:${C.t};font-family:${MONO};letter-spacing:.02em">${nums.map(n => esc(n)).join(" &nbsp;·&nbsp; ")}</div>
      ${numsRow2.length ? `<div style="font-size:12.5px;color:${C.t3};font-family:${MONO};margin-top:3px">${numsRow2.map(n => esc(n)).join(" &nbsp;·&nbsp; ")}</div>` : ""}
    </td></tr>

    %%PERSONAL%%

    <!-- SECTORS -->
    ${ext.sectors.length ? `<tr><td style="padding:20px 26px 0">
      <div style="font-size:11px;text-transform:uppercase;letter-spacing:.1em;color:${C.t3};font-weight:700;margin-bottom:6px">Sectors</div>
      ${topSectors.length ? `<div style="font-size:13px;color:${C.green};padding:2px 0">▲ ${topSectors.join(" &nbsp;·&nbsp; ")}</div>` : ""}
      ${botSectors.length ? `<div style="font-size:13px;color:${C.red};padding:2px 0">▼ ${botSectors.join(" &nbsp;·&nbsp; ")}</div>` : ""}
    </td></tr>` : ""}

    <!-- MOVERS -->
    ${moverRows ? `<tr><td style="padding:20px 26px 0">
      <div style="font-size:11px;text-transform:uppercase;letter-spacing:.1em;color:${C.t3};font-weight:700;margin-bottom:6px">What moved</div>
      ${moverRows}
    </td></tr>` : ""}

    <!-- ONE THING -->
    <tr><td style="padding:22px 26px 0">
      <div style="font-size:11px;text-transform:uppercase;letter-spacing:.1em;color:${C.amber};font-weight:700;margin-bottom:6px">One thing to watch</div>
      <div style="font-size:14px;color:${C.t};line-height:1.6;font-style:italic">${esc(editorial.oneThing)}</div>
    </td></tr>

    <!-- CTA -->
    <tr><td style="padding:24px 26px">
      <a href="${APP}" style="display:inline-block;background:${C.green};color:${C.bg};font-weight:700;font-size:13px;padding:10px 22px;border-radius:8px;text-decoration:none">Investigate in Plainview →</a>
    </td></tr>

    <!-- FOOTER -->
    <tr><td style="padding:16px 26px 26px;border-top:1px solid ${C.bd}">
      <div style="font-size:11px;color:${C.t3};line-height:1.6">
        Plainview — know any stock in seconds, on the facts.<br>
        <a href="%%UNSUB%%" style="color:${C.t3};text-decoration:underline">Unsubscribe</a>
      </div>
    </td></tr>

</table></td></tr></table>
</body></html>`;

  // Plain text fallback
  const text = [
    `PLAINVIEW — THE BRIEF — ${date}`,
    "",
    "THE MARKET",
    editorial.recap,
    "",
    nums.join(" · "),
    numsRow2.join(" · "),
    "%%PERSONAL%%",
    "",
    topSectors.length ? `▲ ${topSectors.join(" · ")}` : "",
    botSectors.length ? `▼ ${botSectors.join(" · ")}` : "",
    "",
    movers.length ? "WHAT MOVED" : "",
    ...movers.map(m => `${m.symbol} ${m.changePercent > 0 ? "+" : ""}${m.changePercent.toFixed(1)}% — ${m.headline}`),
    "",
    "ONE THING TO WATCH",
    editorial.oneThing,
    "",
    `Investigate in Plainview → ${APP}`,
    "",
    "Unsubscribe: %%UNSUB%%",
  ].filter(l => l !== undefined).join("\n");

  return { subject, html, text };
}
