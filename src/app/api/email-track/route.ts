import { NextResponse } from "next/server";
import { logEmailEvent } from "@/lib/usage-log";

// Landing beacon — the client fires this when a page is opened via a UTM-tagged brief link (utm_source=brief).
// It records that the email actually drove a click into Plainview ("clicked"), and whether the visitor was
// logged in ("loggedin") — the heart of the retention funnel. Public (no session needed: the X-Ray landing is
// anonymous); fail-open; carries only counts, never personal data.
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const b = await req.json().catch(() => ({}));
    const slot = b?.slot === "pm" ? "pm" : b?.slot === "am" ? "am" : "other";
    const section = typeof b?.section === "string" ? b.section.slice(0, 24) : undefined;
    await logEmailEvent("clicked", { slot, section });
    if (b?.loggedin) await logEmailEvent("loggedin", { slot, section });
  } catch { /* best-effort */ }
  return NextResponse.json({ ok: true });
}
