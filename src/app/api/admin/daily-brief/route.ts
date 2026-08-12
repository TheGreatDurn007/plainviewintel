import { NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { isAdmin } from "@/lib/usage-log";
import { buildBrief, sendEmail, sweepUserTheses, fetchMarketContext } from "@/lib/daily-brief";

// ── DAILY NEXUS BRIEF EMAIL — OWNER TEST. GET (logged-in admin) → sends YOUR brief to YOUR email, to confirm
// the Resend pipeline end-to-end. The all-users cron lives at /api/cron/daily-brief; both share the builder
// in src/lib/daily-brief.ts so the email can never drift between them.
export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function currentUser(): Promise<{ id: string | null; email: string | null }> {
  try {
    const cookieStore = await cookies();
    const supa = createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
      cookies: { getAll() { return cookieStore.getAll(); }, setAll() {} },
    });
    const { data: { user } } = await supa.auth.getUser();
    return { id: user?.id ?? null, email: user?.email ?? null };
  } catch { return { id: null, email: null }; }
}

// Owner test: send the logged-in admin their own brief. (404 to everyone else.)
// Optional ?to=a@b.com,c@d.com → send YOUR brief to specific addresses (for showing someone the format).
export async function GET(req: Request) {
  if (!(await isAdmin())) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const { id, email } = await currentUser();
  if (!id || !email) return NextResponse.json({ error: "No session user" }, { status: 400 });
  // ?sweep=1 → re-score YOUR holdings first (the morning sweep), so this test reflects a fresh ledger end-to-end.
  let sweep: { holdings: number; scored: number } | null = null;
  const qs = new URL(req.url).searchParams;
  if (qs.get("sweep") === "1") { sweep = await sweepUserTheses(id).catch(() => null); }
  const slotParam = qs.get("slot");
  const slot: "am" | "pm" | undefined = slotParam === "pm" ? "pm" : slotParam === "am" ? "am" : undefined;
  const market = await fetchMarketContext();
  const brief = await buildBrief(id, market, slot);
  if (!brief) return NextResponse.json({ ok: false, reason: "No thesis data yet — run a thesis check on a holding first, then retry." });

  const toParam = new URL(req.url).searchParams.get("to");
  if (toParam) {
    const recipients = toParam.split(",").map((s) => s.trim()).filter((s) => /\S+@\S+\.\S+/.test(s)).slice(0, 10);
    const results: Array<{ to: string; ok: boolean; detail: string }> = [];
    let i = 0;
    for (const to of recipients) {
      if (i++ > 0) await new Promise((res) => setTimeout(res, 220)); // stay under Resend's 5/sec
      const r = await sendEmail(to, `[TEST] ${brief.subject}`, brief.html, undefined, brief.text);
      results.push({ to, ok: r.ok, detail: r.detail });
    }
    return NextResponse.json({ ok: results.every((r) => r.ok), mode: "test-to", subject: brief.subject, results });
  }

  let sent = await sendEmail(email, `[TEST] ${brief.subject}`, brief.html, undefined, brief.text);
  let via = "domain";
  // If the custom domain isn't verified yet, fall back to Resend's onboarding sender so the test can still
  // land (delivers only to the Resend account owner's email — fine for an owner test).
  if (!sent.ok && /not verified/i.test(sent.detail)) {
    sent = await sendEmail(email, `[TEST] ${brief.subject}`, brief.html, "Plainview <onboarding@resend.dev>", brief.text);
    via = "resend onboarding sender (your domain isn't verified yet)";
  }
  return NextResponse.json({ ok: sent.ok, sentTo: email, via, sweep, subject: brief.subject, resend: sent.detail });
}
