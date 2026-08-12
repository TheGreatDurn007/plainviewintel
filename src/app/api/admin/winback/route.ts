import { NextResponse } from "next/server";
import { isAdmin } from "@/lib/usage-log";
import { sendEmail } from "@/lib/daily-brief";
import { dormantUsers, buildWinback, markWinbackSent, fetchWinbackDemo } from "@/lib/winback";

// WIN-BACK control (owner-only). Three modes:
//   GET                  → DRY RUN: who's in the dormant segment + a sample (sends nothing).
//   GET ?to=a@b.com      → test the email to one address.
//   GET ?send=1          → actually send to the dormant segment (throttled, deduped, fail-soft).
// Default is dry-run on purpose — the blast only goes out when the owner explicitly asks for it.
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(req: Request) {
  if (!(await isAdmin())) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const qs = new URL(req.url).searchParams;

  // Test send to a single address.
  const demo = await fetchWinbackDemo();   // one live X-Ray, reused for every email this run

  const to = qs.get("to");
  if (to && /\S+@\S+\.\S+/.test(to)) {
    const wb = buildWinback(to, undefined, demo);
    const r = await sendEmail(to, `[TEST] ${wb.subject}`, wb.html, undefined, wb.text);
    return NextResponse.json({ mode: "test", to, ok: r.ok, detail: r.detail, demo: demo ? `${demo.ticker} ${demo.score}/10` : "none" });
  }

  const { dormant, totalUsers, active, contactedRecently } = await dormantUsers();

  // Dry run — show the segment, send nothing.
  if (qs.get("send") !== "1") {
    return NextResponse.json({
      mode: "dry-run",
      totalUsers, active, dormant: dormant.length, contactedRecentlySkipped: contactedRecently,
      sample: dormant.slice(0, 20).map((d) => ({ email: d.email, lastActive: d.lastActive, daysSince: d.daysSince })),
      note: "Add ?send=1 to actually send. Each user is deduped for 30 days.",
    });
  }

  // Real send — throttled under Resend's 5/sec, fail-soft, mark each success for the 30-day dedup.
  let sent = 0, failed = 0; const errors: string[] = []; const sentIds: string[] = [];
  let i = 0;
  for (const u of dormant) {
    try {
      if (i++ > 0) await new Promise((res) => setTimeout(res, 220));
      const wb = buildWinback(u.email, u.name, demo);
      const r = await sendEmail(u.email, wb.subject, wb.html, undefined, wb.text);
      if (r.ok) { sent++; sentIds.push(u.userId); } else { failed++; if (errors.length < 5) errors.push(`${u.email}: ${r.detail}`); }
    } catch { failed++; }
  }
  if (sentIds.length) await markWinbackSent(sentIds);
  return NextResponse.json({ mode: "send", segment: dormant.length, sent, failed, errors, ts: new Date().toISOString() });
}
