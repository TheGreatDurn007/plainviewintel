import { createClient } from "@supabase/supabase-js";
import { listActions } from "@/lib/nexus-memory";
import { callCerebrasText, callGroqText, callGeminiText } from "@/lib/market-context";
import Anthropic from "@anthropic-ai/sdk";
import { getJudgmentModel, autoDowngradeOnCreditDepletion } from "@/lib/ai-tier";
import { recordSmartSpend } from "@/lib/ai-spend";
import type { MarketContext, BriefSignals } from "@/lib/daily-brief";

const APP = "https://plainviewintel.com";

function displayTicker(t: string): string {
  const wm = t.match(/^([A-Z0-9]+)[.\-](WS|WT|WR|RT)$/i);
  if (wm) return `${wm[1].toUpperCase()}-WT`;
  return t;
}

function admin() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
}

// ── DATA GATHERING ──────────────────────────────────────────────────────────

type Position = Record<string, unknown>;
type Book = { displayName: string; positions: Position[]; watchlist: Position[] };
async function loadUserBook(userId: string): Promise<Book> {
  try {
    const { data, error } = await admin().storage.from("plainview-state").download(`${userId}/state.json`);
    if (error || !data) return { displayName: "", positions: [], watchlist: [] };
    const s = JSON.parse(await data.text());
    return { displayName: String(s?.appSettings?.displayName || "").trim(), positions: Array.isArray(s?.positions) ? s.positions : [], watchlist: Array.isArray(s?.watchlist) ? s.watchlist : [] };
  } catch { return { displayName: "", positions: [], watchlist: [] }; }
}

type EvalRow = { ticker: string; status: string; strength_score: number | null; evaluated_at: string };

async function weeklyEvals(userId: string): Promise<EvalRow[]> {
  const cutoff = new Date(Date.now() - 8 * 86400_000).toISOString();
  const { data } = await admin().from("nexus_thesis_evaluations")
    .select("ticker, status, strength_score, evaluated_at")
    .eq("user_id", userId).gte("evaluated_at", cutoff)
    .order("evaluated_at", { ascending: false }).limit(2000);
  return (data ?? []) as EvalRow[];
}

async function loadBriefSignals(userId: string): Promise<Record<string, BriefSignals>> {
  try {
    const { data, error } = await admin().storage.from("plainview-state").download(`${userId}/_brief.json`);
    if (error || !data) return {};
    const s = JSON.parse(await data.text());
    return (s && typeof s.tickers === "object" && s.tickers) ? s.tickers : {};
  } catch { return {}; }
}

const up = (t: string) => t.toUpperCase();

// Position context for grounding the stance — the Ledger must KNOW if someone is underwater.
type PosContext = { ticker: string; shares: number; avg: number; price: number; pnl: number; pnlPct: number; thesis: string };
function positionContexts(book: Book): Map<string, PosContext> {
  const m = new Map<string, PosContext>();
  for (const p of book.positions) {
    const tk = up(String((p as { id?: string }).id || ""));
    const shares = Number((p as { shares?: number }).shares) || 0;
    const avg = Number((p as { avg?: number }).avg) || 0;
    const price = Number((p as { price?: number }).price) || 0;
    const thesis = String((p as { thesis?: string }).thesis || "").trim();
    if (!tk || !shares || !avg) continue;
    const pnl = (price - avg) * shares;
    const pnlPct = avg > 0 ? ((price - avg) / avg) * 100 : 0;
    m.set(tk, { ticker: tk, shares, avg, price, pnl, pnlPct: Math.round(pnlPct * 10) / 10, thesis });
  }
  return m;
}

// ── CONVICTION ANALYSIS (week-over-week) ──────────────────────────────────

type ConvictionChange = { ticker: string; now: number; was: number; delta: number; status: string; newlyContradicted: boolean };

function analyzeConviction(evals: EvalRow[]): { changes: ConvictionChange[]; avgDelta: number; strengthened: number; weakened: number; stable: number; massContraWarning: boolean } {
  const byTicker = new Map<string, EvalRow[]>();
  for (const r of evals) { const a = byTicker.get(r.ticker) ?? []; a.push(r); byTicker.set(r.ticker, a); }

  const changes: ConvictionChange[] = [];
  let sumDelta = 0, n = 0, contraCount = 0;
  let strengthened = 0, weakened = 0, stable = 0;

  for (const [ticker, rows] of byTicker) {
    if (rows.length < 2) continue;
    const latest = rows[0];
    const latestDay = String(latest.evaluated_at).slice(0, 10);
    const oldest = rows.find(r => String(r.evaluated_at).slice(0, 10) < latestDay);
    if (!oldest || latest.strength_score == null || oldest.strength_score == null) continue;

    const delta = Math.round((latest.strength_score - oldest.strength_score) * 10) / 10;
    const newlyContradicted = /contradict|unsupport/i.test(String(latest.status)) && !/contradict|unsupport/i.test(String(oldest.status));
    changes.push({ ticker, now: latest.strength_score, was: oldest.strength_score, delta, status: String(latest.status), newlyContradicted });
    if (newlyContradicted) contraCount++;
    sumDelta += delta;
    n++;
    if (delta > 0.3) strengthened++;
    else if (delta < -0.3) weakened++;
    else stable++;
  }

  changes.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  // If >60% of evaluated theses became contradicted this week, it's almost certainly a data/sweep quality
  // issue (rate limits → thin retrieval → false negatives) rather than reality. Flag it.
  const massContraWarning = n >= 4 && contraCount / n > 0.6;
  return { changes, avgDelta: n ? Math.round((sumDelta / n) * 10) / 10 : 0, strengthened, weakened, stable, massContraWarning };
}

// ── THE SURPRISE (one per week) ───────────────────────────────────────────

function findSurprise(changes: ConvictionChange[], book: Book, sig: Record<string, BriefSignals>, posCtx: Map<string, PosContext>): string | null {
  for (const c of changes) {
    if (c.delta >= 1.0) {
      const s = sig[c.ticker];
      const pos = posCtx.get(c.ticker);
      if (s && s.day != null && s.day < 2) return `Your conviction in ${c.ticker} rose ${c.delta > 0 ? "+" : ""}${c.delta.toFixed(1)} this week while the stock barely moved — you may be seeing something the market hasn't priced yet.`;
      if (pos && pos.pnlPct < -10 && c.delta >= 1.0) return `${c.ticker} is ${Math.abs(pos.pnlPct).toFixed(0)}% underwater from your $${pos.avg.toFixed(2)} average, but your conviction rose ${c.delta > 0 ? "+" : ""}${c.delta.toFixed(1)} this week. Strengthening thesis under pressure — that's patience with a reason.`;
    }
  }
  const inZone = book.watchlist.filter(w => w && (w as { zoneState?: string }).zoneState === "in");
  if (inZone.length) {
    const tk = String((inZone[0] as { ticker?: string }).ticker);
    return `${tk} entered your buy zone this week. You set the entry — now it's at your price. If the thesis still holds, the discipline says buy.`;
  }
  return null;
}

// ── BEHAVIORAL INSIGHT ("what I learned about you") ────────────────────────

async function findBehavioralInsight(userId: string, book: Book): Promise<string | null> {
  const acts = await listActions(userId, 100);
  if (acts.length < 3) return null;

  const opens = acts.filter(a => (a as { action_type?: string }).action_type === "opened");
  const trims = acts.filter(a => (a as { action_type?: string }).action_type === "trimmed");
  const adds = acts.filter(a => (a as { action_type?: string }).action_type === "added");
  const closes = acts.filter(a => (a as { action_type?: string }).action_type === "closed");

  const zoneOpens = opens.filter(a => (a as { buy_zone_state?: string }).buy_zone_state === "in");
  if (opens.length >= 3 && zoneOpens.length >= opens.length * 0.6) return `You're disciplined on entries — ${zoneOpens.length} of your last ${opens.length} buys started inside a buy zone. Keep doing that.`;

  if (adds.length >= 3) {
    const addedDown = adds.filter(a => { const v = (a as { thesis_verdict?: string }).thesis_verdict; return /contradict|unsupport|weakening/i.test(String(v || "")); });
    if (addedDown.length >= 2) return `You've added to ${addedDown.length} positions while their theses were weakening. That's either conviction or stubbornness — check whether the evidence actually supports the add.`;
  }

  if (book.positions.length >= 10 && acts.length <= 5) return `You hold ${book.positions.length} positions and have barely touched them. That's either patience or neglect — the Ledger will tell you which as conviction data accrues.`;

  if (trims.length >= 2 || closes.length >= 2) return `You've been active this week — ${trims.length + closes.length} trims or closes. That's conviction management, not panic, as long as each exit had a reason.`;

  return null;
}

// ── "IF I OWNED YOUR BOOK" (the stance) ────────────────────────────────────
// CONTEXT-AWARE: never tell someone to "trim" a name they're underwater on without acknowledging the reality.

function buildStance(changes: ConvictionChange[], items: Array<{ ticker: string; sev: number; why: string }>, zones: Array<{ ticker: string }>, posCtx: Map<string, PosContext>): string {
  const parts: string[] = [];
  const weakest = changes.filter(c => c.delta < -0.5 || c.newlyContradicted).sort((a, b) => a.delta - b.delta)[0];
  const strongest = changes.filter(c => c.delta > 0).sort((a, b) => b.delta - a.delta)[0];
  const topEvent = items[0];

  if (weakest) {
    const pos = posCtx.get(weakest.ticker);
    if (pos && pos.pnlPct < -15) {
      parts.push(`I'd re-read my ${weakest.ticker} thesis — the evidence weakened this week, but you're ${Math.abs(pos.pnlPct).toFixed(0)}% underwater from $${pos.avg.toFixed(2)}, so this is about whether the thesis still holds, not about trimming at a loss.`);
    } else {
      parts.push(`I'd spend the week on ${weakest.ticker} — that's where the uncertainty lives${weakest.newlyContradicted ? " and the evidence is turning" : ""}.`);
    }
  } else if (topEvent) {
    parts.push(`I'd look at ${topEvent.ticker} first — ${topEvent.why}.`);
  }

  if (strongest && strongest.ticker !== weakest?.ticker) parts.push(`I wouldn't touch ${strongest.ticker}. The thesis is strengthening — let it work.`);
  else if (changes.length && !weakest) parts.push("Nothing here needs your hands this week. That's the job most weeks.");

  if (zones.length && parts.length < 3) {
    const zTks = zones.slice(0, 3).map(z => z.ticker);
    parts.push(`${zTks.join(", ")} ${zTks.length > 1 ? "are" : "is"} in your buy zone — if you still believe the thesis, the discipline says buy.`);
  }

  if (!parts.length) parts.push("A quiet week. Your theses held, your conviction held. Nothing here needs your hands.");

  return parts.slice(0, 3).join(" ");
}

// ── MONDAY'S PLAYBOOK (≤3 action bullets) ──────────────────────────────────

function buildPlaybook(changes: ConvictionChange[], sig: Record<string, BriefSignals>, zones: Array<{ ticker: string }>, posCtx: Map<string, PosContext>): string[] {
  const plays: string[] = [];
  const contra = changes.filter(c => c.newlyContradicted || c.delta < -1);
  for (const c of contra.slice(0, 2)) {
    const s = sig[c.ticker];
    const mat = s?.material?.[0];
    const pos = posCtx.get(c.ticker);
    const underwaterNote = pos && pos.pnlPct < -15 ? ` (you're ${Math.abs(pos.pnlPct).toFixed(0)}% underwater — this is about the thesis, not about selling)` : "";
    if (mat) plays.push(`<b>${c.ticker}</b> — read the ${mat.kind === "dilution" ? "dilution filing" : mat.kind === "insider_sell" ? "insider selling" : "new filing"} and decide if the thesis still holds${underwaterNote}.`);
    else plays.push(`<b>${c.ticker}</b> — conviction fell ${Math.abs(c.delta).toFixed(1)} this week. Re-read your thesis${underwaterNote}.`);
  }
  for (const z of zones.slice(0, 1)) { if (plays.length < 3) plays.push(`<b>${z.ticker}</b> is in your buy zone — set a limit at your entry, don't chase.`); }
  const strong = changes.filter(c => c.delta > 0.5 && !contra.some(cc => cc.ticker === c.ticker));
  for (const s of strong.slice(0, 1)) { if (plays.length < 3) plays.push(`<b>${s.ticker}</b> — hold. Conviction is rising; nothing to do.`); }
  if (!plays.length) plays.push("Hold the line. Nothing changed this week that demands a trade.");
  return plays.slice(0, 3);
}

// ── GROUNDED NARRATIVE (the Assessment) ────────────────────────────────────

async function composeLedgerNarrative(facts: string): Promise<string | null> {
  if (!facts.trim()) return null;
  const prompt = `You are PLAINVIEW — an investor's own analyst, writing their WEEKLY assessment. This is THE LEDGER — a Sunday-evening intelligence report. You've watched their portfolio all week and now you're telling them where they stand going into Monday.
VOICE: a plainspoken, decisive hedge-fund CIO — Marks/Druckenmiller/Munger calm. Ruthlessly clear, never aggressive. Allergic to noise. Won't flatter.
Write 4 to 7 flowing sentences. LEAD WITH WHAT HAPPENED ON THEIR NAMES THIS WEEK (price moves, news, filings, sector action) — that's what they want to know first. Conviction changes are one input among many, not the headline. Connect the market backdrop to THEIR positions. Land on the ONE thing that counts going into Monday.
RULES:
- Use ONLY the facts below. NEVER invent a number, ticker, company, or event not listed. Every figure is checked; an invented one gets the whole piece thrown out.
- DISCUSS tickers by name and what drove them (the why is in the facts — a headline, a filing, a sector move).
- NEVER tell the reader to "trim" or "sell" a position they're underwater on — you don't know their strategy. Frame it as "re-read the thesis" or "decide if you still believe it."
- No greeting, no sign-off, no markdown, no lists, no clichés ("in conclusion", "overall"). Flowing, decisive prose.

FACTS:
${facts}`;

  const norm = (s: string) => s.replace(/[\s+,]/g, "");
  const audit = (text: string): boolean => {
    const f = norm(facts);
    const risky = text.match(/\$\d[\d.]*[a-zA-Z]?|-?\d[\d.]*%/g) || [];
    return risky.every(r => f.includes(norm(r)));
  };
  const clean = (s: string | null | undefined) => String(s || "").trim().replace(/^["']+|["']+$/g, "").trim();

  // FREE CASCADE FIRST — Cerebras→Groq→Gemini at $0. Anthropic is the emergency-only fallback.
  for (const call of [callCerebrasText, callGroqText, callGeminiText]) {
    try {
      const out = clean(await call(prompt, 0));
      if (out.length > 30 && out.length < 1200 && audit(out)) return out;
    } catch { /* next */ }
  }
  // Anthropic fallback — only fires when all free providers failed.
  const smart = await getJudgmentModel();
  if (process.env.ANTHROPIC_API_KEY) {
    try {
      const model = smart || "claude-haiku-4-5-20251001";
      const a = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: 25000 });
      const res = await a.messages.create({ model, max_tokens: 450, temperature: 0.4, messages: [{ role: "user", content: prompt }] });
      const out = clean(res.content.filter(b => b.type === "text").map(b => (b as unknown as { text: string }).text).join(""));
      if (out.length > 30 && out.length < 1200 && audit(out)) { if (smart) void recordSmartSpend(smart, res.usage?.input_tokens || 0, res.usage?.output_tokens || 0); return out; }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("credit balance")) void autoDowngradeOnCreditDepletion();
    }
  }
  return null;
}

// ── BUILD THE LEDGER ──────────────────────────────────────────────────────

export async function buildLedger(userId: string, market?: MarketContext | null): Promise<{ subject: string; html: string; text: string } | null> {
  const [book, evals, sig] = await Promise.all([
    loadUserBook(userId),
    weeklyEvals(userId),
    loadBriefSignals(userId),
  ]);

  if (!evals.length && !book.positions.length) return null;

  const firstName = book.displayName.split(/\s+/)[0] || "";
  const { changes, avgDelta, strengthened, weakened, stable, massContraWarning } = analyzeConviction(evals);
  const posCtx = positionContexts(book);

  // Fetch latest prices for the heat map
  const priceMove: Record<string, number> = {};
  try {
    const syms = [...new Set(book.positions.map(p => up(String((p as { id?: string }).id || ""))).filter(Boolean))];
    if (syms.length) {
      const r = await fetch(`${APP}/api/prices?symbols=${encodeURIComponent(syms.join(","))}`, { headers: process.env.CRON_SECRET ? { "x-cron-secret": process.env.CRON_SECRET } : {} });
      if (r.ok) { const j = await r.json(); for (const pr of (j.prices || [])) { if (typeof pr.changePercent === "number") priceMove[up(String(pr.symbol))] = Math.round(pr.changePercent * 10) / 10; } }
    }
  } catch { /* fail-soft */ }
  const moveOf = (tk: string): number | null => priceMove[tk] ?? sig[tk]?.day ?? null;

  // Zones
  const zones = book.watchlist
    .filter(w => w && typeof w.ticker === "string" && (w as { zoneState?: string }).zoneState === "in" && Number((w as { current?: number }).current) > 0 && Number((w as { entry?: number }).entry) > 0 && Number((w as { current?: number }).current) <= Number((w as { entry?: number }).entry))
    .map(w => ({ ticker: String((w as { ticker?: string }).ticker) }));

  // Event items for the stance
  type Item = { ticker: string; sev: number; why: string };
  const items: Item[] = [];
  for (const [tk, s] of Object.entries(sig)) {
    const mat = s.material?.[0];
    if (mat) items.push({ ticker: tk, sev: 90, why: mat.kind === "dilution" ? "dilution filing" : mat.kind === "insider_buy" ? "insider buying" : mat.kind === "insider_sell" ? "insider selling" : "new filing" });
    if (s.day != null && Math.abs(s.day) >= 3) items.push({ ticker: tk, sev: 70, why: `moved ${s.day > 0 ? "+" : ""}${s.day.toFixed(1)}%` });
  }
  if (!massContraWarning) {
    for (const c of changes.filter(c => c.newlyContradicted)) items.push({ ticker: c.ticker, sev: 95, why: "thesis contradicted" });
  }
  items.sort((a, b) => b.sev - a.sev);

  // Movers with context (price + news/filing + P&L situation)
  const dayMoves: Array<{ tk: string; day: number }> = [];
  let wval = 0, wsum = 0;
  const sectorAgg = new Map<string, { wval: number; wsum: number; n: number }>();
  for (const p of book.positions) {
    const tk = up(String((p as { id?: string }).id || ""));
    const dm = moveOf(tk);
    const shares = Number((p as { shares?: number }).shares) || 0;
    const px = Number((p as { price?: number }).price) || 0;
    if (dm != null && shares > 0 && px > 0) {
      const v = shares * px; wval += v; wsum += v * dm;
      dayMoves.push({ tk, day: dm });
      const sec = (sig[tk]?.sector || "").trim();
      if (sec) { const g = sectorAgg.get(sec) || { wval: 0, wsum: 0, n: 0 }; g.wval += v; g.wsum += v * dm; g.n++; sectorAgg.set(sec, g); }
    }
  }
  const bookDay = wval > 0 ? Math.round((wsum / wval) * 10) / 10 : null;
  dayMoves.sort((a, b) => b.day - a.day);
  const sectors = [...sectorAgg.entries()].map(([name, g]) => ({ name, day: Math.round((g.wsum / g.wval) * 10) / 10, n: g.n })).sort((a, b) => b.day - a.day);

  // Notable movers with a WHY
  const secs = market?.sectors || [];
  const sectorMoveByName: Record<string, number> = {};
  for (const s of secs) sectorMoveByName[s.name.toLowerCase()] = s.day;
  const sectorMoveFor = (sec?: string | null): number | null => {
    if (!sec) return null; const k = sec.toLowerCase().split(/[ /]/)[0];
    for (const name in sectorMoveByName) if (k && (name.startsWith(k) || k.startsWith(name.split(" ")[0]))) return sectorMoveByName[name];
    return null;
  };
  const moverDetails = dayMoves
    .filter(m => Math.abs(m.day) >= 0.5)
    .sort((a, b) => Math.abs(b.day) - Math.abs(a.day))
    .slice(0, 8)
    .map(m => {
      const s = sig[m.tk]; const head = s?.news?.[0]; const mat = s?.material?.[0]; const secMove = sectorMoveFor(s?.sector);
      const why = head ? String(head).slice(0, 100)
        : mat ? mat.text.slice(0, 90)
          : (s?.sector && secMove != null) ? `tracking ${s.sector} (${secMove > 0 ? "+" : ""}${secMove.toFixed(1)}%)`
            : "on no company news";
      const pos = posCtx.get(m.tk);
      const pnlNote = pos ? ` · ${pos.pnlPct > 0 ? "+" : ""}${pos.pnlPct.toFixed(0)}% from $${pos.avg.toFixed(2)}` : "";
      return { tk: m.tk, day: m.day, why, pnlNote };
    });

  // Build each module
  const surprise = findSurprise(changes, book, sig, posCtx);
  const behavioral = await findBehavioralInsight(userId, book);
  const stance = buildStance(changes, items, zones, posCtx);
  const playbook = buildPlaybook(changes, sig, zones, posCtx);

  // Actions this week
  const weekActions = await (async () => {
    const acts = await listActions(userId, 60);
    const weekCut = new Date(Date.now() - 7 * 86400_000).toISOString().slice(0, 10);
    return acts.filter(a => String((a as { occurred_at?: string }).occurred_at || "").slice(0, 10) >= weekCut);
  })();
  const actSummary = (() => {
    const pick = (type: string) => [...new Set(weekActions.filter(a => (a as { action_type?: string }).action_type === type).map(a => displayTicker(String((a as { ticker?: string }).ticker || ""))).filter(Boolean))];
    const o = pick("opened"), ad = pick("added"), tr = pick("trimmed"), cl = pick("closed");
    const p: string[] = [];
    if (o.length) p.push(`Opened <b>${o.join(", ")}</b>`);
    if (ad.length) p.push(`Added to <b>${ad.join(", ")}</b>`);
    if (tr.length) p.push(`Trimmed <b>${tr.join(", ")}</b>`);
    if (cl.length) p.push(`Closed <b>${cl.join(", ")}</b>`);
    return p.join(" &nbsp;·&nbsp; ");
  })();

  // Narrative facts — events/market first, conviction second
  const factParts: string[] = [];
  if (market && (market.sp != null || market.nasdaq != null)) {
    const mkt: string[] = [];
    if (market.sp != null) mkt.push(`S&P ${market.sp > 0 ? "+" : ""}${market.sp.toFixed(1)}%`);
    if (market.nasdaq != null) mkt.push(`Nasdaq ${market.nasdaq > 0 ? "+" : ""}${market.nasdaq.toFixed(1)}%`);
    if (market.vix != null) mkt.push(`VIX ${market.vix.toFixed(0)}`);
    const lead = secs.filter(s => s.day > 0.5).slice(0, 3).map(s => `${s.name} +${s.day.toFixed(1)}%`);
    const lag = secs.filter(s => s.day < -0.5).slice(-3).reverse().map(s => `${s.name} ${s.day.toFixed(1)}%`);
    factParts.push(`Market: ${mkt.join(", ")}.${lead.length ? ` Leading sectors: ${lead.join(", ")}.` : ""}${lag.length ? ` Lagging: ${lag.join(", ")}.` : ""}`);
  }
  if (bookDay != null) factParts.push(`Their portfolio ${bookDay > 0 ? "+" : ""}${bookDay}% (value-weighted).`);
  if (moverDetails.length) factParts.push(`Movers and why:\n${moverDetails.map(m => `- ${m.tk} ${m.day > 0 ? "+" : ""}${m.day.toFixed(1)}%: ${m.why}${m.pnlNote}`).join("\n")}`);
  const matFacts = Object.entries(sig).filter(([, s]) => s.material?.length).map(([tk, s]) => `${tk}: ${s.material![0].text.slice(0, 80)}`);
  if (matFacts.length) factParts.push(`Material filings: ${matFacts.slice(0, 3).join("; ")}.`);
  if (actSummary) factParts.push(`Actions this week: ${actSummary.replace(/<[^>]+>/g, "")}.`);
  factParts.push(`${book.positions.length} positions. Conviction: ${strengthened} strengthened, ${weakened} weakened, ${stable} stable (avg Δ ${avgDelta > 0 ? "+" : ""}${avgDelta.toFixed(1)}).`);
  if (changes.length && !massContraWarning) factParts.push(`Biggest conviction moves: ${changes.slice(0, 3).map(c => `${c.ticker} ${c.delta > 0 ? "+" : ""}${c.delta.toFixed(1)}${c.newlyContradicted ? " CONTRADICTED" : ""}`).join(", ")}.`);
  if (massContraWarning) factParts.push(`Note: most theses were flagged contradicted this week — this may reflect data retrieval issues rather than real fundamental changes. Interpret with caution.`);
  if (zones.length) factParts.push(`In buy zone: ${zones.map(z => z.ticker).join(", ")}.`);
  // Position context for underwater names — so the narrative respects the user's reality
  const underwaterNames = [...posCtx.values()].filter(p => p.pnlPct < -15).slice(0, 3);
  if (underwaterNames.length) factParts.push(`Underwater positions (DO NOT suggest trimming these — the reader knows): ${underwaterNames.map(p => `${p.ticker} ${p.pnlPct.toFixed(0)}% from $${p.avg.toFixed(2)} avg`).join(", ")}.`);

  const narrative = await composeLedgerNarrative(factParts.join("\n"));
  const detRead = (() => {
    const parts: string[] = [];
    if (market?.sp != null) parts.push(`The market closed the week with the S&P at ${market.sp > 0 ? "+" : ""}${market.sp.toFixed(1)}%.`);
    if (bookDay != null) parts.push(`Your portfolio ${bookDay > 0 ? "+" : ""}${bookDay}% on the week.`);
    if (moverDetails.length) parts.push(`Biggest movers: ${moverDetails.slice(0, 3).map(m => `${m.tk} ${m.day > 0 ? "+" : ""}${m.day.toFixed(1)}%`).join(", ")}.`);
    parts.push(`Conviction: ${strengthened} strengthened, ${weakened} weakened.`);
    return parts.join(" ");
  })();
  const readText = narrative || detRead;
  const readSentences = readText.split(/(?<=[.!?])\s+(?=[A-Z"'$])/).map(s => s.trim()).filter(Boolean);

  // ── RENDER ──────────────────────────────────────────────────────────────

  const C = { bg: "#0a0b0d", card: "#111317", bd: "#20242b", green: "#1fdf64", red: "#ff5c5c", amber: "#e0a500", t: "#e8eaed", t2: "#b4bac3", t3: "#7e8794" };
  const MONO = "'SF Mono','SFMono-Regular','Menlo','Consolas','Roboto Mono',monospace";
  const tag = (u: string, content: string) => `${u}${u.includes("?") ? "&" : "?"}utm_source=ledger&utm_medium=email&utm_campaign=ledger&utm_content=${content}`;
  const readHtml = readSentences.map(s => `<div style="margin:0 0 9px;line-height:1.55">${s}</div>`).join("");
  const pulseText = `${book.positions.length} positions · ${strengthened} strengthened · ${weakened} weakened · avg Δ ${avgDelta > 0 ? "+" : ""}${avgDelta.toFixed(1)}`;

  // VALUE-WEIGHTED HEAT MAP (same finviz-style bar from the daily brief)
  let heatGrid = "";
  if (dayMoves.length) {
    const valItems = book.positions
      .map(p => { const tk = up(String((p as { id?: string }).id || "")); return { tk, val: (Number((p as { shares?: number }).shares) || 0) * (Number((p as { price?: number }).price) || 0), day: moveOf(tk) }; })
      .filter((h): h is { tk: string; val: number; day: number } => !!h.tk && h.val > 0 && h.day != null)
      .sort((a, b) => b.val - a.val);
    if (valItems.length) {
      const top = valItems.slice(0, 8);
      const restVal = valItems.slice(8).reduce((a, h) => a + h.val, 0);
      const totalVal = valItems.reduce((a, h) => a + h.val, 0) || 1;
      const heatBg = (d: number | null) => d == null ? "#23272e" : d >= 2 ? "#15803d" : d > 0.05 ? "#1a5e35" : d <= -2 ? "#8c1d1d" : d < -0.05 ? "#5e2424" : "#3a3f47";
      const segs = top.map(h => ({ tk: h.tk, w: (h.val / totalVal) * 100, day: h.day as number | null }));
      if (restVal > 0) segs.push({ tk: "+more", w: (restVal / totalVal) * 100, day: null });
      const cells = segs.map(sg => {
        const w = Math.max(1, Math.round(sg.w));
        const label = sg.w >= 9 ? `<div style="font-family:${MONO};font-weight:700;color:#fff;font-size:12px;line-height:1.1">${sg.tk}</div>${sg.day != null ? `<div style="font-family:${MONO};font-weight:700;color:#fff;opacity:.92;font-size:11px;line-height:1.2;margin-top:2px">${sg.day > 0 ? "+" : ""}${sg.day.toFixed(1)}%</div>` : ""}` : (sg.w >= 4 ? `<div style="font-family:${MONO};font-weight:700;color:#fff;font-size:9px">${sg.tk}</div>` : "&nbsp;");
        return `<td width="${w}%" style="padding:2px"><div style="background:${heatBg(sg.day)};border-radius:6px;padding:11px 2px;text-align:center;overflow:hidden">${label}</div></td>`;
      });
      heatGrid = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;table-layout:fixed"><tr>${cells.join("")}</tr></table><div style="font-size:11px;color:${C.t3};margin-top:5px">Sized by position weight · colored by latest session move</div>`;
    }
  }

  // Sector heat-map (2-up grid)
  let sectorGrid = "";
  if (sectors.length >= 2) {
    const heat = (d: number) => ({ bg: d >= 2 ? "#14401e" : d > 0.05 ? "#172a1c" : d <= -2 ? "#451616" : d < -0.05 ? "#2a1719" : "#1a1d22", fg: d >= 0.05 ? C.green : d <= -0.05 ? C.red : C.t2 });
    const cell = (s: { name: string; day: number; n: number }) => { const h = heat(s.day);
      return `<td width="50%" style="padding:4px"><div style="background:${h.bg};border:1px solid ${C.bd};border-radius:9px;padding:9px 11px"><div style="font-weight:700;color:${C.t};font-size:13px">${s.name}</div><div style="font-family:${MONO};font-weight:700;color:${h.fg};font-size:13px;margin-top:2px">${s.day > 0 ? "+" : ""}${s.day.toFixed(1)}% <span style="color:${C.t3};font-weight:400">· ${s.n} holding${s.n === 1 ? "" : "s"}</span></div></div></td>`; };
    const cells = sectors.map(cell), trs: string[] = [];
    for (let i = 0; i < cells.length; i += 2) { const r = cells.slice(i, i + 2); while (r.length < 2) r.push('<td width="50%"></td>'); trs.push(`<tr>${r.join("")}</tr>`); }
    sectorGrid = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">${trs.join("")}</table>`;
  }

  // Movers with why + P&L context
  const moverHtml = moverDetails.map(m =>
    `<div style="font-size:13px;color:${C.t2};padding:7px 0;line-height:1.5;border-top:1px solid ${C.bd}"><span style="font-family:${MONO};font-weight:700;color:${m.day >= 0 ? C.green : C.red}">${m.tk} ${m.day > 0 ? "+" : ""}${m.day.toFixed(1)}%</span> &nbsp;<span style="color:${C.t2}">${m.why}</span>${m.pnlNote ? `<span style="color:${C.t3};font-size:12px">${m.pnlNote}</span>` : ""}</div>`
  ).join("");

  // Market pulse
  const mkt: string[] = [];
  if (market?.sp != null) mkt.push(`S&P ${market.sp > 0 ? "+" : ""}${market.sp.toFixed(1)}%`);
  if (market?.nasdaq != null) mkt.push(`Nasdaq ${market.nasdaq > 0 ? "+" : ""}${market.nasdaq.toFixed(1)}%`);
  if (market?.vix != null) mkt.push(`VIX ${market.vix.toFixed(0)}`);
  const marketLine = mkt.join(" · ");
  const sectorLead = secs.filter(s => s.day > 0.5).slice(0, 3).map(s => `${s.name} +${s.day.toFixed(1)}%`);
  const sectorLag = secs.filter(s => s.day < -0.5).slice(-3).reverse().map(s => `${s.name} ${s.day.toFixed(1)}%`);

  // Conviction rows — capped at 4, not 6. With a mass-contra guard.
  const convictionRows = (massContraWarning ? [] : changes.slice(0, 4)).map(c => {
    const col = c.newlyContradicted ? C.red : c.delta > 0 ? C.green : c.delta < 0 ? C.red : C.t2;
    const pos = posCtx.get(c.ticker);
    const posNote = pos ? `<span style="color:${C.t3};font-size:11px;margin-left:6px">${pos.pnlPct > 0 ? "+" : ""}${pos.pnlPct.toFixed(0)}% from $${pos.avg.toFixed(2)}</span>` : "";
    const badge = c.newlyContradicted ? `<span style="background:#451616;color:${C.red};font-size:10px;font-weight:700;padding:2px 7px;border-radius:4px;margin-left:8px">CONTRADICTED</span>` : "";
    return `<tr><td style="padding:10px 0;border-top:1px solid ${C.bd}">
      <a href="${tag(`${APP}/x-ray/${c.ticker}`, "conviction")}" style="text-decoration:none;color:inherit;display:block">
        <span style="font-family:${MONO};font-weight:700;color:${C.t};font-size:14px">${c.ticker}</span>${badge}${posNote}
        <span style="display:block;color:${C.t3};font-size:12px;margin-top:3px">${c.was.toFixed(1)} → ${c.now.toFixed(1)}</span>
      </a>
    </td><td style="padding:10px 0;border-top:1px solid ${C.bd};text-align:right;vertical-align:top;font-family:${MONO};font-weight:700;color:${col};font-size:14px">${c.delta > 0 ? "+" : ""}${c.delta.toFixed(1)}</td></tr>`;
  }).join("");

  const playbookHtml = playbook.map(p =>
    `<div style="font-size:13.5px;color:${C.t2};padding:8px 0;line-height:1.5;border-top:1px solid ${C.bd}"><span style="color:${C.green};font-weight:700">→</span> ${p}</div>`
  ).join("");

  // Watchlist
  const approaching = book.watchlist
    .map(w => ({ ticker: String((w as { ticker?: string }).ticker || ""), c: Number((w as { current?: number }).current), e: Number((w as { entry?: number }).entry) }))
    .filter(w => w.ticker && w.c > 0 && w.e > 0 && w.c > w.e && w.c <= w.e * 1.06)
    .map(w => ({ ticker: w.ticker, gap: Math.round((w.c / w.e - 1) * 1000) / 10 }))
    .sort((a, b) => a.gap - b.gap);
  const wlZone = zones.map(z => z.ticker);
  const wlApproach = approaching.slice(0, 5).map(a => `${a.ticker} ${a.gap}% away`);
  const showWatch = wlZone.length > 0 || wlApproach.length > 0;

  const html = `<style>@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;700;800&family=Syne:wght@700;800&display=swap');</style><div style="background:${C.bg};margin:0;padding:0;width:100%">
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;opacity:0;color:transparent">${firstName ? `${firstName}, ` : ""}your analyst has finished the week's assessment.${bookDay != null ? ` Portfolio ${bookDay > 0 ? "+" : ""}${bookDay}%.` : ""} ${moverDetails.length ? `${moverDetails[0].tk} ${moverDetails[0].day > 0 ? "+" : ""}${moverDetails[0].day.toFixed(1)}%` : ""}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.bg};border-collapse:collapse"><tr><td align="center" style="padding:24px 12px">
  <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:${C.card};border:1px solid ${C.bd};border-radius:16px;border-collapse:separate;font-family:'Inter',-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">

    <!-- MASTHEAD -->
    <tr><td style="padding:22px 26px 0">
      <table role="presentation" cellpadding="0" cellspacing="0"><tr>
        <td style="vertical-align:middle"><span style="display:inline-block;width:26px;height:26px;background:${C.green};border-radius:7px;color:${C.bg};font-weight:800;font-size:15px;text-align:center;line-height:26px;font-family:Arial">P</span></td>
        <td style="vertical-align:middle;padding-left:9px"><span style="font-weight:800;font-size:15px;color:${C.t};letter-spacing:.05em">PLAINVIEW</span> <span style="font-size:11px;color:${C.amber};font-weight:700;letter-spacing:.1em">THE LEDGER</span></td>
      </tr></table>
    </td></tr>

    <!-- §1 THE ASSESSMENT -->
    <tr><td style="padding:24px 26px 0">
      <div style="font-size:11px;text-transform:uppercase;letter-spacing:.1em;color:${C.t3};font-weight:700;margin-bottom:8px">The assessment</div>
      <div style="font-size:14px;color:${C.t2}">${readHtml}</div>
    </td></tr>

    <!-- PORTFOLIO MAP -->
    ${heatGrid ? `<tr><td style="padding:22px 26px 0">
      <div style="font-size:11px;text-transform:uppercase;letter-spacing:.1em;color:${C.t3};font-weight:700;margin-bottom:8px">Your portfolio</div>
      ${heatGrid}
    </td></tr>` : ""}

    <!-- MARKET PULSE -->
    ${marketLine ? `<tr><td style="padding:22px 26px 0">
      <div style="font-size:11px;text-transform:uppercase;letter-spacing:.1em;color:${C.t3};font-weight:700;margin-bottom:6px">Market this week</div>
      <div style="font-size:13.5px;color:${C.t2};padding:2px 0">${marketLine}</div>
      ${sectorLead.length ? `<div style="font-size:13px;color:${C.green};padding:2px 0">▲ ${sectorLead.join(" · ")}</div>` : ""}
      ${sectorLag.length ? `<div style="font-size:13px;color:${C.red};padding:2px 0">▼ ${sectorLag.join(" · ")}</div>` : ""}
    </td></tr>` : ""}

    <!-- YOUR SECTORS -->
    ${sectorGrid ? `<tr><td style="padding:20px 26px 0">
      <div style="font-size:11px;text-transform:uppercase;letter-spacing:.1em;color:${C.t3};font-weight:700;margin-bottom:8px">Your sectors</div>
      ${sectorGrid}
    </td></tr>` : ""}

    <!-- MOVERS & WHY -->
    ${moverHtml ? `<tr><td style="padding:22px 26px 0">
      <div style="font-size:11px;text-transform:uppercase;letter-spacing:.1em;color:${C.t3};font-weight:700;margin-bottom:6px">What moved &amp; why</div>
      ${moverHtml}
    </td></tr>` : ""}

    <!-- WHAT YOU DID -->
    ${actSummary ? `<tr><td style="padding:20px 26px 0">
      <div style="font-size:11px;text-transform:uppercase;letter-spacing:.1em;color:${C.t3};font-weight:700;margin-bottom:6px">What you did this week</div>
      <div style="font-size:13.5px;color:${C.t2};line-height:1.6">${actSummary}</div>
    </td></tr>` : ""}

    ${convictionRows ? `<!-- CONVICTION -->
    <tr><td style="padding:22px 26px 0">
      <div style="font-size:11px;text-transform:uppercase;letter-spacing:.1em;color:${C.t3};font-weight:700;margin-bottom:4px">Conviction changes</div>
      ${massContraWarning ? `<div style="font-size:12px;color:${C.amber};margin-bottom:8px;line-height:1.5">⚠ Most theses were flagged contradicted this week — this may reflect data retrieval issues rather than real changes. Take these with a grain of salt.</div>` : ""}
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">${convictionRows}</table>
      <div style="font-size:12px;color:${C.t3};margin-top:6px">${pulseText}</div>
    </td></tr>` : `<tr><td style="padding:22px 26px 0"><div style="font-size:12px;color:${C.t3}">${pulseText}</div></td></tr>`}

    ${massContraWarning ? `<tr><td style="padding:16px 26px 0">
      <div style="font-size:12px;color:${C.amber};line-height:1.5;padding:10px;background:#1a1710;border:1px solid #3d3520;border-radius:8px">⚠ <b>Data quality notice:</b> ${changes.filter(c => c.newlyContradicted).length} of ${changes.length} theses showed as newly contradicted — that's unusual and likely reflects the thesis-check sweep hitting rate limits on external data sources rather than genuine fundamental changes across your whole portfolio. The Ledger is showing you what the system saw, but interpret the conviction section with caution this week.</div>
    </td></tr>` : ""}

    ${surprise ? `<!-- THE SURPRISE -->
    <tr><td style="padding:24px 26px 0">
      <div style="font-size:11px;text-transform:uppercase;letter-spacing:.1em;color:${C.amber};font-weight:700;margin-bottom:8px">The surprise</div>
      <div style="font-size:14px;color:${C.t};line-height:1.55;font-style:italic">${surprise}</div>
    </td></tr>` : ""}

    ${behavioral ? `<!-- WHAT I LEARNED ABOUT YOU -->
    <tr><td style="padding:24px 26px 0">
      <div style="font-size:11px;text-transform:uppercase;letter-spacing:.1em;color:${C.green};font-weight:700;margin-bottom:8px">What I learned about you</div>
      <div style="font-size:14px;color:${C.t};line-height:1.55">${behavioral}</div>
    </td></tr>` : ""}

    <!-- IF I OWNED YOUR BOOK -->
    <tr><td style="padding:24px 26px 0">
      <div style="font-size:11px;text-transform:uppercase;letter-spacing:.1em;color:${C.t};font-weight:700;margin-bottom:8px">If I owned your book</div>
      <div style="font-size:15px;color:${C.t};line-height:1.55;font-weight:500">${stance}</div>
    </td></tr>

    <!-- MONDAY'S PLAYBOOK -->
    <tr><td style="padding:24px 26px 0">
      <div style="font-size:11px;text-transform:uppercase;letter-spacing:.1em;color:${C.green};font-weight:700;margin-bottom:6px">Monday's playbook</div>
      ${playbookHtml}
    </td></tr>

    ${showWatch ? `<!-- WATCHLIST -->
    <tr><td style="padding:22px 26px 0">
      <div style="font-size:11px;text-transform:uppercase;letter-spacing:.1em;color:${C.t3};font-weight:700;margin-bottom:6px">Watchlist</div>
      ${wlZone.length ? `<div style="font-size:13.5px;color:${C.green};padding:3px 0;line-height:1.5">◆ In buy zone: <b>${wlZone.join(", ")}</b></div>` : ""}
      ${wlApproach.length ? `<div style="font-size:13.5px;color:${C.t2};padding:3px 0;line-height:1.5">↗ Approaching: ${wlApproach.join("&nbsp; · &nbsp;")}</div>` : ""}
    </td></tr>` : ""}

    <!-- CTA -->
    <tr><td style="padding:24px 26px 4px">
      <a href="${tag(`${APP}/`, "cta")}" style="display:inline-block;background:${C.green};color:${C.bg};text-decoration:none;font-weight:700;padding:13px 28px;border-radius:10px;font-size:15px">Investigate in Plainview &rarr;</a>
    </td></tr>

    <!-- FOOTER -->
    <tr><td style="padding:16px 26px 24px">
      <div style="border-top:1px solid ${C.bd};padding-top:14px;font-size:11px;color:${C.t3};line-height:1.6">Your analyst finished. The Ledger watches your operation, not the market — the data it uses is yours alone. &nbsp;<a href="${tag(`${APP}/settings`, "prefs")}" style="color:${C.t3};text-decoration:underline">Preferences</a> &nbsp;·&nbsp; <a href="%%UNSUB%%" style="color:${C.t3};text-decoration:underline">Unsubscribe</a></div>
    </td></tr>

  </table>
</td></tr></table></div>`;

  // Plain text
  const textMovers = moverDetails.length ? `\nWhat moved & why:\n${moverDetails.map(m => `  ${m.tk} ${m.day > 0 ? "+" : ""}${m.day.toFixed(1)}% — ${m.why}${m.pnlNote}`).join("\n")}\n` : "";
  const textConviction = convictionRows ? `\nConviction changes:\n${changes.slice(0, 4).map(c => `  ${c.ticker}: ${c.was.toFixed(1)} → ${c.now.toFixed(1)} (${c.delta > 0 ? "+" : ""}${c.delta.toFixed(1)})${c.newlyContradicted ? " CONTRADICTED" : ""}`).join("\n")}\n` : "";
  const textPlaybook = playbook.map(p => `  → ${p.replace(/<[^>]+>/g, "")}`).join("\n");
  const textActs = actSummary ? `\nWhat you did: ${actSummary.replace(/<[^>]+>/g, "")}\n` : "";
  const textWatch = showWatch ? `\nWatchlist:${wlZone.length ? ` In buy zone: ${wlZone.join(", ")}.` : ""}${wlApproach.length ? ` Approaching: ${wlApproach.join(", ")}.` : ""}\n` : "";

  const text = `PLAINVIEW · THE LEDGER\n\n${readSentences.join("\n\n")}\n\n${pulseText}${textMovers}${textActs}${textConviction}${surprise ? `\nThe surprise:\n  ${surprise}\n` : ""}${behavioral ? `\nWhat I learned about you:\n  ${behavioral}\n` : ""}\nIf I owned your book:\n  ${stance}\n\nMonday's playbook:\n${textPlaybook}${textWatch}\n\nInvestigate in Plainview: ${APP}/\n\nUnsubscribe: %%UNSUB%%`;

  const subject = `${firstName ? `${firstName}, ` : ""}your weekly assessment${bookDay != null ? ` — portfolio ${bookDay > 0 ? "+" : ""}${bookDay}%` : moverDetails.length ? ` — ${moverDetails[0].tk} ${moverDetails[0].day > 0 ? "+" : ""}${moverDetails[0].day.toFixed(1)}%` : ""}`;

  return { subject, html, text };
}
