import { createClient } from "@supabase/supabase-js";

// ── WIN-BACK (lifecycle segment) — re-engage users who signed up but never really used Plainview. Distinct
// from the daily brief: these users have no portfolio, so the email leads with VALUE + low-friction setup,
// not "your book". Owner-triggered (never an auto-loop), dry-run first, with a 30-day per-user dedup so a
// cold list is never re-blasted. Deterministic, fail-soft.
const APP = "https://plainviewintel.com";
const BUCKET = "plainview-state";
const WINBACK_KEY = "_usage/_winback.json";   // { [userId]: lastSentISO }
const ACTIVE_DAYS = 14;                        // active within this window = NOT dormant
const REBLAST_DAYS = 30;                       // never win-back the same user twice inside this window

function admin() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
}

type UsageRec = { lastActive?: string; total?: number; activeDays?: string[] };
export type DormantUser = { userId: string; email: string; name: string; lastActive: string | null; daysSince: number | null };

async function winbackLog(db: ReturnType<typeof admin>): Promise<Record<string, string>> {
  try { const { data } = await db.storage.from(BUCKET).download(WINBACK_KEY); if (data) { const j = JSON.parse(await data.text()); if (j && typeof j === "object") return j; } } catch { /* none yet */ }
  return {};
}

// The dormant segment: signed up, but not meaningfully active in the last ACTIVE_DAYS. Excludes test accounts
// and (unless includeContacted) anyone win-backed in the last REBLAST_DAYS.
export async function dormantUsers(includeContacted = false): Promise<{ dormant: DormantUser[]; totalUsers: number; active: number; contactedRecently: number }> {
  const db = admin();
  const contacted = await winbackLog(db);
  const now = Date.now();
  let totalUsers = 0, active = 0, contactedRecently = 0;
  const dormant: DormantUser[] = [];

  // All auth users (one page covers our scale).
  const { data } = await db.auth.admin.listUsers({ perPage: 1000, page: 1 });
  const users = data?.users || [];
  for (const u of users) {
    const email = u.email || "";
    if (!email || email.toLowerCase().endsWith("@plainview.test")) continue;
    totalUsers++;
    let rec: UsageRec | null = null;
    try { const { data: f } = await db.storage.from(BUCKET).download(`_usage/u/${u.id}.json`); if (f) rec = JSON.parse(await f.text()); } catch { /* no record = never used */ }
    const lastActive = rec?.lastActive || null;
    const daysSince = lastActive ? Math.floor((now - new Date(lastActive).getTime()) / 86400000) : null;
    const isActive = lastActive != null && daysSince != null && daysSince <= ACTIVE_DAYS && (rec?.total || 0) >= 3;
    if (isActive) { active++; continue; }
    const last = contacted[u.id];
    if (!includeContacted && last && (now - new Date(last).getTime()) / 86400000 < REBLAST_DAYS) { contactedRecently++; continue; }
    const md = (u.user_metadata || {}) as { full_name?: string; name?: string };
    const name = String(md.full_name || md.name || "").trim();
    dormant.push({ userId: u.id, email, name, lastActive, daysSince });
  }
  return { dormant, totalUsers, active, contactedRecently };
}

// Record that these users were just sent a win-back (so the 30-day dedup holds).
export async function markWinbackSent(userIds: string[]): Promise<void> {
  try {
    const db = admin();
    const log = await winbackLog(db);
    const nowIso = new Date().toISOString();
    for (const id of userIds) log[id] = nowIso;
    const blob = new Blob([JSON.stringify(log)], { type: "application/json" });
    await db.storage.from(BUCKET).upload(WINBACK_KEY, blob, { upsert: true, contentType: "application/json" });
  } catch { /* best-effort */ }
}

// The onboarding showcase — for people who signed up but never really explored. They have no portfolio yet,
// so this SHOWS the value: the free X-Ray aha up top, then a tight tour of the four core tools, then the
// morning-brief payoff. Breadth to earn a click — not a newsletter. Every link deep-links to that feature.
const FEATURES: Array<{ icon: string; name: string; benefit: string; path: string; content: string }> = [
  { icon: "🔍", name: "X-Ray", benefit: "Instant financial-health scan of any ticker — score, fundamentals, red flags. Free, no login.", path: "/x-ray", content: "xray" },
  { icon: "🧠", name: "Intel", benefit: "An AI read on what's actually moving a ticker right now — positioning, catalysts, social heat.", path: "/intel", content: "intel" },
  { icon: "📰", name: "News", benefit: "Every headline that matters on the tickers you follow, freshest first — no doomscroll.", path: "/news", content: "news" },
  { icon: "⚖️", name: "Decide", benefit: "Pressure-test a ticker before you buy: Business · Argument · Setup → a clear verdict.", path: "/decide", content: "decide" },
];

// Live X-Ray demo — flex a real feature with REAL data in the onboarding. Fetches a popular ticker's actual
// X-Ray (public, $0, deterministic) so a cold user SEES the product work, not just reads about it. Rotates
// daily. Fetched ONCE per batch by the route and passed into every email.
export type WinbackDemo = { ticker: string; score: number; sector: string | null; metrics: Array<{ label: string; value: string }> };
const POPULAR = ["NVDA", "AAPL", "TSLA", "MSFT", "AMD", "PLTR", "AMZN", "GOOGL", "META", "COIN", "HOOD", "SOFI"];
export async function fetchWinbackDemo(): Promise<WinbackDemo | null> {
  const tk = POPULAR[new Date().getUTCDate() % POPULAR.length];
  try {
    const r = await fetch(`${APP}/api/xray/${tk}?bg=1`, { cache: "no-store" }); // bg=1 → email prefetch, don't log as user "X-Ray" usage
    if (!r.ok) return null;
    const j = await r.json();
    if (j.scoreUnavailable || typeof j.score !== "number") return null;
    return { ticker: tk, score: j.score, sector: j.sector || null, metrics: Array.isArray(j.metrics) ? j.metrics.slice(0, 3) : [] };
  } catch { return null; }
}

export function buildWinback(email: string, name?: string, demo?: WinbackDemo | null): { subject: string; html: string; text: string } {
  const first = (name || "").split(/\s+/)[0] || "";
  const C = { bg: "#0a0b0d", card: "#111317", bd: "#20242b", green: "#1fdf64", t: "#e8eaed", t2: "#b4bac3", t3: "#7e8794" };
  const tag = (u: string, content: string) => `${u}${u.includes("?") ? "&" : "?"}utm_source=winback&utm_medium=email&utm_campaign=winback&utm_content=${content}`;
  const preheader = "X-Ray any ticker free, get an AI read, pressure-test a ticker — here's the 2-minute tour.";

  const featureRows = FEATURES.map((f) =>
    `<tr><td style="padding:14px 0;border-top:1px solid ${C.bd}"><a href="${tag(APP + f.path, f.content)}" style="text-decoration:none;color:inherit;display:block"><span style="font-size:15px">${f.icon}</span> <span style="font-weight:700;color:${C.green};font-size:15px">${f.name}</span> <span style="color:${C.t2};font-size:13.5px;line-height:1.5">— ${f.benefit}</span> <span style="color:${C.green};font-size:12px;white-space:nowrap">try it &rarr;</span></a></td></tr>`
  ).join("");

  // Live X-Ray demo card — real score/sector/metrics for today's popular ticker (flex the feature, not describe it).
  const scoreCol = demo ? (demo.score >= 7 ? C.green : demo.score >= 4 ? "#e0a500" : "#ff5c5c") : C.green;
  const demoCard = demo ? `<tr><td style="padding:18px 26px 0">
    <a href="${tag(APP + "/x-ray/" + encodeURIComponent(demo.ticker), "demo")}" style="text-decoration:none;color:inherit;display:block">
    <div style="border:1px solid ${C.bd};border-radius:12px;padding:14px 16px;background:#0d0f12">
      <div style="font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:${C.t3};font-weight:700">Live X-Ray · ${demo.ticker}</div>
      <div style="margin-top:6px"><span style="font-size:27px;font-weight:800;color:${scoreCol}">${demo.score}</span><span style="color:${C.t3};font-size:15px">/10</span>${demo.sector ? ` <span style="color:${C.t2};font-size:13px">· ${demo.sector}</span>` : ""}</div>
      ${demo.metrics.length ? `<div style="margin-top:9px">${demo.metrics.map((m) => `<span style="display:inline-block;font-size:12px;color:${C.t2};background:#15181d;border:1px solid ${C.bd};border-radius:6px;padding:4px 9px;margin:0 5px 5px 0">${m.label}: <b style="color:${C.t}">${m.value}</b></span>`).join("")}</div>` : ""}
      <div style="margin-top:6px;font-size:12px;color:${C.green}">That's a live scan — run one on any ticker you own &rarr;</div>
    </div></a>
  </td></tr>` : "";

  const html = `<style>@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;700;800&display=swap');</style><div style="background:${C.bg};margin:0;padding:0;width:100%">
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;opacity:0;color:transparent">${preheader}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.bg};border-collapse:collapse"><tr><td align="center" style="padding:24px 12px">
  <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:${C.card};border:1px solid ${C.bd};border-radius:16px;border-collapse:separate;font-family:'Inter',-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
    <tr><td style="padding:22px 26px 0">
      <span style="display:inline-block;width:26px;height:26px;background:${C.green};border-radius:7px;color:${C.bg};font-weight:800;font-size:15px;text-align:center;line-height:26px;font-family:Arial">P</span>
      <span style="font-weight:800;font-size:15px;color:${C.t};letter-spacing:.05em;vertical-align:6px;margin-left:9px">PLAINVIEW</span>
    </td></tr>
    <tr><td style="padding:20px 26px 0">
      <div style="font-size:21px;font-weight:700;color:${C.t};line-height:1.3">${first ? `${first}, here's` : "Here's"} what Plainview can do.</div>
      <div style="font-size:14px;color:${C.t2};margin-top:9px;line-height:1.6">You signed up but never took it for a spin — so here's the gist. Plainview is your private investing desk: it scans any ticker's health, reads what's actually moving the market, and watches your holdings — then emails you <b style="color:${C.t}">only when something changes your thesis</b>. Signal, not noise.</div>
      <div style="font-size:14px;color:${C.t2};margin-top:12px;line-height:1.6">Start free, no setup:</div>
    </td></tr>
    <tr><td style="padding:18px 26px 4px">
      <a href="${tag(APP + "/x-ray", "hero")}" style="display:inline-block;background:${C.green};color:${C.bg};text-decoration:none;font-weight:700;padding:13px 28px;border-radius:10px;font-size:15px">Scan any ticker &rarr;</a>
    </td></tr>
    ${demoCard}
    <tr><td style="padding:22px 26px 0">
      <div style="font-size:12px;text-transform:uppercase;letter-spacing:.09em;color:${C.t3};font-weight:700;margin-bottom:2px">Everything inside</div>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">${featureRows}</table>
    </td></tr>
    <tr><td style="padding:22px 26px 0">
      <div style="font-size:14px;color:${C.t2};line-height:1.6">Then add your holdings — and every morning you'll get a brief that <b style="color:${C.t}">only speaks when something changes your thesis</b>. Most days it just says: hold the line.</div>
    </td></tr>
    <tr><td style="padding:18px 26px 4px">
      <a href="${tag(APP + "/", "setup")}" style="display:inline-block;background:${C.green};color:${C.bg};text-decoration:none;font-weight:700;padding:13px 28px;border-radius:10px;font-size:15px">Add your first ticker &rarr;</a>
    </td></tr>
    <tr><td style="padding:18px 26px 24px">
      <div style="border-top:1px solid ${C.bd};padding-top:14px;font-size:11px;color:${C.t3};line-height:1.6">You're getting this because you created a Plainview account. Not for you? <a href="%%UNSUB%%" style="color:${C.t3};text-decoration:underline">Unsubscribe</a>.</div>
    </td></tr>
  </table>
</td></tr></table></div>`;

  const text = `PLAINVIEW\n\n${first ? `${first}, here's` : "Here's"} what Plainview can do.\nYou signed up but never took it for a spin — so here's the gist. Plainview is your private investing desk: it scans any ticker's health, reads what's actually moving the market, and watches your holdings — then emails you only when something changes your thesis. Signal, not noise.\n\nStart free, no setup:\n\nScan any ticker (free): ${tag(APP + "/x-ray", "hero")}\n${demo ? `\nLive X-Ray right now — ${demo.ticker}: ${demo.score}/10${demo.sector ? ` · ${demo.sector}` : ""}. Run one on any ticker: ${tag(APP + "/x-ray/" + demo.ticker, "demo")}\n` : ""}\nEverything inside:\n${FEATURES.map((f) => `  • ${f.name} — ${f.benefit}\n    ${tag(APP + f.path, f.content)}`).join("\n")}\n\nThen add your holdings and every morning you'll get a brief that only speaks when something changes your thesis. Most days it just says: hold the line.\n\nAdd your first ticker: ${tag(APP + "/", "setup")}\n\nYou're getting this because you created a Plainview account.\nUnsubscribe: %%UNSUB%%`;

  const subject = `${first ? `${first}, ` : ""}here's what Plainview can do`;
  return { subject, html, text };
}
