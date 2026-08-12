import { NextResponse } from "next/server";
import { logEmailEvent } from "@/lib/usage-log";

// Resend webhook — OPTIONAL, captures email OPENS (and clicks) into the funnel. Configure in the Resend
// dashboard with the URL /api/resend-webhook?k=<CRON_SECRET> (the ?k guards against spoofed posts — the
// payload is only counts, so a shared secret is enough at this scale). Events: email.opened / email.clicked /
// email.delivered. Slot isn't on the event (we don't tag sends), so opens land in the "other" slot but still
// count in the funnel totals. Fail-open; always 200 so Resend doesn't retry-storm.
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const k = new URL(req.url).searchParams.get("k");
    if (process.env.CRON_SECRET && k !== process.env.CRON_SECRET) return NextResponse.json({ error: "Not found" }, { status: 404 });
    const ev = await req.json().catch(() => ({}));
    const type = String(ev?.type || "");
    if (/opened/.test(type)) await logEmailEvent("opened");
    else if (/clicked/.test(type)) await logEmailEvent("clicked", { section: "resend" });
  } catch { /* best-effort */ }
  return NextResponse.json({ ok: true });
}
