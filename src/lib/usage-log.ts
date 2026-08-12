import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { countCached } from "@/lib/ai-cache";
import { getSpendThisMonth } from "@/lib/ai-spend";

// Rough cost per call, by feature. EVERY AI route runs free providers first (Cerebras→Groq→Gemini)
// and only falls back to paid Claude if all three fail — so effective Anthropic cost ≈ a small
// fallback probability × Haiku price, i.e. near-zero. xray/market lists call no LLM at all → $0.
// (This is an estimate; for true spend we'd log which provider actually answered each call.)
const FALLBACK_HAIKU = 0.0003; // ~Haiku per-call × small chance all free tiers were down
const FEATURE_COST: Record<string, number> = {
  xray: 0, intel: FALLBACK_HAIKU, decide: FALLBACK_HAIKU, opportunity: FALLBACK_HAIKU,
  portfolio: FALLBACK_HAIKU, sec: FALLBACK_HAIKU, analyze: FALLBACK_HAIKU,
};

// Founder Analytics v1 — answer "is anyone coming back, and what do they actually use?"
// Design mirrors ai-quota.ts: zero-DDL, counters live in Supabase Storage. One small JSON file per
// user holds their cumulative record; anon (logged-out) actions roll into a single shared file. The
// admin endpoint lists + aggregates these. Fully fail-open: tracking must NEVER break a real request.
const BUCKET = "plainview-state";
const PREFIX = "_usage";              // _usage/u/<userId>.json  +  _usage/_anon.json
const KNOWN_FEATURES = ["xray", "intel", "decide", "opportunity", "portfolio", "sec", "analyze"] as const;
export type Feature = (typeof KNOWN_FEATURES)[number];

function env(n: string): string { const v = process.env[n]; if (!v) throw new Error(`Missing ${n}`); return v; }
function admin() {
  return createClient(env("NEXT_PUBLIC_SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
}

type UserRecord = {
  userId?: string;
  email?: string;
  firstSeen: string;     // ISO — for "returned after dayN" cohorts
  lastActive: string;    // ISO — for active today/week/month
  activeDays: string[];  // distinct YYYY-MM-DD the user did something (capped, recent)
  total: number;         // total tracked actions
  features: Record<string, number>;
};

async function currentUser(): Promise<{ id: string | null; email: string | null }> {
  try {
    const cookieStore = await cookies();
    const supabase = createServerClient(env("NEXT_PUBLIC_SUPABASE_URL"), env("NEXT_PUBLIC_SUPABASE_ANON_KEY"), {
      cookies: { getAll() { return cookieStore.getAll(); }, setAll() { /* read-only */ } },
    });
    const { data: { user } } = await supabase.auth.getUser();
    return { id: user?.id || null, email: user?.email || null };
  } catch { return { id: null, email: null }; }
}

function blankRecord(now: string): UserRecord {
  return { firstSeen: now, lastActive: now, activeDays: [], total: 0, features: {} };
}

const RECENT_KEY = `${PREFIX}/_recent.json`;
const RECENT_MAX = 60;

// Append one event to the shared rolling feed (best-effort; small race window is acceptable here).
async function pushRecent(db: ReturnType<typeof admin>, ev: { f: string; d: string; who: string; ts: number }): Promise<void> {
  try {
    let arr: Array<{ f: string; d: string; who: string; ts: number }> = [];
    try {
      const { data } = await db.storage.from(BUCKET).download(RECENT_KEY);
      if (data) { const j = JSON.parse(await data.text()); if (Array.isArray(j)) arr = j; }
    } catch { /* none yet */ }
    arr.unshift(ev);
    if (arr.length > RECENT_MAX) arr = arr.slice(0, RECENT_MAX);
    const blob = new Blob([JSON.stringify(arr)], { type: "application/json" });
    await db.storage.from(BUCKET).upload(RECENT_KEY, blob, { upsert: true, contentType: "application/json" });
  } catch { /* fail open */ }
}

/**
 * Record one product action for the current user (or the shared anon bucket if logged out).
 * Fire-and-forget friendly — always resolves, never throws, never blocks the caller's result.
 * @param detail optional context for the activity feed (e.g. the ticker scanned).
 */
export async function logUsage(feature: Feature | string, detail?: string): Promise<void> {
  try {
    const { id, email } = await currentUser();
    const key = id ? `${PREFIX}/u/${id}.json` : `${PREFIX}/_anon.json`;
    const db = admin();
    const now = new Date().toISOString();
    const day = now.slice(0, 10);
    // Activity feed — who did what, just now. Email for signed-in, "anonymous" otherwise.
    void pushRecent(db, { f: feature, d: (detail || "").slice(0, 16), who: email || "anonymous", ts: Date.now() });

    let rec: UserRecord = blankRecord(now);
    try {
      const { data } = await db.storage.from(BUCKET).download(key);
      if (data) rec = { ...rec, ...(JSON.parse(await data.text()) as UserRecord) };
    } catch { /* first action → blank record */ }

    rec.userId = id || rec.userId;
    if (email) rec.email = email;
    rec.lastActive = now;
    if (!rec.firstSeen) rec.firstSeen = now;
    rec.total = (rec.total || 0) + 1;
    rec.features = rec.features || {};
    rec.features[feature] = (rec.features[feature] || 0) + 1;
    rec.activeDays = Array.isArray(rec.activeDays) ? rec.activeDays : [];
    if (!rec.activeDays.includes(day)) rec.activeDays.push(day);
    if (rec.activeDays.length > 120) rec.activeDays = rec.activeDays.slice(-120); // keep recent ~4mo

    const blob = new Blob([JSON.stringify(rec)], { type: "application/json" });
    await db.storage.from(BUCKET).upload(key, blob, { upsert: true, contentType: "application/json" });
  } catch { /* analytics is best-effort — swallow everything */ }
}

/**
 * Record a "the app was opened" visit for the current logged-in user — bumps lastActive / firstSeen /
 * activeDays (the retention signals) WITHOUT touching feature counts or the activity feed. So a user
 * who just browses (watchlist/portfolio) still counts as ACTIVE, even without running a feature.
 * This is what makes "active today / returning %" honest. Logged-in only; fail-open.
 */
export async function logVisit(): Promise<void> {
  try {
    const { id, email } = await currentUser();
    if (!id) return;
    const key = `${PREFIX}/u/${id}.json`;
    const db = admin();
    const now = new Date().toISOString();
    const day = now.slice(0, 10);
    let rec: UserRecord = blankRecord(now);
    try {
      const { data } = await db.storage.from(BUCKET).download(key);
      if (data) rec = { ...rec, ...(JSON.parse(await data.text()) as UserRecord) };
    } catch { /* first visit → blank */ }
    rec.userId = id;
    if (email) rec.email = email;
    rec.lastActive = now;
    if (!rec.firstSeen) rec.firstSeen = now;
    rec.activeDays = Array.isArray(rec.activeDays) ? rec.activeDays : [];
    if (!rec.activeDays.includes(day)) rec.activeDays.push(day);
    if (rec.activeDays.length > 120) rec.activeDays = rec.activeDays.slice(-120);
    rec.features = rec.features || {};
    const blob = new Blob([JSON.stringify(rec)], { type: "application/json" });
    await db.storage.from(BUCKET).upload(key, blob, { upsert: true, contentType: "application/json" });
  } catch { /* best-effort */ }
}

// ---- Error monitoring — so a silent break (e.g. a crashing onboarding modal) surfaces in Admin -------
// A small rolling feed of client/server errors, same Storage pattern as the activity feed. Fail-open.
const ERRORS_KEY = `${PREFIX}/_errors.json`;
const ERRORS_MAX = 80;
export type ErrorEvent = { msg: string; src: string; url: string; who: string; ts: number };
export async function logError(ev: { msg: string; src?: string; url?: string; who?: string }): Promise<void> {
  try {
    if (!ev?.msg) return;
    const db = admin();
    let who = ev.who || "";
    if (!who) { try { who = (await currentUser()).email || "anonymous"; } catch { who = "anonymous"; } }
    let arr: ErrorEvent[] = [];
    try { const { data } = await db.storage.from(BUCKET).download(ERRORS_KEY); if (data) { const j = JSON.parse(await data.text()); if (Array.isArray(j)) arr = j; } } catch { /* none yet */ }
    arr.unshift({ msg: String(ev.msg).slice(0, 300), src: String(ev.src || "").slice(0, 200), url: String(ev.url || "").slice(0, 200), who, ts: Date.now() });
    if (arr.length > ERRORS_MAX) arr = arr.slice(0, ERRORS_MAX);
    const blob = new Blob([JSON.stringify(arr)], { type: "application/json" });
    await db.storage.from(BUCKET).upload(ERRORS_KEY, blob, { upsert: true, contentType: "application/json" });
  } catch { /* monitoring must never throw */ }
}

// ---- Email funnel — does the brief actually drive people back INTO Plainview? ----------------------
// The advisor's KPI is the habit, not the open: sent → opened → clicked → logged in. We capture what we
// control (sent from the cron; clicked/logged-in from a beacon on the UTM-tagged landing) and, optionally,
// opens/clicks via a Resend webhook. One small rolling JSON, last ~60 days. Same fail-open Storage pattern;
// a tiny read-modify-write race is acceptable for counters at this scale.
const EMAIL_KEY = `${PREFIX}/_email.json`;
export type EmailStage = "sent" | "opened" | "clicked" | "loggedin";
type EmailStore = { days: Record<string, Record<string, Record<string, number>>>; sections: Record<string, number> };
export async function logEmailEvent(stage: EmailStage, opts?: { slot?: string; section?: string; n?: number }): Promise<void> {
  try {
    const db = admin();
    const slot = opts?.slot === "pm" ? "pm" : opts?.slot === "am" ? "am" : "other";
    const n = opts?.n && opts.n > 0 ? Math.floor(opts.n) : 1;
    const day = new Date().toISOString().slice(0, 10);
    let store: EmailStore = { days: {}, sections: {} };
    try { const { data } = await db.storage.from(BUCKET).download(EMAIL_KEY); if (data) { const j = JSON.parse(await data.text()); if (j && j.days) store = { days: j.days || {}, sections: j.sections || {} }; } } catch { /* none yet */ }
    store.days[day] = store.days[day] || {};
    store.days[day][slot] = store.days[day][slot] || {};
    store.days[day][slot][stage] = (store.days[day][slot][stage] || 0) + n;
    if (opts?.section) store.sections[opts.section] = (store.sections[opts.section] || 0) + n;
    const ds = Object.keys(store.days).sort();
    if (ds.length > 60) for (const d of ds.slice(0, ds.length - 60)) delete store.days[d];
    const blob = new Blob([JSON.stringify(store)], { type: "application/json" });
    await db.storage.from(BUCKET).upload(EMAIL_KEY, blob, { upsert: true, contentType: "application/json" });
  } catch { /* analytics is best-effort */ }
}

// ---- Admin read side (used by /api/admin/analytics) -----------------------------------------

const ADMIN_EMAILS = new Set(["dar_fishman@hotmail.com"]); // founder-only

// Synthetic accounts used by backend tests / verification — kept in auth, but EXCLUDED from analytics
// so the dashboard reflects real humans (e.g. verify_*@plainview.test, v<digits>@plainview.test).
function isTestAccount(email?: string | null): boolean {
  if (!email) return false;
  return email.toLowerCase().endsWith("@plainview.test");
}

export async function isAdmin(): Promise<boolean> {
  const { email } = await currentUser();
  return !!email && ADMIN_EMAILS.has(email.toLowerCase());
}

export type AnalyticsSummary = {
  totalUsers: number;
  activeToday: number;
  activeThisWeek: number;
  activeThisMonth: number;
  returnedAfterDay1: number;   // users whose active span crossed >=1 day
  returnedAfterDay7: number;   // ...crossed >=7 days
  returningPct: number;        // share of users active on >1 distinct day
  featureTotals: Record<string, number>;
  anonFeatureTotals: Record<string, number>;
  topUsers: Array<{ email: string; total: number; lastActive: string; features: Record<string, number> }>;
  totalAiCalls: number;        // all-time LLM calls across everyone
  estSpendAllTime: number;     // USD, rough
  secCached: number;           // filings summarized once + reused
  secCallsSaved: number;       // sec clicks beyond the first per filing (cost avoided)
  smartSpendMonth: { month: string; costUsd: number; calls: number }; // ACTUAL Sonnet/Opus verdict spend MTD
  recent: Array<{ f: string; d: string; who: string; ts: number }>; // live activity feed
  recentErrors: ErrorEvent[];  // rolling client/server error feed (catch silent breaks)
  emailFunnel: EmailFunnel;    // brief sent → opened → clicked → logged in (the retention funnel)
  asOf: number;
};

export type EmailStageTotals = { sent: number; opened: number; clicked: number; loggedin: number };
export type EmailFunnel = {
  total: EmailStageTotals;                 // last 30 days, all slots
  am: EmailStageTotals; pm: EmailStageTotals;
  sections: Record<string, number>;        // which link section got the clicks
  days: Array<{ day: string } & EmailStageTotals>; // last 14 days for a trend
};

function daysBetween(a: string, b: string): number {
  return Math.floor((new Date(b).getTime() - new Date(a).getTime()) / 86400000);
}

export async function buildAnalytics(): Promise<AnalyticsSummary> {
  const db = admin();
  const now = Date.now();
  const out: AnalyticsSummary = {
    totalUsers: 0, activeToday: 0, activeThisWeek: 0, activeThisMonth: 0,
    returnedAfterDay1: 0, returnedAfterDay7: 0, returningPct: 0,
    featureTotals: {}, anonFeatureTotals: {}, topUsers: [],
    totalAiCalls: 0, estSpendAllTime: 0, secCached: 0, secCallsSaved: 0,
    smartSpendMonth: { month: new Date().toISOString().slice(0, 7), costUsd: 0, calls: 0 }, recent: [], recentErrors: [],
    emailFunnel: { total: { sent: 0, opened: 0, clicked: 0, loggedin: 0 }, am: { sent: 0, opened: 0, clicked: 0, loggedin: 0 }, pm: { sent: 0, opened: 0, clicked: 0, loggedin: 0 }, sections: {}, days: [] },
    asOf: now,
  };
  // Email funnel — aggregate the rolling per-day/per-slot counters.
  try {
    const { data } = await db.storage.from(BUCKET).download(`${PREFIX}/_email.json`);
    if (data) {
      const store = JSON.parse(await data.text()) as EmailStore;
      const add = (t: EmailStageTotals, s?: Record<string, number>) => { if (!s) return; t.sent += s.sent || 0; t.opened += s.opened || 0; t.clicked += s.clicked || 0; t.loggedin += s.loggedin || 0; };
      const cutoff = new Date(now - 30 * 86400000).toISOString().slice(0, 10);
      const days = Object.keys(store.days || {}).sort();
      for (const d of days) {
        if (d < cutoff) continue;
        const slots = store.days[d];
        add(out.emailFunnel.total, slots.am); add(out.emailFunnel.total, slots.pm); add(out.emailFunnel.total, slots.other);
        add(out.emailFunnel.am, slots.am); add(out.emailFunnel.pm, slots.pm);
      }
      out.emailFunnel.sections = store.sections || {};
      out.emailFunnel.days = days.slice(-14).map((d) => {
        const t: EmailStageTotals = { sent: 0, opened: 0, clicked: 0, loggedin: 0 };
        add(t, store.days[d].am); add(t, store.days[d].pm); add(t, store.days[d].other);
        return { day: d, ...t };
      });
    }
  } catch { /* none yet */ }
  // Error feed
  try {
    const { data } = await db.storage.from(BUCKET).download(`${PREFIX}/_errors.json`);
    if (data) { const j = JSON.parse(await data.text()); if (Array.isArray(j)) out.recentErrors = j.slice(0, 40); }
  } catch { /* none yet */ }
  try { const s = await getSpendThisMonth(); out.smartSpendMonth = { month: s.month, costUsd: s.costUsd, calls: s.calls }; } catch { /* fail-soft */ }

  // Live activity feed
  try {
    const { data } = await db.storage.from(BUCKET).download(`${PREFIX}/_recent.json`);
    if (data) { const j = JSON.parse(await data.text()); if (Array.isArray(j)) out.recent = j.slice(0, 40); }
  } catch { /* none yet */ }

  // Anon bucket
  try {
    const { data } = await db.storage.from(BUCKET).download(`${PREFIX}/_anon.json`);
    if (data) { const r = JSON.parse(await data.text()) as UserRecord; out.anonFeatureTotals = r.features || {}; }
  } catch { /* none yet */ }

  // Per-user records
  const { data: files } = await db.storage.from(BUCKET).list(`${PREFIX}/u`, { limit: 10000 });
  const list = (files || []).filter((f) => f.name.endsWith(".json"));
  const records = await Promise.all(list.map(async (f) => {
    try {
      const { data } = await db.storage.from(BUCKET).download(`${PREFIX}/u/${f.name}`);
      return data ? (JSON.parse(await data.text()) as UserRecord) : null;
    } catch { return null; }
  }));

  const users: Array<{ email: string; total: number; lastActive: string; features: Record<string, number> }> = [];
  for (const r of records) {
    if (!r) continue;
    if (isTestAccount(r.email)) continue; // backend test/verify accounts — never count as real users
    out.totalUsers++;
    const ageToday = daysBetween(r.lastActive, new Date(now).toISOString());
    if (ageToday <= 0) out.activeToday++;
    if (ageToday <= 7) out.activeThisWeek++;
    if (ageToday <= 30) out.activeThisMonth++;
    const span = daysBetween(r.firstSeen, r.lastActive);
    const distinctDays = Array.isArray(r.activeDays) ? r.activeDays.length : 1;
    if (span >= 1) out.returnedAfterDay1++;
    if (span >= 7) out.returnedAfterDay7++;
    if (distinctDays > 1) out.returningPct++;
    for (const [k, v] of Object.entries(r.features || {})) out.featureTotals[k] = (out.featureTotals[k] || 0) + (v || 0);
    users.push({ email: r.email || "(anon-account)", total: r.total || 0, lastActive: r.lastActive, features: r.features || {} });
  }
  out.returningPct = out.totalUsers ? Math.round((out.returningPct / out.totalUsers) * 100) : 0;
  out.topUsers = users.sort((a, b) => b.total - a.total).slice(0, 15);

  // Estimated AI spend — sum every feature's count × its per-call cost (xray etc. = $0).
  const allFeat: Record<string, number> = { ...out.featureTotals };
  for (const [k, v] of Object.entries(out.anonFeatureTotals)) allFeat[k] = (allFeat[k] || 0) + (v || 0);
  for (const [k, v] of Object.entries(allFeat)) {
    if (FEATURE_COST[k] === undefined || FEATURE_COST[k] > 0) out.totalAiCalls += v; // count LLM calls only
    out.estSpendAllTime += (FEATURE_COST[k] ?? 0.006) * v;
  }
  out.estSpendAllTime = Math.round(out.estSpendAllTime * 100) / 100;

  // SEC cache savings — every cached filing is one stored summary; clicks beyond the first were free.
  out.secCached = await countCached("sec-explain");
  const secClicks = allFeat["sec"] || 0;
  out.secCallsSaved = Math.max(0, secClicks - out.secCached);
  return out;
}
