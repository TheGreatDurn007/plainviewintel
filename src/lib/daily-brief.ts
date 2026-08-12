import { createClient } from "@supabase/supabase-js";
import { createHmac, timingSafeEqual } from "crypto";
import { listActions } from "@/lib/nexus-memory";
import { callCerebrasText, callGroqText, callGeminiText } from "@/lib/market-context";
import { recordTickerObservation, recordPositionObservations } from "@/lib/ticker-context";
import Anthropic from "@anthropic-ai/sdk";
import { getJudgmentModel, autoDowngradeOnCreditDepletion } from "@/lib/ai-tier";
import { recordSmartSpend } from "@/lib/ai-spend";

// ── THE READ — a short, GROUNDED, Plainview-voiced narrative at the top of each brief: the voice of a
// plainspoken CIO writing the reader a note about THEIR book. Free-first LLM (~$0), temp 0, fed ONLY the real
// facts we gathered; FIGURE-AUDITED (any $/% in the prose that isn't in the facts → reject) so it can never
// invent (no repeat of fabricated numbers). Returns null on failure/audit-fail → caller uses the deterministic line.
async function composeBriefNarrative(slot: "am" | "pm" | undefined, facts: string): Promise<string | null> {
  if (!facts.trim()) return null;
  const when = slot === "pm" ? "evening" : slot === "am" ? "morning" : "daily";
  const arc = slot === "pm"
    ? "This is the EVENING note — how today played out and what it sets up for tomorrow."
    : slot === "am"
      ? "This is the MORNING note — what happened yesterday and what to watch today, before the open."
      : "A note on where their portfolio stands.";
  const prompt = `You are PLAINVIEW — the investor's own analyst, writing a ${when} note about THEIR portfolio. ${arc}
VOICE: decisive, dry, commanding, allergic to noise — ruthlessly CLEAR, never aggressive, never theatrical. You've seen every cycle and waste no words; confidence without hype, gravitas without barking orders.
Write 4 to 6 flowing sentences. RULES:
- Use ONLY the facts below. NEVER invent a number, ticker, company, or event not listed. (Every figure you write is checked against the facts; an invented one gets the whole note thrown out.)
- DISCUSS the real movers by name and what drove them (the why is in the facts — a headline, a filing, a sector move). e.g. "AMC pushed 8% higher as May attendance fueled a rebound."
- Read the market backdrop and connect it to THEIR names — which sectors led or lagged, and what that means for what they own.
- Take a STANCE: land on the ONE thing that matters and what it tells you. OBSERVE and assess; do not issue orders ("buy X").
- No greeting, no sign-off, no markdown, no lists — flowing prose. If a cause isn't given, say "on no company news"; never speculate.

FACTS:
${facts}`;
  const norm = (s: string) => s.replace(/[\s+,]/g, "");
  const audit = (text: string): boolean => {
    const f = norm(facts);
    const risky = text.match(/\$\d[\d.]*[a-zA-Z]?|-?\d[\d.]*%/g) || [];   // dollar amounts + percentages
    return risky.every((r) => f.includes(norm(r)));
  };
  const clean = (s: string | null | undefined) => String(s || "").trim().replace(/^["']+|["']+$/g, "").trim();
  // FREE CASCADE FIRST — Cerebras→Groq→Gemini at $0. Anthropic is the emergency-only fallback.
  for (const call of [callCerebrasText, callGroqText, callGeminiText]) {
    try {
      const out = clean(await call(prompt, 0));
      if (out.length > 20 && out.length < 900 && audit(out)) return out;
    } catch { /* try the next provider */ }
  }
  // Anthropic fallback — only fires when all free providers failed. Figure-audited either way.
  const smart = await getJudgmentModel();
  if (process.env.ANTHROPIC_API_KEY) {
    try {
      const model = smart || "claude-haiku-4-5-20251001";
      const a = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: 25000 });
      const res = await a.messages.create({ model, max_tokens: 340, temperature: 0.4, messages: [{ role: "user", content: prompt }] });
      const out = clean(res.content.filter((b) => b.type === "text").map((b) => (b as unknown as { text: string }).text).join(""));
      if (out.length > 20 && out.length < 900 && audit(out)) { if (smart) void recordSmartSpend(smart, res.usage?.input_tokens || 0, res.usage?.output_tokens || 0); return out; }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("credit balance")) void autoDowngradeOnCreditDepletion();
    }
  }
  return null;
}

// Shared daily-brief builder + sender — used by the owner-test route AND the all-users cron, so the email
// can never drift between them. Deterministic ($0), built from the thesis ledger. Fail-soft throughout.
const APP = "https://plainviewintel.com";

function admin() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
}

// ── UNSUBSCRIBE — a real, working opt-out. One global suppression list (stops ALL Plainview emails); every
// send checks it and is hard-blocked for a suppressed address. The unsubscribe link is per-recipient and
// signed (HMAC) so it can't be used to opt someone else out. Powers both the in-body link AND the
// List-Unsubscribe header (mailbox-provider one-click). Fail-open on reads; a write failure never sends.
const UNSUB_KEY = "_usage/_unsub.json";
export function unsubToken(email: string): string {
  return createHmac("sha256", process.env.CRON_SECRET || "pv-unsub").update(email.trim().toLowerCase()).digest("base64url").slice(0, 24);
}
export function unsubLink(email: string): string {
  return `${APP}/api/unsubscribe?e=${encodeURIComponent(email.trim().toLowerCase())}&t=${unsubToken(email)}`;
}
export function verifyUnsub(email: string, token: string): boolean {
  try { const a = Buffer.from(unsubToken(email)); const b = Buffer.from(String(token || "")); return a.length === b.length && timingSafeEqual(a, b); } catch { return false; }
}
async function unsubMap(db: ReturnType<typeof admin>): Promise<Record<string, { ts: number; source: string }>> {
  try { const { data } = await db.storage.from("plainview-state").download(UNSUB_KEY); if (data) { const j = JSON.parse(await data.text()); if (j && typeof j === "object") return j; } } catch { /* none yet */ }
  return {};
}
export async function isSuppressed(email: string): Promise<boolean> {
  try { const m = await unsubMap(admin()); return !!m[email.trim().toLowerCase()]; } catch { return false; }
}
export async function suppressEmail(email: string, source = "link"): Promise<void> {
  try { const db = admin(); const m = await unsubMap(db); m[email.trim().toLowerCase()] = { ts: Date.now(), source };
    await db.storage.from("plainview-state").upload(UNSUB_KEY, new Blob([JSON.stringify(m)], { type: "application/json" }), { upsert: true, contentType: "application/json" });
  } catch { /* best-effort */ }
}
export async function resubscribeEmail(email: string): Promise<void> {
  try { const db = admin(); const m = await unsubMap(db); delete m[email.trim().toLowerCase()];
    await db.storage.from("plainview-state").upload(UNSUB_KEY, new Blob([JSON.stringify(m)], { type: "application/json" }), { upsert: true, contentType: "application/json" });
  } catch { /* best-effort */ }
}

// Load a user's book (name + holdings) from Storage so the brief can speak to THEIR money, not aggregates.
// Fail-open → empty book (the brief still works off the ledger alone).
type Book = { displayName: string; positions: Array<Record<string, unknown>>; watchlist: Array<Record<string, unknown>> };
async function loadUserBook(userId: string): Promise<Book> {
  try {
    const { data, error } = await admin().storage.from("plainview-state").download(`${userId}/state.json`);
    if (error || !data) return { displayName: "", positions: [], watchlist: [] };
    const s = JSON.parse(await data.text());
    return {
      displayName: String(s?.appSettings?.displayName || "").trim(),
      positions: Array.isArray(s?.positions) ? s.positions : [],
      watchlist: Array.isArray(s?.watchlist) ? s.watchlist : [],
    };
  } catch { return { displayName: "", positions: [], watchlist: [] }; }
}

// ── NEWS DEDUPE across the AM↔PM loop — never show the same article twice in one day (owner: "boring to send
// twice"). Headlines shown this morning are excluded tonight, and vice versa; resets each calendar day. The
// two emails complement instead of repeat. Stored per user in _briefnews.json.
async function loadSeenNews(userId: string): Promise<{ date: string; keys: string[] }> {
  try {
    const { data, error } = await admin().storage.from("plainview-state").download(`${userId}/_briefnews.json`);
    if (error || !data) return { date: "", keys: [] };
    const j = JSON.parse(await data.text());
    return { date: String(j?.date || ""), keys: Array.isArray(j?.keys) ? j.keys : [] };
  } catch { return { date: "", keys: [] }; }
}
async function saveSeenNews(userId: string, date: string, keys: string[]): Promise<void> {
  try { await admin().storage.from("plainview-state").upload(`${userId}/_briefnews.json`, JSON.stringify({ date, keys: keys.slice(-80) }), { upsert: true, contentType: "application/json" }); } catch { /* fail-soft */ }
}

// Per-holding recap signals the morning sweep captures from thesis-check's existing fetches ($0): overnight
// move, today's volume vs average, price-vs-50-day, position in the 52-week range, and the material filings
// (dilution / insider buy-sell) that actually warrant a look. Stored in {userId}/_brief.json by the sweep.
export type BriefSignals = { day: number | null; volX: number | null; ma: "above" | "below" | null; near52: number | null; sector?: string | null; news?: string[]; material: Array<{ kind: "dilution" | "offering_done" | "insider_buy" | "insider_sell" | "filing"; text: string; date: string }> };
async function loadSignalFile(userId: string, file: string): Promise<Record<string, BriefSignals> | null> {
  try {
    const { data, error } = await admin().storage.from("plainview-state").download(`${userId}/${file}`);
    if (error || !data) return null;
    const s = JSON.parse(await data.text());
    return (s && typeof s.tickers === "object" && s.tickers) ? s.tickers : null;
  } catch { return null; }
}
// The MORNING brief reports yesterday's CLOSE (movers/volume/sectors are meaningless at 8am pre-market), so it
// reads `_close.json` (snapshotted by the evening run); PM/default read the live `_brief.json`. Falls back if
// the close snapshot doesn't exist yet (day one).
async function loadBriefSignals(userId: string, slot?: "am" | "pm"): Promise<Record<string, BriefSignals>> {
  if (slot === "am") return (await loadSignalFile(userId, "_close.json")) || (await loadSignalFile(userId, "_brief.json")) || {};
  return (await loadSignalFile(userId, "_brief.json")) || {};
}
const MAT_LABEL: Record<string, string> = { dilution: "a dilution filing", offering_done: "completed its offering — overhang cleared", insider_buy: "insider buying", insider_sell: "insider selling", filing: "a new filing" };
// Compact texture line — only the parts worth saying (a real move, unusual volume, which side of the 50-day).
function recapStr(sig?: BriefSignals): string {
  if (!sig) return "";
  const p: string[] = [];
  if (sig.day != null && Math.abs(sig.day) >= 0.1) p.push(`${sig.day > 0 ? "+" : ""}${sig.day}% today`);
  if (sig.volX != null && sig.volX >= 1.8) p.push(`${sig.volX}× avg volume`);
  if (sig.ma) p.push(`${sig.ma} its 50-day`);
  return p.join(" · ");
}

// Market context for the brief's "your portfolio vs the market" line — the index day-moves, from the canonical
// /api/prices (cron-authed so it passes middleware). Global (same for everyone) → fetch ONCE per cron batch
// and pass into buildBrief, not per user. Fail-open → null (the line just omits the market half).
export type MarketContext = { sp: number | null; nasdaq: number | null; vix: number | null; sectors: Array<{ name: string; day: number }> };
const SECTOR_ETFS: Record<string, string> = { XLK: "Technology", XLF: "Financials", XLE: "Energy", XLV: "Health Care", XLI: "Industrials", XLY: "Consumer Disc.", XLP: "Consumer Staples", XLU: "Utilities", XLB: "Materials", XLRE: "Real Estate", XLC: "Communication" };
export async function fetchMarketContext(): Promise<MarketContext | null> {
  const secret = process.env.CRON_SECRET;
  try {
    const syms = ["^GSPC", "^IXIC", "^VIX", ...Object.keys(SECTOR_ETFS)].join(",");
    const res = await fetch(`${APP}/api/prices?symbols=${encodeURIComponent(syms)}`, { headers: secret ? { "x-cron-secret": secret } : {} });
    if (!res.ok) return null;
    const j = await res.json();
    const by: Record<string, number | null> = {};
    for (const p of (j.prices || [])) by[String(p.symbol).toUpperCase()] = typeof p.changePercent === "number" ? p.changePercent : null;
    const sectors = Object.entries(SECTOR_ETFS)
      .map(([etf, name]) => ({ name, day: by[etf] }))
      .filter((s): s is { name: string; day: number } => typeof s.day === "number")
      .sort((a, b) => b.day - a.day);
    const out: MarketContext = { sp: by["^GSPC"] ?? null, nasdaq: by["^IXIC"] ?? null, vix: by["^VIX"] ?? null, sectors };
    return (out.sp == null && out.nasdaq == null && out.vix == null && !sectors.length) ? null : out;
  } catch { return null; }
}

// Build a user's morning brief — a DECISION digest, not a news digest. Leads with the reader's OWN book
// (personalized), surfaces only what CHANGED ("needs attention"), and on a quiet day says the most valuable
// thing of all: nothing changed your theses — hold the line. Each line gives the headline judgment (the WHAT)
// and links inside for the depth (the WHY). Demotes the aggregate stat to a footnote. Deterministic ($0),
// dark/on-brand, with a preheader + plain-text alt. Returns null only when there's genuinely nothing to say.
export async function buildBrief(userId: string, market?: MarketContext | null, slot?: "am" | "pm", opts?: { markSeen?: boolean }): Promise<{ subject: string; html: string; text: string } | null> {
  const { data } = await admin().from("nexus_thesis_evaluations")
    .select("ticker, status, strength_score, evaluated_at")
    .eq("user_id", userId).order("evaluated_at", { ascending: false }).limit(500);
  const rows = data ?? [];
  const book = await loadUserBook(userId);

  const byTicker = new Map<string, typeof rows>();
  for (const r of rows) { const a = byTicker.get(r.ticker) ?? []; a.push(r); byTicker.set(r.ticker, a); }
  const strengths: { ticker: string; strength: number }[] = [];
  type Move = { ticker: string; status: string; strength: number | null; delta: number; dir: 1 | -1; contradicted: boolean };
  const moves: Move[] = [];
  for (const [ticker, list] of byTicker) {
    const latest = list[0];
    const s = latest.strength_score as number | null;
    const status = String(latest.status || "");
    if (s != null) strengths.push({ ticker, strength: s });
    // Compare against the most recent eval from a PRIOR DAY — the cron + multiple devices can re-score a
    // thesis several times in a single day; an intra-day re-score is NOT a "move". No prior-day eval → not
    // a change (it's new), so it never floods "what changed today".
    const latestDay = String(latest.evaluated_at || "").slice(0, 10);
    const prev = list.find((e) => String(e.evaluated_at || "").slice(0, 10) < latestDay) ?? null;
    if (!prev) continue;
    const contradicted = /contradict|unsupport/i.test(status);
    const prevContra = /contradict|unsupport/i.test(String(prev.status || ""));
    const d = (s != null && prev.strength_score != null) ? Math.round((s - prev.strength_score) * 10) / 10 : null;
    // Surface only a REAL day-over-day change: a meaningful strength delta, or a thesis that NEWLY became
    // contradicted today (not one that's simply been contradicted for days).
    if ((d != null && Math.abs(d) >= 0.5) || (contradicted && !prevContra)) {
      moves.push({ ticker, status, strength: s, delta: d ?? 0, dir: (d ?? 0) >= 0 ? 1 : -1, contradicted });
    }
  }
  // Buy-zone entries — an opportunity is also "attention". Mirrors the client's _zoneNote: in-zone AND
  // currently at/under the user's entry.
  const zones = book.watchlist
    .filter((w) => w && typeof w.ticker === "string" && w.zoneState === "in" && Number(w.current) > 0 && Number(w.entry) > 0 && Number(w.current) <= Number(w.entry))
    .map((w) => ({ ticker: String(w.ticker), since: w.zoneSince ? String(w.zoneSince).slice(0, 10) : null }));

  const sig = await loadBriefSignals(userId, slot);          // per-holding signals (AM=yesterday's close, PM=live)
  if (!rows.length && !zones.length && !Object.keys(sig).length) return null; // nothing to judge yet → no email

  // ── NEWS DEDUPE — exclude any headline already shown earlier today (the AM↔PM loop never repeats an article).
  const _todayStr = new Date().toISOString().slice(0, 10);
  const _seenNews = await loadSeenNews(userId);
  const _seenSet = new Set(_seenNews.date === _todayStr ? _seenNews.keys : []);
  const _shownNews = new Set<string>();
  const newsKey = (h: string) => String(h).toLowerCase().replace(/[^a-z0-9 ]/g, "").slice(0, 44);
  // First headline for a holding that hasn't been shown yet today (records it as shown).
  const freshHeadline = (s?: BriefSignals): string | null => {
    for (const h of (s?.news || [])) { const k = newsKey(h); if (k && !_seenSet.has(k)) { _shownNews.add(k); return h; } }
    return null;
  };

  const total = byTicker.size;
  const bookHealth = strengths.length ? Math.round((strengths.reduce((a, x) => a + x.strength, 0) / strengths.length) * 10) / 10 : null;
  const strongest = [...strengths].sort((a, b) => b.strength - a.strength)[0] || null;
  const firstName = book.displayName.split(/\s+/)[0] || "";

  const C = { bg: "#0a0b0d", card: "#111317", bd: "#20242b", green: "#1fdf64", red: "#ff5c5c", amber: "#e0a500", t: "#e8eaed", t2: "#b4bac3", t3: "#7e8794" };
  const up = (t: string) => t.toUpperCase();
  // UTM-tag every link so the landing beacon can attribute the click to this brief + slot + section — the
  // instrumentation that tells us whether the email actually drives people back into Plainview.
  const camp = slot || "brief";
  const tag = (u: string, content: string) => `${u}${u.includes("?") ? "&" : "?"}utm_source=brief&utm_medium=email&utm_campaign=${camp}&utm_content=${content}`;

  // ── Unified attention list. Each item = headline judgment (the WHAT, with the WHY folded in when a filing
  // explains it) + recap texture; depth lives behind the link. Severity ranks across kinds.
  type Item = { sev: number; head: string; sub: string; right: string; col: string; href: string };
  const items: Item[] = [];
  // EVENT-DRIVEN radar — REAL, fundamental changes on the reader's names: a news headline, a filing read
  // CORRECTLY (insider buy/sell; a NEW offering vs a COMPLETED one), unusual volume, a notable move. We do
  // NOT surface internal thesis-conviction-score deltas — they're an abstraction that reads as noise. Ranked
  // by real significance.
  for (const [tk, s] of Object.entries(sig)) {
    const recap = recapStr(s);
    const mat = s.material?.[0];
    const headline = freshHeadline(s);
    const d = s.day;
    const dStr = d != null ? `${d > 0 ? "+" : ""}${d.toFixed(1)}%` : "";
    const dCol = d != null ? (d >= 0 ? C.green : C.red) : C.t2;
    // 1) A real NEWS headline — the strongest "what changed".
    if (headline) {
      items.push({ sev: 92, head: `${tk} — ${String(headline).slice(0, 88)}`, sub: [recap, s.sector].filter(Boolean).join(" · ") || "in the news", right: dStr || "news", col: dCol, href: `${APP}/x-ray/${tk}` });
    }
    // 2) A material FILING, read correctly. offering_done = overhang cleared (bullish); dilution/insider_sell bearish.
    if (mat) {
      const bull = mat.kind === "insider_buy" || mat.kind === "offering_done";
      const bear = mat.kind === "dilution" || mat.kind === "insider_sell";
      items.push({ sev: mat.kind === "dilution" ? 90 : mat.kind === "insider_sell" ? 84 : mat.kind === "insider_buy" ? 78 : mat.kind === "offering_done" ? 72 : 60, head: `${tk} — ${MAT_LABEL[mat.kind].replace(/^a /, "")}`, sub: `${mat.text.slice(0, 96)}${recap && !headline ? ` · ${recap}` : ""}`, right: bull ? "▲ filing" : bear ? "▼ filing" : "• filing", col: bear ? C.red : bull ? C.green : C.t2, href: `${APP}/x-ray/${tk}` });
    }
    // 3) Unusual VOLUME (real activity even before a headline catches up).
    else if (s.volX != null && s.volX >= 1.8 && !headline) {
      items.push({ sev: 66, head: `${tk} — ${s.volX}× normal volume`, sub: [dStr && `moved ${dStr}`, s.ma && `${s.ma} its 50-day`].filter(Boolean).join(" · ") || "unusual activity", right: dStr || `${s.volX}×`, col: d != null && d < 0 ? C.red : C.green, href: `${APP}/x-ray/${tk}` });
    }
    // 4) A notable MOVE with nothing else attached (still worth a flag).
    else if (d != null && Math.abs(d) >= 2.5 && !headline) {
      items.push({ sev: 58 + Math.min(20, Math.abs(d)), head: `${tk} ${dStr}`, sub: [s.sector && `tracking ${s.sector}`, s.ma && `${s.ma} its 50-day`].filter(Boolean).join(" · ") || "on no company news", right: dStr, col: dCol, href: `${APP}/x-ray/${tk}` });
    }
  }
  // Buy-zone opportunities — real and actionable.
  for (const z of zones) items.push({ sev: 80, head: `${z.ticker} entered your buy zone`, sub: `trading at or below your entry${z.since ? ` since ${z.since}` : ""}`, right: "◆ zone", col: C.green, href: `${APP}/x-ray/${z.ticker}` });

  items.sort((a, b) => b.sev - a.sev);
  const shown = items.slice(0, 8);
  const attentionCount = items.length;

  // (The morning brief is now a full digest — market pulse, your book's movers, news, filings, watchlist — so
  // it always has substance; no conditional suppression.)

  const row = (it: Item) =>
    `<tr><td style="padding:16px 0;border-top:1px solid ${C.bd}"><a href="${tag(it.href, "attention")}" style="text-decoration:none;color:inherit;display:block"><span style="font-family:'SF Mono','SFMono-Regular','Menlo','Consolas','Roboto Mono',monospace;font-weight:700;color:${C.t};font-size:15px;line-height:1.4;display:block">${it.head}</span><span style="display:block;color:${C.t3};font-size:12.5px;margin-top:6px;line-height:1.55">${it.sub} &nbsp;<span style="color:${C.green}">see what changed →</span></span></a></td><td style="padding:16px 0 16px 10px;border-top:1px solid ${C.bd};text-align:right;vertical-align:top;font-family:'SF Mono','SFMono-Regular','Menlo','Consolas','Roboto Mono',monospace;font-weight:700;color:${it.col};font-size:15px;white-space:nowrap">${it.right}</td></tr>`;
  const attnRows = shown.map(row).join("");

  // ── Slot framing — AM (pre-open) = "what to watch today"; PM (post-close) = "what changed today"; default
  // = generic. Different jobs so two-a-day never reads like the same email twice.
  const isPM = slot === "pm", isAM = slot === "am";
  const greet = `${isPM ? "Markets are closed" : "Good morning"}${firstName ? `, ${firstName}` : ""}.`;
  const sectionTitle = isPM ? "What changed today" : isAM ? "On your radar today" : "Needs your attention";

  // ── RELIABLE day-moves — fetch the latest completed-session % change straight from /api/prices so the heat
  // map + movers ALWAYS render, instead of depending on the sweep having captured `day` at the right moment.
  // AT PRE-MARKET (the 8am AM brief) the regular-session changePercent IS yesterday's full-day move — exactly
  // the "here's what happened yesterday" the morning brief wants. Fail-soft → falls back to captured signals.
  const _secret = process.env.CRON_SECRET;
  const priceMove: Record<string, number> = {};
  try {
    const syms = [...new Set(book.positions.map((p) => up(String((p as { id?: string }).id || ""))).filter(Boolean))];
    if (syms.length) {
      const r = await fetch(`${APP}/api/prices?symbols=${encodeURIComponent(syms.join(","))}`, { headers: _secret ? { "x-cron-secret": _secret } : {} });
      if (r.ok) { const j = await r.json(); for (const pr of (j.prices || [])) { if (typeof pr.changePercent === "number") priceMove[up(String(pr.symbol))] = Math.round(pr.changePercent * 10) / 10; } }
    }
  } catch { /* fail-soft */ }
  const moveOf = (tk: string): number | null => (priceMove[tk] != null ? priceMove[tk] : (sig[tk]?.day ?? null));

  // ── Book performance (value-weighted day-move) + per-holding movers. AM = "yesterday in your book".
  let wval = 0, wsum = 0;
  const dayMoves: Array<{ tk: string; day: number }> = [];
  const sectorAgg = new Map<string, { wval: number; wsum: number; n: number }>();   // value-weighted day-move per sector
  for (const p of book.positions) {
    const tk = up(String((p as { id?: string }).id || ""));
    const s = sig[tk];
    const dm = moveOf(tk);
    const shares = Number((p as { shares?: number }).shares) || 0, px = Number((p as { price?: number }).price) || 0;
    if (dm != null && shares > 0 && px > 0) {
      const v = shares * px; wval += v; wsum += v * dm;
      dayMoves.push({ tk, day: dm });
      const sec = (s?.sector || "").trim();
      if (sec) { const g = sectorAgg.get(sec) || { wval: 0, wsum: 0, n: 0 }; g.wval += v; g.wsum += v * dm; g.n++; sectorAgg.set(sec, g); }
    }
  }
  const bookDay = wval > 0 ? Math.round((wsum / wval) * 10) / 10 : null;
  const sectors = [...sectorAgg.entries()].map(([name, g]) => ({ name, day: Math.round((g.wsum / g.wval) * 10) / 10, n: g.n })).sort((a, b) => b.day - a.day);
  dayMoves.sort((a, b) => b.day - a.day);
  const gainers = dayMoves.filter((m) => m.day > 0.05);
  const losers = dayMoves.filter((m) => m.day < -0.05);
  const hasMoves = (isPM || isAM) && dayMoves.length > 0;
  const mkt: string[] = [];
  if (market?.sp != null) mkt.push(`S&P ${market.sp > 0 ? "+" : ""}${market.sp.toFixed(1)}%`);
  if (market?.nasdaq != null) mkt.push(`Nasdaq ${market.nasdaq > 0 ? "+" : ""}${market.nasdaq.toFixed(1)}%`);
  if (market?.vix != null) mkt.push(`VIX ${market.vix.toFixed(0)}`);
  const marketLine = mkt.join(" · ");

  // ── Hero: speak to the reader. AM/default = conviction-led; PM = performance-led (the daily overview).
  const quiet = attentionCount === 0;
  const heroBig = isPM
    ? (bookDay != null ? `Your portfolio ${bookDay > 0 ? "+" : ""}${bookDay}% today.` : attentionCount ? `${attentionCount === 1 ? "One thing moved" : `${attentionCount} things moved`} on your portfolio today.` : "Markets are closed — a quiet day on your portfolio.")
    : isAM
      ? (attentionCount ? `${attentionCount === 1 ? "One thing to watch" : `${attentionCount} things to watch`} on your portfolio today.` : "Your morning brief is ready.")
      : quiet
        ? "Nothing changed your theses overnight."
        : `${attentionCount === 1 ? "One thing on your portfolio moved" : `${attentionCount} things moved on your portfolio`} today.`;
  const heroSub = isPM
    ? (bookDay != null ? `${gainers.length} up, ${losers.length} down across your portfolio.${attentionCount ? "" : " No thesis changes — your conviction held."}` : "The day’s done. No action needed.")
    : isAM
      ? "The market, your movers, the news on your names, and what's worth a look before the open."
      : quiet
        ? "Your portfolio is steady — no action needed. That’s the point: discipline beats reacting to noise."
        : "The rest of your portfolio held. Here’s only what moved.";

  // ── Quiet-day texture — notable-but-not-actionable (so a calm morning still informs without prompting a
  // trade). AM/default only; PM shows the "Today's moves" overview instead.
  const fyi: string[] = [];
  if (quiet && !isPM && !isAM) {
    for (const [tk, s] of Object.entries(sig)) {
      if (s.volX != null && s.volX >= 2) fyi.push(`${tk} traded ${s.volX}× its normal volume`);
      else if (s.near52 != null && s.near52 <= 4) fyi.push(`${tk} is near its 52-week low`);
      else if (s.near52 != null && s.near52 >= 96) fyi.push(`${tk} is near its 52-week high`);
      if (fyi.length >= 3) break;
    }
  }

  // ── MARKET section visibility (book day-move + indices computed above). On PM the book day-move is already
  // the hero, so the section shows just the indices ("Market today"); elsewhere it's "your portfolio vs the market".
  const showMarket = !!(marketLine || (bookDay != null && !isPM));

  // Watchlist names APPROACHING (but not yet in) their buy zone — drives both the watchlist summary and the
  // discovery link. Connected to the reader's OWN universe (never a random pick).
  const approaching = book.watchlist
    .map((w) => ({ ticker: String((w as { ticker?: string }).ticker || ""), c: Number((w as { current?: number }).current), e: Number((w as { entry?: number }).entry) }))
    .filter((w) => w.ticker && w.c > 0 && w.e > 0 && w.c > w.e && w.c <= w.e * 1.06)
    .map((w) => ({ ticker: w.ticker, gap: Math.round((w.c / w.e - 1) * 1000) / 10 }))
    .sort((a, b) => a.gap - b.gap);
  const discover = approaching[0] || null;

  // ── PM PORTFOLIO REVIEW EXTRAS (all personal, $0): a holdings HEAT-MAP grid, "what you did today" (from the
  // action ledger), and a watchlist summary (in-zone + approaching). PM-only; the AM stays lean.
  const MONO = "'SF Mono','SFMono-Regular','Menlo','Consolas','Roboto Mono',monospace";
  // ── VALUE-WEIGHTED HEAT MAP — each holding sized by its share of the portfolio, colored by its day move.
  // Composition + performance at a glance (a finviz-style portfolio map, email-safe via a proportional bar).
  let heatGrid = "";
  if (hasMoves) {
    const valItems = book.positions
      .map((p) => { const tk = up(String((p as { id?: string }).id || "")); return { tk, val: (Number((p as { shares?: number }).shares) || 0) * (Number((p as { price?: number }).price) || 0), day: moveOf(tk) }; })
      .filter((h): h is { tk: string; val: number; day: number } => !!h.tk && h.val > 0 && h.day != null)
      .sort((a, b) => b.val - a.val);
    if (valItems.length) {
      const top = valItems.slice(0, 8);
      const restVal = valItems.slice(8).reduce((a, h) => a + h.val, 0);
      const totalVal = valItems.reduce((a, h) => a + h.val, 0) || 1;
      const heatBg = (d: number | null) => d == null ? "#23272e" : d >= 2 ? "#15803d" : d > 0.05 ? "#1a5e35" : d <= -2 ? "#8c1d1d" : d < -0.05 ? "#5e2424" : "#3a3f47";
      const segs = top.map((h) => ({ tk: h.tk, w: (h.val / totalVal) * 100, day: h.day as number | null }));
      if (restVal > 0) segs.push({ tk: "+more", w: (restVal / totalVal) * 100, day: null });
      const cells = segs.map((sg) => {
        const w = Math.max(1, Math.round(sg.w));
        const label = sg.w >= 9 ? `<div style="font-family:${MONO};font-weight:700;color:#fff;font-size:12px;line-height:1.1">${sg.tk}</div>${sg.day != null ? `<div style="font-family:${MONO};font-weight:700;color:#fff;opacity:.92;font-size:11px;line-height:1.2;margin-top:2px">${sg.day > 0 ? "+" : ""}${sg.day.toFixed(1)}%</div>` : ""}` : (sg.w >= 4 ? `<div style="font-family:${MONO};font-weight:700;color:#fff;font-size:9px">${sg.tk}</div>` : "&nbsp;");
        return `<td width="${w}%" style="padding:2px"><div style="background:${heatBg(sg.day)};border-radius:6px;padding:11px 2px;text-align:center;overflow:hidden">${label}</div></td>`;
      });
      heatGrid = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;table-layout:fixed"><tr>${cells.join("")}</tr></table><div style="font-size:11px;color:${C.t3};margin-top:5px">Sized by position weight · colored by ${isAM ? "yesterday's" : "today's"} move</div>`;
    }
  }
  // Sector heat-map of the reader's OWN holdings (value-weighted), grouped 2-up. Only when their book spans
  // ≥2 sectors (else it's just the portfolio number again).
  let sectorGrid = "";
  if ((isPM || isAM) && sectors.length >= 2) {
    const heat = (d: number) => ({ bg: d >= 2 ? "#14401e" : d > 0.05 ? "#172a1c" : d <= -2 ? "#451616" : d < -0.05 ? "#2a1719" : "#1a1d22", fg: d >= 0.05 ? C.green : d <= -0.05 ? C.red : C.t2 });
    const cell = (s: { name: string; day: number; n: number }) => { const h = heat(s.day);
      return `<td width="50%" style="padding:4px"><div style="background:${h.bg};border:1px solid ${C.bd};border-radius:9px;padding:9px 11px"><div style="font-weight:700;color:${C.t};font-size:13px">${s.name}</div><div style="font-family:${MONO};font-weight:700;color:${h.fg};font-size:13px;margin-top:2px">${s.day > 0 ? "+" : ""}${s.day.toFixed(1)}% <span style="color:${C.t3};font-weight:400">· ${s.n} holding${s.n === 1 ? "" : "s"}</span></div></div></td>`; };
    const cells = sectors.map(cell), trs: string[] = [];
    for (let i = 0; i < cells.length; i += 2) { const r = cells.slice(i, i + 2); while (r.length < 2) r.push('<td width="50%"></td>'); trs.push(`<tr>${r.join("")}</tr>`); }
    sectorGrid = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">${trs.join("")}</table>`;
  }
  let didToday = "";
  if (isPM) {
    try {
      const acts = await listActions(userId, 40);
      const todayStr = new Date().toISOString().slice(0, 10);
      const t = acts.filter((a) => String((a as { occurred_at?: string }).occurred_at || "").slice(0, 10) === todayStr);
      const pick = (type: string) => [...new Set(t.filter((a) => (a as { action_type?: string }).action_type === type).map((a) => String((a as { ticker?: string }).ticker || "")).filter(Boolean))];
      const o = pick("opened"), ad = pick("added"), tr = pick("trimmed"), cl = pick("closed");
      // Sanity gate: a real day is a handful of changes. A flood — especially mass "Opened" — is almost
      // always a multi-device/reload mis-detection, not real activity. Drop the suspect category rather than
      // claim you opened your whole portfolio; suppress the whole line if the total is clearly broken.
      const parts: string[] = [];
      if (o.length && o.length <= 5) parts.push(`Opened <b style="color:${C.t}">${o.join(", ")}</b>`);
      if (ad.length && ad.length <= 5) parts.push(`Added to <b style="color:${C.t}">${ad.join(", ")}</b>`);
      if (tr.length && tr.length <= 5) parts.push(`Trimmed <b style="color:${C.t}">${tr.join(", ")}</b>`);
      if (cl.length && cl.length <= 5) parts.push(`Closed <b style="color:${C.t}">${cl.join(", ")}</b>`);
      didToday = (o.length + ad.length + tr.length + cl.length) > 10 ? "" : parts.join(" &nbsp;·&nbsp; ");
    } catch { /* fail-soft */ }
  }
  const wlZone = zones.map((z) => z.ticker);
  const wlApproach = approaching.slice(0, 5).map((a) => `${a.ticker} ${a.gap}% away`);
  const showWatch = (isPM || isAM) && (wlZone.length > 0 || wlApproach.length > 0);

  // ── MORNING DIGEST extras: market-wide sector leaders/laggards ("what sectors look interesting") + the top
  // headline on each of the reader's names ("what's in the news"). AM-focused; from the batch market context
  // + the sweep's captured news.
  const secs = market?.sectors || [];
  const sectorLead = secs.slice(0, 3).filter((s) => s.day > 0).map((s) => `${s.name} +${s.day.toFixed(1)}%`);
  const sectorLag = secs.slice(-3).reverse().filter((s) => s.day < 0).map((s) => `${s.name} ${s.day.toFixed(1)}%`);
  const showMarketPulse = (isAM || isPM) && (!!marketLine || secs.length > 0); // the day's market is core to BOTH
  const movesTitle = isAM ? "Yesterday in your book" : "Today's moves";

  // ── WHAT MOVED & WHY — the notable movers, each with a GROUNDED reason: a real headline → a filing → the
  // sector backdrop → "no company news". This is the "talk about it" the reader wants (AMC +8% on X), and it
  // feeds the narrative. Sector move = the company's sector matched to its market-ETF move.
  const sectorMoveByName: Record<string, number> = {};
  for (const s of secs) sectorMoveByName[s.name.toLowerCase()] = s.day;
  const sectorMoveFor = (sec?: string | null): number | null => {
    if (!sec) return null; const k = sec.toLowerCase().split(/[ /]/)[0];
    for (const name in sectorMoveByName) if (k && (name.startsWith(k) || k.startsWith(name.split(" ")[0]))) return sectorMoveByName[name];
    return null;
  };
  const moverDetails = dayMoves
    .filter((m) => Math.abs(m.day) >= 0.5)
    .sort((a, b) => Math.abs(b.day) - Math.abs(a.day))
    .slice(0, 6)
    .map((m) => {
      const s = sig[m.tk]; const head = freshHeadline(s); const mat = s?.material?.[0]; const secMove = sectorMoveFor(s?.sector);
      const why = head ? String(head).slice(0, 110)
        : mat ? mat.text.slice(0, 100)
          : (s?.sector && secMove != null) ? `tracking ${s.sector} (${secMove > 0 ? "+" : ""}${secMove.toFixed(1)}% today)`
            : "on no company news";
      return { tk: m.tk, day: m.day, why };
    });
  const showMovers = (isPM || isAM) && moverDetails.length > 0;

  // ── THE READ — assemble the curated facts and compose the grounded Plainview narrative (falls back to the
  // deterministic hero line if the model fails the figure-audit). This is the "written brief" the reader reads.
  const when = isAM ? "yesterday" : "today";
  const factParts: string[] = [];
  if (market && (market.sp != null || market.nasdaq != null)) factParts.push(`Market ${when}: ${[market.sp != null ? `S&P ${market.sp > 0 ? "+" : ""}${market.sp.toFixed(1)}%` : "", market.nasdaq != null ? `Nasdaq ${market.nasdaq > 0 ? "+" : ""}${market.nasdaq.toFixed(1)}%` : "", market.vix != null ? `VIX ${market.vix.toFixed(0)}` : ""].filter(Boolean).join(", ")}.${sectorLead.length ? ` Leading sectors: ${sectorLead.join(", ")}.` : ""}${sectorLag.length ? ` Lagging: ${sectorLag.join(", ")}.` : ""}`);
  if (bookDay != null) factParts.push(`Their portfolio ${bookDay > 0 ? "+" : ""}${bookDay}% ${when}; ${gainers.length} up, ${losers.length} down.`);
  if (moverDetails.length) factParts.push(`Movers and what drove them:\n${moverDetails.map((m) => `- ${m.tk} ${m.day > 0 ? "+" : ""}${m.day.toFixed(1)}%: ${m.why}`).join("\n")}`);
  const matLines = items.filter((it) => /insider|dilution|filing/i.test(it.head)).slice(0, 2).map((it) => it.head);
  if (matLines.length) factParts.push(`Filings: ${matLines.join("; ")}.`);
  if (wlZone.length) factParts.push(`Watchlist in buy zone: ${wlZone.join(", ")}.`);
  if (wlApproach.length) factParts.push(`Watchlist approaching buy zone: ${wlApproach.join(", ")}.`);
  const narrative = await composeBriefNarrative(slot, factParts.join("\n"));
  // Rich DETERMINISTIC read — assembled from the same grounded facts so there is ALWAYS substantial, scannable
  // text even when the LLM narrative fails (rate-limit / figure-audit reject). No fabrication: only real facts.
  const detRead: string[] = [];
  if (marketLine) detRead.push(`The market is ${market && market.sp != null && market.sp < -0.3 ? "soft" : market && market.sp != null && market.sp > 0.3 ? "firm" : "mixed"} ${when} — ${marketLine}.${sectorLead.length ? ` ${sectorLead.join(", ")} lead${sectorLag.length ? `; ${sectorLag.join(", ")} lag` : ""}.` : ""}`);
  if (bookDay != null) detRead.push(`Your book is ${bookDay > 0 ? "up" : "down"} ${Math.abs(bookDay)}% ${when} — ${gainers.length} up, ${losers.length} down.`);
  if (moverDetails.length) detRead.push(`Worth a look: ${moverDetails.slice(0, 3).map((m) => `${m.tk} ${m.day > 0 ? "+" : ""}${m.day.toFixed(1)}% (${m.why})`).join("; ")}.`);
  const newsBits = Object.entries(sig).map(([tk, s]) => { const h = freshHeadline(s); return h ? `${tk}: ${String(h).slice(0, 70)}` : ""; }).filter(Boolean).slice(0, 2);
  if (newsBits.length) detRead.push(`On your names: ${newsBits.join("; ")}.`);
  if (matLines.length) detRead.push(`On filings: ${matLines.join("; ")}.`);
  if (wlZone.length) detRead.push(`${wlZone.join(", ")} ${wlZone.length > 1 ? "are" : "is"} in your buy zone${wlApproach.length ? `, and ${wlApproach.slice(0, 2).join(", ")} approaching` : ""} — your call on whether the entry still holds.`);
  else if (wlApproach.length) detRead.push(`On the watchlist, ${wlApproach.slice(0, 2).join(", ")} ${wlApproach.length > 1 ? "are" : "is"} nearing your buy zone.`);
  const readText = narrative || (detRead.length ? detRead.join(" ") : heroSub);
  // Space the read out — one sentence per line (not a bulky paragraph), so it's scannable.
  const readSentences = readText.split(/(?<=[.!?])\s+(?=[A-Z"'$])/).map((s) => s.trim()).filter(Boolean);
  const readHtml = readSentences.map((s) => `<div style="margin:0 0 9px;line-height:1.55">${s}</div>`).join("");

  // ── Demoted aggregate (a footnote, not the headline).
  const pulse = total ? `${total} ${total === 1 ? "thesis" : "theses"} tracked · ${moves.length} moved${bookHealth != null ? ` · portfolio health ${bookHealth}/10` : ""}${strongest ? ` · strongest ${strongest.ticker} ${strongest.strength}/10` : ""}` : "";

  // ── WHAT TO DO — explicit, deterministic next actions (no AI). Discipline, not noise: only surfaces when
  // the day gives a concrete decision — a contradicted/weakening thesis, a name in your buy zone, one nearing it.
  // ── PLAINVIEW'S READ — observational analysis of the sector backdrop, in Plainview's voice. NOT advice
  // ("buy X") — an OBSERVATION: market-wide weakness is where discounts surface; strength is where entries
  // get expensive. Deterministic from the 11 sector-ETF moves + which sectors the reader actually owns.
  const marketReads: string[] = [];
  {
    const secs2 = market?.sectors || [];
    const held = [...sectorAgg.keys()].map((s) => s.toLowerCase());
    const isHeld = (name: string) => { const n = name.toLowerCase(); return held.some((h) => h.includes(n) || n.includes(h) || h.split(/\s+/).some((w) => w.length > 4 && n.includes(w))); };
    const down = secs2.filter((s) => s.day <= -1.5).sort((a, b) => a.day - b.day).slice(0, 2);
    const upHot = secs2.filter((s) => s.day >= 1.5).sort((a, b) => b.day - a.day).slice(0, 1);
    for (const s of down) marketReads.push(`<b>${s.name} ${s.day.toFixed(1)}%</b> — that's where discounts tend to surface${isHeld(s.name) ? `; you already own here, so the weakness is a chance to average a name you believe in rather than a reason to flinch` : `, so it's worth scanning for quality going on sale`}.`);
    for (const s of upHot) marketReads.push(`<b>${s.name} +${s.day.toFixed(1)}%</b> — real strength, but the easy entries there are gone for now${isHeld(s.name) ? `; if you hold here, that's a "let it run," not a "chase."` : "."}`);
  }
  const showReads = (isAM || isPM) && marketReads.length > 0;

  const actions: string[] = [];
  for (const [tk, s] of Object.entries(sig)) {
    if (actions.length >= 5) break;
    const mat = s.material?.[0];
    if (mat?.kind === "dilution") actions.push(`<b>${tk}</b> — new raise / dilution filing; read it before you add.`);
    else if (mat?.kind === "insider_sell") actions.push(`<b>${tk}</b> — insider selling; check who and how much before adding.`);
    else if (mat?.kind === "insider_buy") actions.push(`<b>${tk}</b> — insider buying; worth a closer look.`);
    else if (mat?.kind === "offering_done") actions.push(`<b>${tk}</b> — offering completed, overhang cleared; re-check the setup.`);
  }
  for (const z of zones) { if (actions.length >= 5) break; actions.push(`<b>${z.ticker}</b> — in your buy zone; set a limit at your entry, don't chase.`); }
  for (const a of approaching.slice(0, 2)) { if (actions.length >= 5) break; actions.push(`<b>${a.ticker}</b> — ${a.gap}% from your buy zone; set a price alert.`); }
  const showActions = (isAM || isPM) && actions.length > 0;

  const preheader = isPM
    ? `${bookDay != null ? `Your portfolio ${bookDay > 0 ? "+" : ""}${bookDay}% today · ${gainers.length} up, ${losers.length} down` : "Today's close"}${attentionCount ? ` · ${shown[0].head}` : ""}`
    : isAM
      ? `Market pulse, your movers, news on your names, and ${attentionCount ? `${attentionCount} to watch` : "what's worth a look"} before the open.`
      : quiet
        ? (fyi.length ? `No thesis changes — ${fyi[0]}. Portfolio health ${bookHealth ?? "—"}/10.` : `No thesis changes overnight — your portfolio is steady. Portfolio health ${bookHealth ?? "—"}/10.`)
        : `${shown[0].head}${attentionCount > 1 ? ` · +${attentionCount - 1} more` : ""}`;

  const html = `<style>@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;700;800&display=swap');</style><div style="background:${C.bg};margin:0;padding:0;width:100%">
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;opacity:0;color:transparent">${preheader}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.bg};border-collapse:collapse"><tr><td align="center" style="padding:24px 12px">
  <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:${C.card};border:1px solid ${C.bd};border-radius:16px;border-collapse:separate;font-family:'Inter',-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
    <tr><td style="padding:22px 26px 0">
      <table role="presentation" cellpadding="0" cellspacing="0"><tr>
        <td style="vertical-align:middle"><span style="display:inline-block;width:26px;height:26px;background:${C.green};border-radius:7px;color:${C.bg};font-weight:800;font-size:15px;text-align:center;line-height:26px;font-family:Arial">P</span></td>
        <td style="vertical-align:middle;padding-left:9px"><span style="font-weight:800;font-size:15px;color:${C.t};letter-spacing:.05em">PLAINVIEW</span> <span style="font-size:11px;color:${C.green};font-weight:700;letter-spacing:.1em">DAILY CONVICTION</span></td>
      </tr></table>
    </td></tr>
    <tr><td style="padding:20px 26px 0">
      <div style="font-size:13px;color:${C.t3};margin-bottom:6px">${greet}</div>
      <div style="font-size:21px;font-weight:700;color:${C.t};line-height:1.3">${heroBig}</div>
      <div style="font-size:14px;color:${C.t2};margin-top:10px">${readHtml}</div>
    </td></tr>
    ${showMarketPulse ? `<tr><td style="padding:20px 26px 0">
      <div style="font-size:12px;text-transform:uppercase;letter-spacing:.09em;color:${C.t3};font-weight:700;margin-bottom:6px">Market pulse</div>
      ${marketLine ? `<div style="font-size:13.5px;color:${C.t2};padding:2px 0">${marketLine}</div>` : ""}
      ${sectorLead.length ? `<div style="font-size:13px;color:${C.green};padding:2px 0">▲ Leading: ${sectorLead.join(" · ")}</div>` : ""}
      ${sectorLag.length ? `<div style="font-size:13px;color:${C.red};padding:2px 0">▼ Lagging: ${sectorLag.join(" · ")}</div>` : ""}
    </td></tr>` : ""}
    ${hasMoves ? `<tr><td style="padding:22px 26px 0">
      <div style="font-size:12px;text-transform:uppercase;letter-spacing:.09em;color:${C.t3};font-weight:700;margin-bottom:8px">${movesTitle}</div>
      ${heatGrid}
    </td></tr>` : ""}
    ${sectorGrid ? `<tr><td style="padding:20px 26px 0">
      <div style="font-size:12px;text-transform:uppercase;letter-spacing:.09em;color:${C.t3};font-weight:700;margin-bottom:8px">Your sectors today</div>
      ${sectorGrid}
    </td></tr>` : ""}
    ${didToday ? `<tr><td style="padding:20px 26px 0">
      <div style="font-size:12px;text-transform:uppercase;letter-spacing:.09em;color:${C.t3};font-weight:700;margin-bottom:6px">What you did today</div>
      <div style="font-size:13.5px;color:${C.t2};line-height:1.6">${didToday}</div>
    </td></tr>` : ""}
    ${attentionCount ? `<tr><td style="padding:22px 26px 0">
      <div style="font-size:12px;text-transform:uppercase;letter-spacing:.09em;color:${C.t3};font-weight:700;margin-bottom:2px">${sectionTitle}</div>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">${attnRows}</table>
    </td></tr>` : ""}
    ${showReads ? `<tr><td style="padding:22px 26px 0">
      <div style="font-size:12px;text-transform:uppercase;letter-spacing:.09em;color:${C.amber};font-weight:700;margin-bottom:8px">Plainview's read</div>
      ${marketReads.map((r) => `<div style="font-size:13.5px;color:${C.t2};padding:7px 0;line-height:1.55;border-top:1px solid ${C.bd}">${r}</div>`).join("")}
    </td></tr>` : ""}
    ${showActions ? `<tr><td style="padding:22px 26px 0">
      <div style="font-size:12px;text-transform:uppercase;letter-spacing:.09em;color:${C.green};font-weight:700;margin-bottom:8px">What to do</div>
      ${actions.slice(0, 5).map((a) => `<div style="font-size:13px;color:${C.t2};padding:7px 0;line-height:1.5;border-top:1px solid ${C.bd}"><span style="color:${C.green};font-weight:700">→</span> ${a}</div>`).join("")}
    </td></tr>` : ""}
    ${showMovers ? `<tr><td style="padding:22px 26px 0">
      <div style="font-size:12px;text-transform:uppercase;letter-spacing:.09em;color:${C.t3};font-weight:700;margin-bottom:7px">What moved &amp; why</div>
      ${moverDetails.map((m) => `<div style="font-size:13px;color:${C.t2};padding:6px 0;line-height:1.5;border-top:1px solid ${C.bd}"><span style="font-family:${MONO};font-weight:700;color:${m.day >= 0 ? C.green : C.red}">${m.tk} ${m.day > 0 ? "+" : ""}${m.day.toFixed(1)}%</span> &nbsp;<span style="color:${C.t2}">${m.why}</span></div>`).join("")}
    </td></tr>` : ""}
    ${showWatch ? `<tr><td style="padding:22px 26px 0">
      <div style="font-size:12px;text-transform:uppercase;letter-spacing:.09em;color:${C.t3};font-weight:700;margin-bottom:6px">Watchlist</div>
      ${wlZone.length ? `<div style="font-size:13.5px;color:${C.green};padding:3px 0;line-height:1.5">◆ In buy zone: <b>${wlZone.join(", ")}</b></div>` : ""}
      ${wlApproach.length ? `<div style="font-size:13.5px;color:${C.t2};padding:3px 0;line-height:1.5">↗ Approaching: ${wlApproach.join("&nbsp; · &nbsp;")}</div>` : ""}
    </td></tr>` : ""}
    ${quiet && fyi.length ? `<tr><td style="padding:20px 26px 0">
      <div style="font-size:12px;text-transform:uppercase;letter-spacing:.09em;color:${C.t3};font-weight:700;margin-bottom:6px">Worth noting · no action needed</div>
      ${fyi.map((f) => `<div style="font-size:13px;color:${C.t2};padding:5px 0;line-height:1.5">${f}</div>`).join("")}
    </td></tr>` : ""}
    ${showMarket ? `<tr><td style="padding:22px 26px 0">
      <div style="font-size:12px;text-transform:uppercase;letter-spacing:.09em;color:${C.t3};font-weight:700;margin-bottom:6px">${isPM ? "Market today" : "Your portfolio vs the market"}</div>
      <div style="font-size:14px;color:${C.t}">${(bookDay != null && !isPM) ? `<b style="color:${bookDay >= 0 ? C.green : C.red}">Your portfolio ${bookDay > 0 ? "+" : ""}${bookDay}% today</b>` : ""}${(bookDay != null && !isPM && marketLine) ? `<span style="color:${C.t3}"> &nbsp;·&nbsp; </span>` : ""}${marketLine ? `<span style="color:${C.t2}">${marketLine}</span>` : ""}</div>
    </td></tr>` : ""}
    <tr><td style="padding:24px 26px 4px">
      <a href="${tag(`${APP}/journal`, "cta")}" style="display:inline-block;background:${C.green};color:${C.bg};text-decoration:none;font-weight:700;padding:13px 28px;border-radius:10px;font-size:15px">${isPM ? "See your full portfolio" : quiet ? "Review your portfolio" : "See what changed"} &rarr;</a>
    </td></tr>
    ${discover ? `<tr><td style="padding:12px 26px 0"><a href="${tag(`${APP}/x-ray/${encodeURIComponent(discover.ticker)}`, "discovery")}" style="font-size:13px;color:${C.green};text-decoration:none">${discover.ticker} is approaching your buy zone (${discover.gap}% away) — take another look &rarr;</a></td></tr>` : ""}
    ${pulse ? `<tr><td style="padding:16px 26px 0"><div style="font-size:11.5px;color:${C.t3}">${pulse}</div></td></tr>` : ""}
    <tr><td style="padding:16px 26px 24px">
      <div style="border-top:1px solid ${C.bd};padding-top:14px;font-size:11px;color:${C.t3};line-height:1.6">NEXUS judges your reasoning, not just the outcome — and stays quiet unless something on your portfolio actually changes. &nbsp;<a href="${tag(`${APP}/settings`, "prefs")}" style="color:${C.t3};text-decoration:underline">Preferences</a> &nbsp;·&nbsp; <a href="%%UNSUB%%" style="color:${C.t3};text-decoration:underline">Unsubscribe</a></div>
    </td></tr>
  </table>
</td></tr></table></div>`;

  const textAttn = shown.map((it) => `  • ${it.head} — ${it.sub}${it.right ? ` (${it.right.replace(/[▲▼◆•✕]/g, "").trim()})` : ""}`).join("\n");
  const textFyi = fyi.length ? `\nWorth noting (no action needed):\n${fyi.map((f) => `  • ${f}`).join("\n")}\n` : "";
  const textMoves = hasMoves ? `\n${movesTitle}:\n${gainers.length ? `  Up: ${gainers.slice(0, 8).map((m) => `${m.tk} +${m.day.toFixed(1)}%`).join(", ")}\n` : ""}${losers.length ? `  Down: ${losers.slice(0, 8).map((m) => `${m.tk} ${m.day.toFixed(1)}%`).join(", ")}\n` : ""}` : "";
  const textMarketPulse = showMarketPulse ? `\nMarket pulse: ${marketLine}${sectorLead.length ? `\n  Leading: ${sectorLead.join(", ")}` : ""}${sectorLag.length ? `\n  Lagging: ${sectorLag.join(", ")}` : ""}\n` : "";
  const textNews = showMovers ? `\nWhat moved & why:\n${moverDetails.map((m) => `  ${m.tk} ${m.day > 0 ? "+" : ""}${m.day.toFixed(1)}% — ${m.why}`).join("\n")}\n` : "";
  const textSectors = sectorGrid ? `\nYour sectors today: ${sectors.map((s) => `${s.name} ${s.day > 0 ? "+" : ""}${s.day}%`).join(", ")}\n` : "";
  const textDid = didToday ? `\nWhat you did today: ${didToday.replace(/<[^>]+>/g, "")}\n` : "";
  const textWatch = showWatch ? `\nWatchlist:${wlZone.length ? ` In buy zone: ${wlZone.join(", ")}.` : ""}${wlApproach.length ? ` Approaching: ${wlApproach.join(", ")}.` : ""}\n` : "";
  const textMarket = showMarket ? `\n${isPM ? "Market today" : "Your portfolio vs the market"}: ${(bookDay != null && !isPM) ? `your portfolio ${bookDay > 0 ? "+" : ""}${bookDay}% today${marketLine ? " · " : ""}` : ""}${marketLine}\n` : "";
  const textReads = showReads ? `\nPlainview's read:\n${marketReads.map((r) => `  ${r.replace(/<[^>]+>/g, "")}`).join("\n")}\n` : "";
  const textActions = showActions ? `\nWhat to do:\n${actions.map((a) => `  → ${a.replace(/<[^>]+>/g, "")}`).join("\n")}\n` : "";
  const text = `PLAINVIEW · DAILY CONVICTION\n\n${greet}\n${heroBig}\n\n${readSentences.join("\n\n")}\n${textMarketPulse}${textMoves}${textSectors}${textNews}${textDid}${attentionCount ? `\n${sectionTitle}:\n${textAttn}\n` : ""}${textReads}${textActions}${textWatch}${textFyi}${textMarket}${pulse ? `\n${pulse}\n` : ""}\n${isPM ? "See your full portfolio" : quiet ? "Review your portfolio" : "See what changed"}: ${APP}/journal${discover ? `\n${discover.ticker} approaching your buy zone (${discover.gap}% away): ${APP}/x-ray/${discover.ticker}` : ""}\n\nUnsubscribe: %%UNSUB%%`;

  const more = attentionCount > 1 ? ` (+${attentionCount - 1} more)` : "";
  const subject = isPM
    ? `${firstName ? `${firstName} — ` : ""}${bookDay != null ? `your portfolio ${bookDay > 0 ? "+" : ""}${bookDay}% today` : "today's close"}${attentionCount ? ` · ${shown[0].head}` : gainers.length || losers.length ? ` · ${gainers.length} up, ${losers.length} down` : ""}`
    : isAM
      ? `${firstName ? `${firstName} — ` : ""}your morning brief${attentionCount ? `: ${shown[0].head}${more}` : sectorLead.length ? ` · ${sectorLead[0]} leading` : ""}`
      : quiet
        ? `${firstName ? `${firstName} — ` : ""}your portfolio held steady. No action needed.`
        : `${firstName ? `${firstName}, ` : ""}${shown[0].head}${more}`;

  // Record the headlines shown so the OTHER email today won't repeat them (only on a real send, not a preview).
  if (opts?.markSeen && _shownNews.size) void saveSeenNews(userId, _todayStr, [..._seenSet, ..._shownNews]);

  return { subject, html, text };
}

export async function sendEmail(to: string, subject: string, html: string, fromOverride?: string, text?: string): Promise<{ ok: boolean; detail: string }> {
  const key = process.env.RESEND_API_KEY;
  if (!key) return { ok: false, detail: "RESEND_API_KEY not set" };
  // Hard opt-out guard — NO path (cron, win-back, owner test) ever emails a suppressed address.
  if (await isSuppressed(to)) return { ok: false, detail: "suppressed (unsubscribed)" };
  const from = fromOverride || process.env.RESEND_FROM || "Plainview <onboarding@resend.dev>";
  // Inject the per-recipient unsubscribe link wherever the template left a %%UNSUB%% placeholder.
  const unsub = unsubLink(to);
  const htmlOut = html.split("%%UNSUB%%").join(unsub);
  const textOut = text ? text.split("%%UNSUB%%").join(unsub) : undefined;
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      // text alt + a WORKING List-Unsubscribe (with one-click POST per RFC 8058) both improve inbox placement
      // and give every provider's native "Unsubscribe" button a real endpoint to hit.
      body: JSON.stringify({ from, to, subject, html: htmlOut, ...(textOut ? { text: textOut } : {}), headers: { "List-Unsubscribe": `<${unsub}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } }),
    });
    return { ok: res.ok, detail: `${res.status} ${(await res.text()).slice(0, 240)}` };
  } catch (e) { return { ok: false, detail: e instanceof Error ? e.message : "error" }; }
}

// Every user who has thesis data → their email (for the all-users morning cron). Excludes backend test
// accounts (@plainview.test). Capped, fail-soft per user. Returned STALEST-FIRST (oldest latest-eval
// first) so the morning sweep's time budget refreshes the neediest ledgers before it runs out — active
// users self-sweep client-side anyway, so the server sweep should favour the ones who haven't opened the app.
export async function usersWithBriefs(limit = 500): Promise<Array<{ userId: string; email: string }>> {
  const sb = admin();
  const { data } = await sb.from("nexus_thesis_evaluations").select("user_id, evaluated_at").order("evaluated_at", { ascending: false }).limit(5000);
  // First occurrence in this desc list = the user's most-recent eval → their freshness.
  const latest = new Map<string, string>();
  for (const r of (data ?? []) as Array<{ user_id: string; evaluated_at: string }>) {
    if (r.user_id && !latest.has(r.user_id)) latest.set(r.user_id, r.evaluated_at || "");
  }
  const ids = [...latest.entries()].sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0)).map(([id]) => id).slice(0, limit);
  const out: Array<{ userId: string; email: string }> = [];
  for (const id of ids) {
    try {
      const { data: u } = await sb.auth.admin.getUserById(id);
      const email = u?.user?.email;
      if (email && !email.toLowerCase().endsWith("@plainview.test")) out.push({ userId: id, email });
    } catch { /* skip unresolvable user */ }
  }
  return out;
}

// ── MORNING SWEEP — re-score a user's holdings server-side so the 9am brief reads FRESH conviction even
// for someone who hasn't opened the app. Loads their book from Storage and re-runs each position's thesis
// through /api/thesis-check (cron-authed userId header) — the SAME engine the client sweep uses, so the
// ledger never forks. Bounded concurrency, fail-soft per holding, never throws. Mirrors the client's
// runNexusSweep: only `positions` with a real thesis (≥12 chars) are swept.
// concurrency=2 (was 3): each thesis-check fans out ~6 external fetches, so 3-at-once hammered Yahoo/SEC into
// rate-limits → thin data → false "insufficient/contradicted". Gentler concurrency = better data = truer verdicts.
export async function sweepUserTheses(userId: string, concurrency = 2, snapshotClose = false): Promise<{ holdings: number; scored: number }> {
  const secret = process.env.CRON_SECRET;
  if (!secret) return { holdings: 0, scored: 0 };
  let positions: Array<Record<string, unknown>> = [];
  try {
    const { data, error } = await admin().storage.from("plainview-state").download(`${userId}/state.json`);
    if (error || !data) return { holdings: 0, scored: 0 };
    const state = JSON.parse(await data.text());
    positions = Array.isArray(state?.positions) ? state.positions : [];
  } catch { return { holdings: 0, scored: 0 }; }

  // Slice 1 — per-user P&L trajectory (Personal History): one point per position per day from cost basis.
  const pnlRows = positions
    .filter((p) => p && typeof p.id === "string" && typeof p.avg === "number" && (p.avg as number) > 0 && typeof p.price === "number")
    .map((p) => ({ ticker: (p.id as string).toUpperCase(), pnl: +((((p.price as number) - (p.avg as number)) / (p.avg as number)) * 100).toFixed(1) }));

  const holds = positions.filter((p) => p && typeof p.id === "string" && typeof p.thesis === "string" && (p.thesis as string).trim().length >= 12);
  if (!holds.length) { await recordPositionObservations(userId, pnlRows); return { holdings: 0, scored: 0 }; }
  const priceById: Record<string, number | null> = {};
  for (const p of holds) priceById[String(p.id).toUpperCase()] = typeof p.price === "number" ? (p.price as number) : null;

  let idx = 0, scored = 0;
  const captured: Record<string, BriefSignals> = {};       // per-ticker recap/material the brief renders
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const verdicts: Record<string, any> = {};                // thesis verdicts to write back to state.json
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const intelBriefs: Record<string, any> = {};              // intel briefs to write back to state.json
  const worker = async () => {
    while (idx < holds.length) {
      const p = holds[idx++];
      const tk = String(p.id).toUpperCase();
      try {
        const res = await fetch(`${APP}/api/thesis-check`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-cron-secret": secret, "x-cron-user": userId },
          body: JSON.stringify({ ticker: p.id, thesis: p.thesis, price: p.price ?? null, name: p.name ?? null, currency: p.currency ?? null, exchange: p.exchange ?? null, catalyst: p.catalyst ?? null }),
        });
        if (res.ok) {
          const j = await res.json().catch(() => null);
          if (j && j.status && !j.error) {
            scored++;
            if (j.briefSignals) captured[tk] = j.briefSignals as BriefSignals;
            verdicts[tk] = { status: j.status, points: j.points, summary: j.summary, scorecard: j.scorecard, businessScore: j.businessScore, checkedAt: new Date().toISOString() };
          }
        }
      } catch { /* skip this holding, keep sweeping */ }
      // Intel Brief — refresh daily alongside the thesis check ($0, same free cascade).
      try {
        const ir = await fetch(`${APP}/api/intel`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-cron-secret": secret },
          body: JSON.stringify({ ticker: p.id, thesis: p.thesis || "", exitRule: p.exit || "", data: { price: p.price, name: p.name, currency: p.currency, exchange: p.exchange }, mode: "intel" }),
        });
        if (ir.ok) {
          const ij = await ir.json().catch(() => null);
          if (ij?.brief) intelBriefs[tk] = { timestamp: new Date().toISOString(), text: ij.brief, ai: true };
        }
      } catch { /* fail-soft */ }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(4, concurrency)) }, worker));
  // Write sweep results back into the user's state.json so the dashboard shows fresh data
  // without manual rechecks. Single read-modify-write for both thesisStatusCache + intelBriefCache.
  const hasVerdicts = Object.keys(verdicts).length > 0;
  const hasIntels = Object.keys(intelBriefs).length > 0;
  if (hasVerdicts || hasIntels) {
    try {
      const { data: stateBlob, error: stateErr } = await admin().storage.from("plainview-state").download(`${userId}/state.json`);
      if (!stateErr && stateBlob) {
        const state = JSON.parse(await stateBlob.text());
        if (hasVerdicts) {
          const cache = state.thesisStatusCache || {};
          for (const [tk, v] of Object.entries(verdicts)) {
            const prev = cache[tk];
            const changed = prev && prev.status && String(prev.status).toLowerCase() !== String((v as { status: string }).status).toLowerCase();
            cache[tk] = { ...prev, ...(v as Record<string, unknown>), prevStatus: prev?.status ?? null, changedAt: changed ? new Date().toISOString() : (prev?.changedAt ?? null) };
          }
          state.thesisStatusCache = cache;
        }
        if (hasIntels) {
          const iCache = state.intelBriefCache || {};
          for (const [tk, v] of Object.entries(intelBriefs)) iCache[tk] = v;
          state.intelBriefCache = iCache;
        }
        await admin().storage.from("plainview-state").upload(`${userId}/state.json`, JSON.stringify(state), { upsert: true, contentType: "application/json" });
      }
    } catch { /* fail-soft — dashboard just shows stale until next manual check */ }
  }
  // Persist the captured recap/material so buildBrief can render texture + the material radar ($0, no re-fetch).
  if (Object.keys(captured).length) {
    const payload = JSON.stringify({ ts: Date.now(), tickers: captured });
    try { await admin().storage.from("plainview-state").upload(`${userId}/_brief.json`, payload, { upsert: true, contentType: "application/json" }); } catch { /* fail-open */ }
    // The evening run also snapshots the day's CLOSE → the morning brief reports yesterday's close, not pre-market.
    if (snapshotClose) { try { await admin().storage.from("plainview-state").upload(`${userId}/_close.json`, payload, { upsert: true, contentType: "application/json" }); } catch { /* fail-open */ } }
  }
  // Slice 1 — trajectory observations (additive, fail-soft, $0). GLOBAL per-ticker market obs from the signals
  // the sweep already captured (idempotent per day → ~one write/ticker/day across all users) + the user's
  // per-position P&L points. See ONE-BRAIN.md.
  for (const [tk, sig] of Object.entries(captured)) {
    await recordTickerObservation(tk, { price: priceById[tk] ?? null, day: sig.day, volX: sig.volX, ma: sig.ma, near52: sig.near52 ?? null });
  }
  await recordPositionObservations(userId, pnlRows);
  return { holdings: holds.length, scored };
}

// ── ADAPTIVE SWEEP BUDGET — auto-tunes how long the morning sweep may run so it uses Pro's full function
// window when available AND can never starve the (fast) sends on Hobby's 60s cap, with NO env to remember.
// The guard LEARNS the platform cap: each run probes the full window and drops a "started" marker; on
// completion it drops a "completed" marker. If a run is killed mid-sweep (Hobby), the next run sees a
// "started but never completed" state → infers the window was overrun → falls to a safe floor and stays
// there, re-probing the full window only rarely (≈monthly) so an upgrade is rediscovered automatically.
// State is one tiny JSON in Storage; fully fail-open (any error → the safe floor). On Pro this sits at the
// full window from day one; after a Hobby downgrade it self-heals to the safe floor within a single run.
const SWEEP_HARD_CEILING = 285000; // under the route's maxDuration=300 with margin for the sends
const SWEEP_SAFE_FLOOR = 45000;    // safe under Hobby's 60s function cap (incl. the send reserve)
const SWEEP_REPROBE_EVERY = 30;    // runs held at the floor before re-probing the full window (≈ monthly)
const SWEEP_STATE_KEY = "_system/sweep-budget.json";
type SweepState = { ceilingHitMs: number | null; lastEffectiveCap: number; lastCompleted: boolean; runsSinceProbe: number; lastActualMs?: number };
// Reserve time for the post-cutoff work the budget does NOT gate: buildBrief + the throttled send for every
// remaining user (~1.2s each) plus a base buffer. Keeps total runtime ≈ effectiveCap.
const sweepReserveMs = (users: number) => users * 1200 + 8000;

async function readSweepState(): Promise<SweepState> {
  try {
    const { data, error } = await admin().storage.from("plainview-state").download(SWEEP_STATE_KEY);
    if (error || !data) throw error;
    const s = JSON.parse(await data.text());
    return { ceilingHitMs: s.ceilingHitMs ?? null, lastEffectiveCap: s.lastEffectiveCap ?? SWEEP_SAFE_FLOOR, lastCompleted: s.lastCompleted !== false, runsSinceProbe: s.runsSinceProbe ?? 0, lastActualMs: s.lastActualMs };
  } catch { return { ceilingHitMs: null, lastEffectiveCap: SWEEP_SAFE_FLOOR, lastCompleted: true, runsSinceProbe: 0 }; }
}
async function writeSweepState(s: SweepState): Promise<void> {
  try { await admin().storage.from("plainview-state").upload(SWEEP_STATE_KEY, JSON.stringify(s), { upsert: true, contentType: "application/json" }); } catch { /* fail-open */ }
}

// Decide this run's sweep budget AND mark the run "started" (so a mid-sweep kill is detectable next time).
// Returns the ms the sweep may consume. If env SWEEP_BUDGET_MS is set it's an explicit manual override and
// the adaptive guard is skipped (escape hatch).
export async function beginSweepBudget(userCount: number): Promise<{ budgetMs: number; effectiveCap: number; mode: string }> {
  const manual = Number(process.env.SWEEP_BUDGET_MS) || 0;
  if (manual > 0) return { budgetMs: Math.max(8000, manual), effectiveCap: manual + sweepReserveMs(userCount), mode: "manual" };
  const st = await readSweepState();
  // A run that started but never completed = it was killed mid-sweep → its effectiveCap exceeded the cap.
  if (st.lastCompleted === false) { st.ceilingHitMs = Math.min(st.ceilingHitMs ?? Number.MAX_SAFE_INTEGER, st.lastEffectiveCap); st.runsSinceProbe = 0; }
  let effectiveCap: number, mode: string;
  if (st.ceilingHitMs == null) {
    effectiveCap = SWEEP_HARD_CEILING; mode = "full";              // never killed (e.g. Pro) → full window
  } else if (++st.runsSinceProbe >= SWEEP_REPROBE_EVERY) {
    effectiveCap = SWEEP_HARD_CEILING; st.runsSinceProbe = 0; mode = "reprobe"; // rare re-probe (catch an upgrade)
  } else {
    effectiveCap = SWEEP_SAFE_FLOOR; mode = "floor";              // known-capped (e.g. Hobby) → stay safe
  }
  const budgetMs = Math.max(8000, effectiveCap - sweepReserveMs(userCount));
  await writeSweepState({ ceilingHitMs: st.ceilingHitMs, lastEffectiveCap: effectiveCap, lastCompleted: false, runsSinceProbe: st.runsSinceProbe, lastActualMs: st.lastActualMs });
  return { budgetMs, effectiveCap, mode };
}

// Mark the run completed (it wasn't killed) — so the next run knows this effectiveCap was survivable.
export async function endSweepBudget(effectiveCap: number, actualMs: number): Promise<void> {
  if ((Number(process.env.SWEEP_BUDGET_MS) || 0) > 0) return; // manual override → no learning
  const st = await readSweepState();
  await writeSweepState({ ceilingHitMs: st.ceilingHitMs, lastEffectiveCap: effectiveCap, lastCompleted: true, runsSinceProbe: st.runsSinceProbe, lastActualMs: actualMs });
}
