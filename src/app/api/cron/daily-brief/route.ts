import { NextResponse } from "next/server";
import { buildBrief, sendEmail, usersWithBriefs, sweepUserTheses, beginSweepBudget, endSweepBudget, fetchMarketContext } from "@/lib/daily-brief";
import { buildLedger } from "@/lib/weekly-ledger";
import { buildEditorial, buildPersonalInsert } from "@/lib/daily-editorial";
import { dormantUsers, buildWinback, markWinbackSent, fetchWinbackDemo } from "@/lib/winback";
import { isAdmin, logEmailEvent } from "@/lib/usage-log";

// All-users conviction brief — the retention engine. Two sends a day via two cron entries on this same route:
//   ?slot=am  (pre-open, ~9:00 ET) → "what to watch today"
//   ?slot=pm  (post-close, ~4:30 ET) → "what changed today"
// For each user it (1) SWEEPS their book server-side — re-scoring every holding so the brief reads FRESH
// conviction even if they haven't opened the app — then (2) builds + emails the slot-framed brief. The AM run
// also fires the accuracy harness afterward (folded in so we stay at TWO cron jobs total → 2×/day is safe even
// on a Hobby downgrade, where 3 crons would fail the deploy). Authorized by CRON_SECRET bearer OR an admin
// session. Fail-soft per user. Self-gates here (public in middleware for the cron's no-session hit).
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// The sweep is the slow part (each holding = a fresh thesis-check). Its time budget is set by the ADAPTIVE
// guard (beginSweepBudget/endSweepBudget in the lib): it uses Pro's full window and auto-falls to a safe
// floor if it ever detects a Hobby 60s kill — so the (fast) sends are NEVER starved and nothing breaks on a
// tier downgrade, with no env to remember. Users are swept stalest-first, so even a tight budget helps the
// neediest. (Set env SWEEP_BUDGET_MS to pin a fixed budget and bypass the guard.)

async function authorized(req: Request): Promise<boolean> {
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.get("authorization") || "";
  if (secret && auth === `Bearer ${secret}`) return true; // Vercel cron
  return await isAdmin().catch(() => false);              // manual admin trigger
}

export async function GET(req: Request) {
  if (!(await authorized(req))) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const url = new URL(req.url);
  const slotParam = url.searchParams.get("slot");
  const isLedger = slotParam === "ledger";
  const slot: "am" | "pm" | undefined = slotParam === "pm" ? "pm" : slotParam === "am" ? "am" : undefined;

  const started = Date.now();

  // ── TEST GATE ──
  const LIVE_TO_ALL = false;
  const TEST_ONLY = ["dar_fishman@hotmail.com", "coreygolden30@gmail.com"];
  const envOnly = (process.env.BRIEF_ONLY || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const allow = envOnly.length ? envOnly : (LIVE_TO_ALL ? [] : TEST_ONLY);

  const market = await fetchMarketContext();

  // ── THE BRIEF (editorial) — generate once, stamp into every envelope ──
  if (slotParam === "editorial") {
    if (!market) return NextResponse.json({ ok: false, error: "No market data" });
    let users = await usersWithBriefs(500);
    if (allow.length) users = users.filter((u) => allow.includes(u.email.toLowerCase()));
    // Build the shared editorial ONCE (one AI call, $0)
    const baseEmail = await buildEditorial(market);
    if (!baseEmail) return NextResponse.json({ ok: false, error: "Editorial generation failed" });
    // Build day-move map for personal inserts — buildPersonalInsert reads user state internally,
    // it just needs to know each ticker's day change. Movers API gives us the top 25; we'll also
    // fetch prices for any user position tickers inside buildPersonalInsert itself.
    const dayMoves: Record<string, number> = {};
    try {
      const moversRes = await fetch(`${url.origin}/api/movers`, { headers: process.env.CRON_SECRET ? { authorization: `Bearer ${process.env.CRON_SECRET}` } : {} });
      if (moversRes.ok) { const mj = await moversRes.json(); for (const m of mj.movers || []) { if (typeof m.changePercent === "number") dayMoves[String(m.symbol).toUpperCase()] = m.changePercent; } }
    } catch { /* fail-soft */ }
    let sent = 0, failed = 0;
    let i = 0;
    for (const u of users) {
      try {
        // Active users get a personal insert spliced into the base HTML
        let insert = "";
        try { insert = await buildPersonalInsert(u.userId, dayMoves); } catch { /* no insert */ }
        // Splice personal insert into the editorial HTML at the %%PERSONAL%% marker
        const html = baseEmail.html.replace("%%PERSONAL%%", insert);
        const text = insert ? baseEmail.text.replace("%%PERSONAL%%", `\nYOUR NAMES TODAY\n(see full details in Plainview)\n`) : baseEmail.text.replace("%%PERSONAL%%", "");
        if (i++ > 0) await new Promise((res) => setTimeout(res, 220));
        const r = await sendEmail(u.email, baseEmail.subject, html, undefined, text);
        if (r.ok) sent++; else failed++;
      } catch { failed++; }
    }
    if (sent > 0) await logEmailEvent("sent", { slot: "editorial", n: sent });
    return NextResponse.json({ ok: true, slot: "editorial", users: users.length, sent, failed, ms: Date.now() - started });
  }

  let users = await usersWithBriefs(500);
  if (allow.length) users = users.filter((u) => allow.includes(u.email.toLowerCase()));
  const { budgetMs, effectiveCap, mode } = await beginSweepBudget(users.length);
  let sent = 0, skipped = 0, failed = 0, swept = 0, scored = 0;
  const errors: string[] = [];
  let i = 0;
  for (const u of users) {
    try {
      // Refresh this user's conviction first — but only while we're inside the sweep budget, so the sends
      // (cheap) are never starved by the sweep (slow). Stalest users come first, so a tight budget still
      // helps the ones who most need it; the rest still get a brief from their latest ledger.
      if (Date.now() - started < budgetMs) {
        try { const s = await sweepUserTheses(u.userId, 2, slot === "pm"); if (s.holdings) { swept++; scored += s.scored; } } catch { /* fail-soft */ }
      }
      // Sunday evening = The Ledger (weekly intelligence report) instead of the daily PM brief.
      const email = isLedger
        ? await buildLedger(u.userId, market)
        : await buildBrief(u.userId, market, slot, { markSeen: true });
      if (!email) { skipped++; continue; }
      if (i++ > 0) await new Promise((res) => setTimeout(res, 220));
      const r = await sendEmail(u.email, email.subject, email.html, undefined, email.text);
      if (r.ok) sent++; else { failed++; if (errors.length < 5) errors.push(`${u.email}: ${r.detail}`); }
    } catch { failed++; }
  }
  // Mark the run completed (it wasn't killed) so the guard learns this window was survivable. If the
  // platform killed us mid-sweep, this never runs → next run detects the overrun and falls to the safe floor.
  const ms = Date.now() - started;
  await endSweepBudget(effectiveCap, ms);
  if (sent > 0) await logEmailEvent("sent", { slot: isLedger ? "ledger" : (slot ?? "other"), n: sent });

  // Accuracy harness — folded into the AM run (keeps us at 2 cron jobs). Fire-and-await, fail-soft; never
  // let an accuracy hiccup affect the brief result.
  let accuracy: string | null = null;
  if (slot !== "pm") {
    const secret = process.env.CRON_SECRET;
    try {
      const r = await fetch(`${url.origin}/api/admin/accuracy`, { headers: secret ? { authorization: `Bearer ${secret}` } : {} });
      accuracy = `${r.status}`;
    } catch { accuracy = "error"; }
  }

  // Win-back blast — fires alongside the Sunday Ledger so dormant users get the onboarding email at the same
  // time active users get their weekly intelligence report. Same 30-day dedup as the manual route. Fail-soft.
  let winback: { segment: number; sent: number; failed: number } | null = null;
  if (isLedger) {
    try {
      const { dormant } = await dormantUsers();
      const demo = await fetchWinbackDemo();
      let wbSent = 0, wbFailed = 0; const wbSentIds: string[] = [];
      let wi = 0;
      for (const u of dormant) {
        try {
          if (wi++ > 0) await new Promise((res) => setTimeout(res, 220));
          const wb = buildWinback(u.email, u.name, demo);
          const r = await sendEmail(u.email, wb.subject, wb.html, undefined, wb.text);
          if (r.ok) { wbSent++; wbSentIds.push(u.userId); } else { wbFailed++; }
        } catch { wbFailed++; }
      }
      if (wbSentIds.length) await markWinbackSent(wbSentIds);
      winback = { segment: dormant.length, sent: wbSent, failed: wbFailed };
      if (wbSent > 0) await logEmailEvent("sent", { slot: "winback", n: wbSent });
    } catch { /* fail-soft */ }
  }

  return NextResponse.json({ ok: true, slot: slot ?? "default", users: users.length, swept, scored, sent, skipped, failed, errors, budgetMs, mode, accuracy, winback, ms: Date.now() - started, ts: new Date().toISOString() });
}
