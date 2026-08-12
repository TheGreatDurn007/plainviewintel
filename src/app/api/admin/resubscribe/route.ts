import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { isAdmin } from "@/lib/usage-log";
import { resubscribeEmail } from "@/lib/daily-brief";

// Owner-only suppression inspector + fixer. The daily brief silently skips any address on the suppression
// list (`_usage/_unsub.json`) — so if an address got there during testing (or a mailbox provider fired a
// one-click unsubscribe), that user stops receiving mail with no error. This explains "Corey got it, I didn't."
//   GET /api/admin/resubscribe                      → JSON of who is currently suppressed (+ when + source)
//   GET /api/admin/resubscribe?email=you@host.com   → resubscribe that address, returns before/after
export const dynamic = "force-dynamic";

function admin() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
}
async function loadMap(): Promise<Record<string, { ts?: number; source?: string }>> {
  try {
    const { data, error } = await admin().storage.from("plainview-state").download("_usage/_unsub.json");
    if (error || !data) return {};
    return JSON.parse(await data.text());
  } catch { return {}; }
}

export async function GET(req: Request) {
  if (!(await isAdmin().catch(() => false))) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const email = new URL(req.url).searchParams.get("email");
  const before = await loadMap();
  const fmt = (m: Record<string, { ts?: number; source?: string }>) =>
    Object.fromEntries(Object.entries(m).map(([e, v]) => [e, { since: v.ts ? new Date(v.ts).toISOString() : null, source: v.source ?? null }]));

  if (email) {
    const key = email.trim().toLowerCase();
    const wasSuppressed = !!before[key];
    await resubscribeEmail(email);
    const after = await loadMap();
    return NextResponse.json({ resubscribed: key, wasSuppressed, nowSuppressed: !!after[key], stillSuppressed: fmt(after) });
  }
  return NextResponse.json({ suppressedCount: Object.keys(before).length, suppressed: fmt(before) });
}
