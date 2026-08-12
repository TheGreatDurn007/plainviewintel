import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { fetchTechnicalData, fetchRecentNews, fetchNewsForTicker, fetchCashRunwaySec, fetchSecSignals, writeTickerMemory, type SecSignal } from "@/lib/market-context";

// Hidden Gem Radar — Phase A (deterministic funnel, no AI cost per candidate).
// Stage 1 (cheap, every candidate): price/volume/TA + recent news → classify catalyst vs red flag,
//   derive the technical setup + squeeze fuel, and bucket into Research Candidate / Watch / Ignore /
//   Red Flag. TA is ATTENTION, never proof; a positive catalyst is required to be a Research
//   Candidate; short interest only AMPLIFIES names that already have a real catalyst.
// Reasons are composed from the signals (categories + narrative, no fake % math).

export const maxDuration = 55;

// Constructive catalysts (a real reason a name is interesting).
const POSITIVE_RE = /\b(fda approval|nda (submitted|accepted)|phase\s*[123]|trial (results|data)|topline|readout|primary endpoint|contract (award|win)|awarded|deal signed|definitive agreement|letter of intent|partnership|collaboration|acquisition|to acquire|merger|takeover|earnings beat|beats? (estimates|expectations)|record (revenue|quarter|attendance|production|sales)|guidance raised|raises? (guidance|outlook)|permit (approved|granted|accepted)|nrc approval|fedramp|insider buying|bought .* shares|drill|intercept|g\/t|resource (estimate|update|growth)|\bpea\b|\bpfs\b|\bdfs\b|backlog|offtake|government (grant|contract|award|funding)|order win|breakthrough|approval)\b/i;
// Red flags / disqualifiers (dilution, distress, legal, regulatory failure).
const RISK_RE = /\b(offering|at-the-market|\batm\b|priced .* offering|convertible notes? offering|registered direct|dilution|shares? (issued|sold)|shelf (filing|registration)|reverse split|going concern|substantial doubt|lawsuit|class action|securities fraud|investor.* (deadline|counsel)|sec (investigation|charges)|delisting|deficiency (notice|letter)|bankruptc|chapter 11|default|guidance (cut|lowered|reduced)|earnings miss|misses? (estimates|expectations)|restructuring|layoffs|fda rejection|\bcrl\b|complete response letter|clinical hold|trial fail)\b/i;
// SOFT / weak catalysts — opinion, ratings, listicles, "could surge" hype. Attention, NOT a real
// company event. These keep a name at "Watch" but never make it a Research Candidate on their own.
const SOFT_CAT_RE = /\b(analyst|price target|\bpt\b raised|upgrade|downgrade|initiat\w* coverage|\brating\b|under ?valued|over ?valued|stocks? to (buy|watch|own)|top \d+ (stocks|picks|plays)|best stocks|could (rally|soar|surge|jump|double|explode)|why .* (is|could|might)|\d+ (stocks|reasons|things)|reasons to (buy|own)|here'?s why|is it a buy|worth (buying|watching))\b/i;

// ─── Curated universes ──────────────────────────────────────────────────────
// The most-active/gainer screeners skew large/mid-cap, so genuine gems (junior miners, clinical
// biotech, quantum) rarely enter the pool. These deliberate universes are scanned every run through
// the SAME funnel. Owner-saved lists (Supabase Storage, edited in-app) are the source of truth; the
// in-code DEFAULT_UNIVERSES are the seed/fallback. See lib/radar-universes.ts.
type Universe = import("@/lib/radar-universes").Universe;

let _universeCache: { at: number; data: Universe[] } | null = null;
async function loadUniverses(): Promise<Universe[]> {
  if (_universeCache && Date.now() - _universeCache.at < 10 * 60 * 1000) return _universeCache.data;
  const { DEFAULT_UNIVERSES, readSavedUniverses } = await import("@/lib/radar-universes");
  let data = DEFAULT_UNIVERSES;
  try {
    const saved = await readSavedUniverses();
    if (saved && saved.length) data = saved; // owner edits win; else curated defaults
  } catch { /* unreachable → curated defaults */ }
  _universeCache = { at: Date.now(), data };
  return data;
}

type TA = Awaited<ReturnType<typeof fetchTechnicalData>>;

type ChartStats = { price: number | null; ma50: number | null; ma200: number | null; avgVol: number | null; curVol: number | null; week52High: number | null; week52Low: number | null; d1: number | null; d5: number | null; d21: number | null; d63: number | null };

// Compute MA50/MA200/volume/52wk from the v8 chart (1y daily). Reliable + crumb-free, unlike the
// quoteSummary modules fetchTechnicalData relies on (which Yahoo now blocks without a crumb).
async function fetchChartStats(ticker: string): Promise<ChartStats> {
  const empty: ChartStats = { price: null, ma50: null, ma200: null, avgVol: null, curVol: null, week52High: null, week52Low: null, d1: null, d5: null, d21: null, d63: null };
  try {
    const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=1y&interval=1d`, { headers: { "User-Agent": "Plainview/1.0" }, cache: "no-store" });
    if (!r.ok) return empty;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const j: any = await r.json();
    const res = j?.chart?.result?.[0];
    const meta = res?.meta || {};
    const closes: number[] = (res?.indicators?.quote?.[0]?.close || []).filter((x: unknown) => typeof x === "number" && Number.isFinite(x));
    const vols: number[] = (res?.indicators?.quote?.[0]?.volume || []).filter((x: unknown) => typeof x === "number" && Number.isFinite(x));
    const avg = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
    const price = Number(meta.regularMarketPrice ?? closes[closes.length - 1] ?? meta.previousClose) || null;
    // Period returns vs the live price (~21 trading days = 1mo, ~63 = 3mo). Cheap — closes already in hand.
    const ret = (back: number): number | null => {
      if (!price || closes.length <= back) return null;
      const past = closes[closes.length - 1 - back];
      return past && past > 0 ? ((price - past) / past) * 100 : null;
    };
    return {
      price: price && price > 0 ? price : null,
      ma50: closes.length >= 10 ? avg(closes.slice(-50)) : null,
      ma200: closes.length >= 40 ? avg(closes.slice(-200)) : null,
      avgVol: vols.length >= 10 ? avg(vols.slice(-50)) : null,
      curVol: vols.length ? vols[vols.length - 1] : null,
      week52High: closes.length ? Math.max(...closes) : null,
      week52Low: closes.length ? Math.min(...closes) : null,
      d1: ret(1), d5: ret(5), d21: ret(21), d63: ret(63),
    };
  } catch { return empty; }
}

function setupLabel(s: { ma50: number | null; ma200: number | null; rsi: number | null; week52High: number | null }, price: number | null, volRatio: number | null): string {
  const { ma50, ma200, rsi, week52High } = s;
  if (rsi != null && rsi >= 78) return "Overextended — do not chase";
  if (rsi != null && rsi <= 30) return "Oversold — possible reversal";
  if (price != null && ma50 != null) {
    const aboveMA50 = price >= ma50;
    const extended = price >= ma50 * 1.15;
    const nearHigh = week52High != null && price >= week52High * 0.95;
    if (ma200 != null) {
      const aboveMA200 = price >= ma200;
      if (aboveMA50 && aboveMA200 && volRatio != null && volRatio >= 2 && nearHigh) return "Breakout with volume";
      if (aboveMA50 && aboveMA200 && Math.abs(price - ma50) / ma50 <= 0.04) return "Pullback to MA50 (healthy trend)";
      if (aboveMA50 && !aboveMA200) return "Reclaiming MA50";
      if (!aboveMA50 && volRatio != null && volRatio >= 2) return "Accumulation watch (still below MA50)";
      if (!aboveMA50 && !aboveMA200) return "Weak trend — below both MAs";
    } else {
      // Newer listing / no 200-day history — don't mislabel as "base building".
      if (extended) return "Extended above MA50";
      if (aboveMA50) return "Above MA50 (limited long-term history)";
      return "Below MA50";
    }
  }
  if (volRatio != null && volRatio >= 2) return "Unusual volume";
  return "Base building / no clear setup";
}

function squeezeFuel(shortRatio: number | null, daysToCover: number | null): "high" | "medium" | "low" {
  const sp = shortRatio != null ? shortRatio * 100 : null; // ratio → percent of float
  if ((sp != null && sp >= 20) || (daysToCover != null && daysToCover >= 5)) return "high";
  if ((sp != null && sp >= 10) || (daysToCover != null && daysToCover >= 3)) return "medium";
  return "low";
}

const cap = <T>(p: Promise<T>, ms: number, fb: T): Promise<T> => Promise.race([p, new Promise<T>((r) => setTimeout(() => r(fb), ms))]);

// Candidate sourcing: free Yahoo predefined screeners give a dynamic "what's moving today" universe.
// Returns symbol + the volume/change signals so Stage 1 can filter WITHOUT any extra per-name fetch.
type ScreenerRow = { symbol: string; name: string | null; marketCap: number | null; changePct: number | null; volumeRatio: number | null };
async function fetchScreener(scrIds: string, count = 30): Promise<ScreenerRow[]> {
  try {
    const url = `https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved?scrIds=${scrIds}&count=${count}&start=0&fields=symbol,shortName,marketCap,regularMarketChangePercent,regularMarketVolume,averageDailyVolume3Month`;
    const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Plainview/1.0", Accept: "application/json,text/plain,*/*" }, cache: "no-store" });
    if (!r.ok) return [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const j: any = await r.json();
    const quotes = j?.finance?.result?.[0]?.quotes ?? [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return quotes.map((q: any) => {
      const vol = Number(q.regularMarketVolume), avg = Number(q.averageDailyVolume3Month);
      return {
        symbol: String(q.symbol || "").toUpperCase(),
        name: String(q.shortName || q.longName || "") || null,
        marketCap: Number.isFinite(Number(q.marketCap)) ? Number(q.marketCap) : null,
        changePct: Number.isFinite(Number(q.regularMarketChangePercent)) ? Number(q.regularMarketChangePercent) : null,
        volumeRatio: vol && avg && avg > 0 ? vol / avg : null,
      } as ScreenerRow;
    }).filter((x: ScreenerRow) => x.symbol);
  } catch { return []; }
}

// Does a headline actually NAME this company (ticker or a distinctive name word), or is it a peer/
// sector article that merely mentions it (e.g. a "Dell's AI Factory" piece tagged to NVDA)? Only a
// headline centered on the company counts as its catalyst — that kills the peer-headline false positives.
const NAME_STOP = /\b(inc|corp|corporation|ltd|limited|plc|holdings?|company|co|group|the|technologies|technology|industries|enterprises|international|systems|solutions)\b/gi;
function headlineNamesCompany(headline: string, ticker: string, name: string | null): boolean {
  const t = ticker.replace(/\..*$/, "");
  if (t.length >= 2 && new RegExp(`(^|[^A-Za-z])${t}([^A-Za-z]|$)`, "i").test(headline)) return true; // ticker / (TICKER)
  if (name) {
    const words = name.toLowerCase().replace(/[.,&]/g, " ").replace(NAME_STOP, " ").split(/\s+/).filter((w) => w.length >= 4);
    const h = headline.toLowerCase();
    if (words.some((w) => h.includes(w))) return true;
  }
  return false;
}

const LARGE_CAP = 1e10; // $10B — above this a name is well-followed, not a "hidden gem"

// Stage 2 — enrich a shortlist name: chart TA + recent news → setup, catalyst/red-flag, category.
async function enrichCandidate(ticker: string, meta?: { name?: string | null; marketCap?: number | null; universe?: string | null }) {
  const name = meta?.name ?? null;
  const marketCap = meta?.marketCap ?? null;
  const universe = meta?.universe ?? null;
  const [ta, news, cs, secSigs] = await Promise.all([
    cap(fetchTechnicalData(ticker), 4500, null as TA | null),
    cap(fetchNewsForTicker(ticker, name), 4500, [] as string[]),
    cap(fetchChartStats(ticker), 5000, { price: null, ma50: null, ma200: null, avgVol: null, curVol: null, week52High: null, week52Low: null } as ChartStats),
    cap(fetchSecSignals(ticker), 5000, [] as SecSignal[]),
  ]);
  // Fix #1: a catalyst only counts if the headline NAMES this company (not a peer/sector mention).
  // Fix #3 (catalyst quality): split MATERIAL events (contract/FDA/drill/earnings beat/partnership)
  // from SOFT/opinion headlines (analyst ratings, "could surge", listicles). Only a material catalyst
  // can make a Research Candidate; a soft one keeps the name at Watch.
  let posCat: string | null = null, softCat: string | null = null, riskCat: string | null = null, rejectedPeerCat: string | null = null;
  for (const h of news || []) {
    const aboutThis = headlineNamesCompany(h, ticker, name);
    if (RISK_RE.test(h)) { if (!riskCat && aboutThis) riskCat = h; continue; }
    if (POSITIVE_RE.test(h)) {
      if (!aboutThis) { if (!rejectedPeerCat) rejectedPeerCat = h; continue; }
      if (SOFT_CAT_RE.test(h)) { if (!softCat) softCat = h; } else if (!posCat) posCat = h; // material vs soft
    } else if (aboutThis && SOFT_CAT_RE.test(h) && !softCat) softCat = h;
  }
  // ── SEC filing signals ────────────────────────────────────────────────────
  // Legally required filings are stronger evidence than news headlines — they can't be clickbait.
  // CALIBRATION: form type is first-pass only. Unambiguous negatives auto-override (NT, bankruptcy,
  // restatement). Positives (Form 4 P, Item 1.01) drive Research Candidate classification directly.
  const SEC_HARD_BEARISH = new Set(["NT 10-Q", "NT 10-K", "NT 20-F"]);
  const secHardFlag = secSigs.find(s =>
    s.signal === "bearish" && (SEC_HARD_BEARISH.has(s.form) || /bankruptcy|non-reliance|debt covenant/i.test(s.summary))
  );
  const secSoftFlag = secSigs.find(s => s.signal === "bearish" && !secHardFlag);
  const secDilution = secSigs.find(s => /dilut|offering|shelf|prospectus/i.test(s.summary));

  // HIGH-SIGNAL SEC POSITIVES — drive Research Candidate directly, no news needed
  // Form 4 bullish (open-market purchase, transaction code P) — insider buys with real money
  const secInsiderBuy = secSigs.find(s => s.signal === "bullish" && s.form === "4");
  // 8-K material agreement (Item 1.01) or acquisition (2.01) — legally required disclosure of real events
  const secMaterialEvent = secSigs.find(s =>
    (s.form === "8-K" || s.form === "8-K/A") && s.items &&
    /\b(1\.01|2\.01)\b/.test(s.items) && s.signal !== "bearish"
  );
  // 13D — activist or strategic 5%+ stake (intent to engage)
  const sec13D = secSigs.find(s => s.form === "SC 13D" || s.form === "SC 13D/A");
  // Other watch signals (13G, 8-K other items) — notable but not primary drivers
  const secWatchOther = secSigs.find(s =>
    s.signal === "watch" && !secDilution &&
    s !== secInsiderBuy && s !== secMaterialEvent && s !== sec13D
  );

  // Hard red flag → override to Red Flag regardless of news catalyst
  if (secHardFlag && !riskCat) riskCat = `SEC: ${secHardFlag.summary} (${secHardFlag.form} ${secHardFlag.date})`;
  // Soft bearish — flag the risk but don't override category on its own
  if (secSoftFlag && !riskCat) riskCat = `SEC: ${secSoftFlag.summary} (${secSoftFlag.form} ${secSoftFlag.date})`;

  // ── Promote SEC positives to primary catalyst if no news catalyst exists ──
  // Hierarchy: insider buy > material agreement > 13D.
  // This is the core of evidence-first: a Form 4 open-market purchase IS the catalyst —
  // we don't need a news headline to confirm it. The filing is the evidence.
  if (!posCat && secInsiderBuy) {
    posCat = `SEC Form 4 purchase: ${secInsiderBuy.summary.slice(0, 90)}`;
  } else if (!posCat && secMaterialEvent) {
    posCat = `SEC 8-K Item ${secMaterialEvent.items}: ${secMaterialEvent.summary.slice(0, 90)}`;
  } else if (!softCat && sec13D) {
    softCat = `SEC 13D: ${sec13D.summary.slice(0, 80)}`;
  }

  const price = cs.price, ma50 = cs.ma50, ma200 = cs.ma200;
  const volRatio = cs.avgVol && cs.curVol ? cs.curVol / cs.avgVol : null;
  const rsi = ta?.rsi ?? null;
  const setup = setupLabel({ ma50, ma200, rsi, week52High: cs.week52High }, price, volRatio);
  const fuel = squeezeFuel(ta?.shortPercentOfFloat ?? null, ta?.daysToCover ?? null);
  const overextended = rsi != null && rsi >= 78;
  const volAnomaly = volRatio != null && volRatio >= 1.8;
  const aboveMA50 = price != null && ma50 != null && price >= ma50;

  // ── Evidence Momentum score ──────────────────────────────────────────────
  // A deterministic count of how much real evidence is improving.
  // Used to rank Research Candidates above each other — SEC-driven names surface first.
  // Points are additive, never fabricated; each maps directly to a filed document.
  let evidenceScore = 0;
  if (secInsiderBuy)    evidenceScore += 3; // open-market purchase — insider puts real money in
  if (secMaterialEvent) evidenceScore += 2; // material agreement / acquisition (Item 1.01/2.01)
  if (sec13D)           evidenceScore += 2; // activist or strategic 5%+ stake
  if (posCat && !secInsiderBuy && !secMaterialEvent) evidenceScore += 2; // news catalyst
  if (volAnomaly)       evidenceScore += 1; // volume confirmation
  if (aboveMA50)        evidenceScore += 1; // TA confirmation
  if (secWatchOther)    evidenceScore += 1; // other notable SEC watch signal
  if (secDilution)      evidenceScore -= 1; // dilution pressure
  if (secHardFlag)      evidenceScore -= 3; // hard negative (NT, bankruptcy)

  // ── Build reasons array — SEC evidence FIRST, then news, then TA ──────────
  // Order matters: the first reason is what the card leads with. Evidence-first.
  const reasons: string[] = [];
  if (secInsiderBuy) reasons.push(`✅ SEC Form 4: ${secInsiderBuy.summary.slice(0, 150)}`);
  if (secMaterialEvent) reasons.push(`📋 SEC 8-K Item ${secMaterialEvent.items}: ${secMaterialEvent.summary.slice(0, 80)}`);
  if (sec13D) reasons.push(`📋 SEC 13D: ${sec13D.summary.slice(0, 70)}`);
  // News catalyst (only if not already covered by a SEC signal above)
  if (posCat && !secInsiderBuy && !secMaterialEvent) reasons.push(`catalyst: "${posCat.slice(0, 80)}"`);
  else if (softCat && !sec13D && !secInsiderBuy && !secMaterialEvent) reasons.push(`soft signal: "${softCat.slice(0, 60)}"`);
  // TA confirmation — comes after the evidence, describes the setup
  if (volAnomaly) reasons.push(`volume ${volRatio!.toFixed(1)}x avg`);
  if (aboveMA50) reasons.push("above MA50");
  // Other SEC watch (notable but not primary)
  if (secWatchOther && !riskCat) reasons.push(`📋 SEC ${secWatchOther.form}: ${secWatchOther.summary.slice(0, 70)}`);
  // Dilution always surfaces — it's an independent risk flag
  if (secDilution) reasons.push(`⚠ SEC ${secDilution.form}: ${secDilution.summary.slice(0, 70)}`);

  // Catalyst = spark, TA = attention. SEC filings drive Research Candidate; volume/MA are confirmations.
  // Guards: overextended RSI = wait for pullback; soft/opinion = Watch; survival checked below.
  const confirmed = volAnomaly || aboveMA50;
  let category: string, action: string;
  if (riskCat) {
    category = "Red Flag"; action = "Avoid / verify the filing — dilution or distress detected";
  } else if (posCat && !overextended) {
    category = "Research Candidate";
    // Distinguish SEC-driven from news-driven in the action text
    const driver = secInsiderBuy ? "insider purchase filed" : secMaterialEvent ? "material filing" : "catalyst";
    action = confirmed
      ? `Research — ${driver} + TA confirmation; verify substance before acting`
      : `Research — ${driver} (early, no crowd yet); read the filing`;
    if (confirmed) reasons.push("TA confirmed");
    if (fuel !== "low") reasons.push(`squeeze fuel: ${fuel}`);
  } else if (posCat && overextended) {
    category = "Watch"; action = "Watch — real catalyst but RSI overextended; wait for a pullback";
  } else if (volAnomaly) {
    category = "Watch"; action = "Heating up — volume surging, no filing catalyst identified yet";
  } else if (softCat) {
    category = "Watch"; action = "Watch — opinion/rating attention, not a hard catalyst yet";
  } else if (aboveMA50) {
    category = "Watch"; action = "Watch — above MA50, no catalyst yet";
  } else {
    category = "Ignore"; action = "No actionable signal today";
  }

  // Fix #2: a hidden-gem radar favors small/underfollowed names. A large/mega-cap can't be a Research
  // Candidate — it's well-followed, not hidden — so cap it at Watch.
  let downrankedLargeCap = false;
  if (marketCap != null && marketCap > LARGE_CAP && category === "Research Candidate") {
    category = "Watch"; action = "Watch — large, well-followed name (not a hidden gem); catalyst noted";
    reasons.push(`large cap ~$${(marketCap / 1e9).toFixed(0)}B`);
    downrankedLargeCap = true;
  }
  // Fix #4 (survival filter): can a cash-burning small-cap survive until its catalyst matters? The cash
  // + burn come from SEC EDGAR companyconcept (crumb-FREE; Yahoo's financialData is blocked). To stay
  // rate-safe we only pay this SEC round-trip for names that ALREADY cleared as Research Candidates and
  // are small-cap (<$2B) — exactly the set where dilution risk changes the call. A severe runway (<6mo)
  // demotes the name to Watch; a tighter runway is attached as a warning.
  let survivalRisk: string | null = null;
  if (category === "Research Candidate" && (marketCap == null || marketCap < 2e9)) {
    const rw = await cap(fetchCashRunwaySec(ticker), 6000, { cash: null, opCashTtm: null, runwayMonths: null });
    const months = rw.runwayMonths;
    if (months != null && months < 6) {
      survivalRisk = `short runway ~${Math.round(months)}mo — dilution likely before the thesis plays out`;
      category = "Watch"; action = "Watch — catalyst is real but cash runway is short; dilution risk first";
    } else if (months != null && months < 12) {
      survivalRisk = `limited runway ~${Math.round(months)}mo`;
    }
  }
  if (survivalRisk) reasons.push(`⚠ ${survivalRisk}`);

  // Persist SEC signals to ticker memory (fire-and-forget — radar enriches 42 candidates, can't block)
  if (secSigs.length) {
    void writeTickerMemory(ticker, {
      secSignals: secSigs.map(s => ({ ...s, storedAt: new Date().toISOString() })),
    });
  }

  return {
    ticker, name, marketCap, universe, category, action, setup, squeezeFuel: fuel, survivalRisk,
    evidenceScore,
    whySurfaced: reasons.length ? reasons.join(" + ") : "no notable signal",
    secSignals: secSigs.length ? secSigs : undefined,
    // Structured insider breakdown (deterministic Form 4 parse) for the gem card to render as fields.
    insider: secInsiderBuy?.form4 ?? null,
    riskFlag: riskCat, _rejectedPeerCat: rejectedPeerCat, _downrankedLargeCap: downrankedLargeCap,
    ta: { price, rsi, ma50, ma200, volRatio: volRatio != null ? Number(volRatio.toFixed(2)) : null, shortPctFloat: ta?.shortPercentOfFloat != null ? Number((ta.shortPercentOfFloat * 100).toFixed(1)) : null, daysToCover: ta?.daysToCover ?? null,
      d1: cs.d1 != null ? Number(cs.d1.toFixed(1)) : null, d5: cs.d5 != null ? Number(cs.d5.toFixed(1)) : null, d21: cs.d21 != null ? Number(cs.d21.toFixed(1)) : null, d63: cs.d63 != null ? Number(cs.d63.toFixed(1)) : null },
  };
}

// ─── Shared daily cache ───────────────────────────────────────────────────────
// The auto-sourced radar is GLOBAL (not per-user), so one shared scan/day serves everyone instantly.
// Stored in the same Supabase Storage bucket as the thesis cache. `refresh:true` forces a re-scan.
const RADAR_BUCKET = "plainview-state";
const RADAR_CACHE_KEY = "_radar/daily-v6.json"; // v6: structured Form 4 insider breakdown (role/stake-delta/cluster/10b5-1)
const RADAR_TTL = 12 * 60 * 60 * 1000; // 12h
function radarAdmin() { return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } }); }
async function readRadarCache(): Promise<(Record<string, unknown> & { _ts?: number }) | null> {
  try {
    const { data, error } = await radarAdmin().storage.from(RADAR_BUCKET).download(RADAR_CACHE_KEY);
    if (error || !data) return null;
    return JSON.parse(await data.text());
  } catch { return null; }
}
async function writeRadarCache(payload: Record<string, unknown>): Promise<void> {
  try {
    const blob = new Blob([JSON.stringify({ ...payload, _ts: Date.now() })], { type: "application/json" });
    await radarAdmin().storage.from(RADAR_BUCKET).upload(RADAR_CACHE_KEY, blob, { upsert: true, contentType: "application/json" });
  } catch { /* fail-open */ }
}

export async function POST(request: Request) {
  let body: { tickers?: string[]; autoSource?: boolean; refresh?: boolean };
  try { body = await request.json(); } catch { body = {}; }
  const explicit = Array.from(new Set((body.tickers || []).map((t) => String(t).trim().toUpperCase()).filter(Boolean)));
  const autoSource = body.autoSource === true || explicit.length === 0;
  const pureAuto = autoSource && explicit.length === 0; // only the global scan is shared-cacheable

  if (body.refresh === true) _universeCache = null; // a forced refresh re-reads owner-edited universes

  // Serve the shared daily scan from cache (instant) unless the user asked to refresh.
  if (pureAuto && body.refresh !== true) {
    const cached = await readRadarCache();
    if (cached && typeof cached._ts === "number" && Date.now() - cached._ts < RADAR_TTL) {
      return NextResponse.json({ ...cached, _cached: true, cacheAgeMin: Math.round((Date.now() - cached._ts) / 60000) });
    }
  }

  let poolSize = explicit.length;
  let sources: Record<string, number> = {};
  let shortlist: string[] = explicit;
  const metaMap = new Map<string, { name: string | null; marketCap: number | null; universe?: string | null }>();

  if (autoSource) {
    // STAGE 1 (cheap, no per-name fetch): pull movers/gainers/small-cap-gainers and keep only names
    // with a real volume anomaly or a big move. This is the candidate funnel's wide end.
    const [actives, gainers, smallGainers] = await Promise.all([
      fetchScreener("most_actives"),
      fetchScreener("day_gainers"),
      fetchScreener("small_cap_gainers"),
    ]);
    sources = { most_actives: actives.length, day_gainers: gainers.length, small_cap_gainers: smallGainers.length };
    const seen = new Set<string>();
    const union: ScreenerRow[] = [];
    for (const row of [...actives, ...gainers, ...smallGainers]) { if (!seen.has(row.symbol)) { seen.add(row.symbol); union.push(row); metaMap.set(row.symbol, { name: row.name, marketCap: row.marketCap }); } }
    poolSize = union.length + explicit.length;
    const stage1 = union.filter((r) => (r.volumeRatio != null && r.volumeRatio >= 1.8) || (r.changePct != null && Math.abs(r.changePct) >= 5)).map((r) => r.symbol);
    // Bias the shortlist toward smaller caps (the gem end): smallest market cap first.
    stage1.sort((a, b) => (metaMap.get(a)?.marketCap ?? Infinity) - (metaMap.get(b)?.marketCap ?? Infinity));

    // Curated universes: deliberate names that bypass the screener's Stage-1 (we WANT to scan them
    // every run, screener attention or not). Tag each with its universe; first universe wins on dupes.
    const universes = await loadUniverses();
    const universeTickers: string[] = [];
    for (const u of universes) {
      sources[`universe:${u.slug}`] = u.tickers.length;
      for (const t of u.tickers) {
        if (!metaMap.has(t)) metaMap.set(t, { name: null, marketCap: null, universe: u.slug });
        else if (!metaMap.get(t)!.universe) metaMap.get(t)!.universe = u.slug; // screener name that's also in a universe
        if (!universeTickers.includes(t) && !explicit.includes(t)) universeTickers.push(t);
      }
    }
    poolSize = union.length + universeTickers.filter((t) => !union.some((r) => r.symbol === t)).length + explicit.length;
    // Combined shortlist: explicit + screener gems (cap 22) + curated universe names (cap 18), deduped.
    const screenerPart = stage1.filter((t) => !explicit.includes(t)).slice(0, 22);
    const universePart = universeTickers.filter((t) => !screenerPart.includes(t)).slice(0, 18);
    shortlist = Array.from(new Set([...explicit, ...screenerPart, ...universePart]));
  }
  shortlist = shortlist.slice(0, 42); // cap the expensive Stage-2 enrichment
  if (!shortlist.length) return NextResponse.json({ candidates: [], poolSize, shortlistSize: 0, sources, generatedAt: new Date().toISOString() });

  // STAGE 2 (expensive, shortlist only): TA + news enrichment + categorization.
  const candidates = await Promise.all(shortlist.map((t) => enrichCandidate(t, metaMap.get(t))));
  // Sort by category, then smallest market cap first (favor the underfollowed).
  const order: Record<string, number> = { "Research Candidate": 0, Watch: 1, "Red Flag": 2, Ignore: 3 };
  // Sort: category tier first, then evidence score DESC (SEC-driven names surface before volume-only),
  // then smallest market cap (favor underfollowed names over well-covered ones).
  candidates.sort((a, b) =>
    (order[a.category] - order[b.category]) ||
    ((b.evidenceScore ?? 0) - (a.evidenceScore ?? 0)) ||
    ((a.marketCap ?? Infinity) - (b.marketCap ?? Infinity))
  );
  // Observability: which names were rejected for a peer-only catalyst, and which mega-caps got demoted.
  const rejectedPeerCatalysts = candidates.filter((c) => c._rejectedPeerCat && !c.riskFlag && c.category !== "Research Candidate").map((c) => ({ ticker: c.ticker, headline: c._rejectedPeerCat }));
  const downrankedLargeCaps = candidates.filter((c) => c._downrankedLargeCap).map((c) => ({ ticker: c.ticker, marketCapB: c.marketCap != null ? Math.round(c.marketCap / 1e9) : null }));
  const payload = { candidates, poolSize, shortlistSize: shortlist.length, sources, rejectedPeerCatalysts, downrankedLargeCaps, generatedAt: new Date().toISOString() };
  if (pureAuto) await writeRadarCache(payload); // refresh the shared daily scan for everyone
  return NextResponse.json(payload);
}
