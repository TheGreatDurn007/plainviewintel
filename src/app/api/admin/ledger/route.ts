import { NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { isAdmin } from "@/lib/usage-log";
import { buildLedger } from "@/lib/weekly-ledger";
import { sendEmail, fetchMarketContext } from "@/lib/daily-brief";

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

// Owner test: preview or send The Ledger.
//   GET /api/admin/ledger            → build + send to logged-in admin
//   GET /api/admin/ledger?preview=1  → build and return JSON (no send)
//   GET /api/admin/ledger?to=a@b.com → send to specific address(es)
export async function GET(req: Request) {
  if (!(await isAdmin())) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const { id, email } = await currentUser();
  if (!id || !email) return NextResponse.json({ error: "No session user" }, { status: 400 });

  const qs = new URL(req.url).searchParams;
  const market = await fetchMarketContext();
  const ledger = await buildLedger(id, market);
  if (!ledger) return NextResponse.json({ ok: false, reason: "No thesis or position data yet." });

  if (qs.get("preview") === "1") {
    return new Response(ledger.html, { headers: { "content-type": "text/html; charset=utf-8" } });
  }

  const toParam = qs.get("to");
  if (toParam) {
    const recipients = toParam.split(",").map(s => s.trim()).filter(s => /\S+@\S+\.\S+/.test(s)).slice(0, 10);
    const results: Array<{ to: string; ok: boolean; detail: string }> = [];
    let i = 0;
    for (const to of recipients) {
      if (i++ > 0) await new Promise(res => setTimeout(res, 220));
      const r = await sendEmail(to, `[TEST] ${ledger.subject}`, ledger.html, undefined, ledger.text);
      results.push({ to, ok: r.ok, detail: r.detail });
    }
    return NextResponse.json({ ok: results.every(r => r.ok), mode: "test-to", subject: ledger.subject, results });
  }

  let sent = await sendEmail(email, `[TEST] ${ledger.subject}`, ledger.html, undefined, ledger.text);
  let via = "domain";
  if (!sent.ok && /not verified/i.test(sent.detail)) {
    sent = await sendEmail(email, `[TEST] ${ledger.subject}`, ledger.html, "Plainview <onboarding@resend.dev>", ledger.text);
    via = "resend onboarding sender";
  }
  return NextResponse.json({ ok: sent.ok, sentTo: email, via, subject: ledger.subject, resend: sent.detail });
}
