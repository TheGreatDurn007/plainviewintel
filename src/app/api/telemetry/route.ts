import { NextResponse } from "next/server";
import { logError } from "@/lib/usage-log";

// Client error sink. Public (errors happen on the logged-out X-Ray too) + fail-open: this endpoint
// can never itself error a user. Body is capped/sanitized in logError. Best-effort, returns 200 always.
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as { msg?: string; src?: string; url?: string };
    if (body?.msg) await logError({ msg: body.msg, src: body.src, url: body.url });
  } catch { /* swallow */ }
  return NextResponse.json({ ok: true });
}
