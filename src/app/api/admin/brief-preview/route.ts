import { NextResponse } from "next/server";
import { buildBrief, fetchMarketContext, sweepUserTheses } from "@/lib/daily-brief";
import { isAdmin } from "@/lib/usage-log";
import { getRequestUserId } from "@/lib/nexus-memory";

// Owner-only LIVE PREVIEW of the daily brief — renders the REAL buildBrief() for the signed-in owner's own
// account and returns the exact HTML, WITHOUT sending anything. Breaks the "looked great in a mockup, came
// out bare in the inbox" cycle: open this, see precisely what the cron would send, iterate on the real thing.
//   /api/admin/brief-preview            → AM/default
//   /api/admin/brief-preview?slot=pm    → evening
//   /api/admin/brief-preview?format=text→ the plain-text part
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET(req: Request) {
  if (!(await isAdmin().catch(() => false))) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const userId = await getRequestUserId().catch(() => null);
  if (!userId) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const url = new URL(req.url);
  const slotParam = url.searchParams.get("slot");
  const slot: "am" | "pm" | undefined = slotParam === "pm" ? "pm" : slotParam === "am" ? "am" : undefined;
  const format = url.searchParams.get("format");

  // ?fresh=1 → re-sweep this account first (regenerates signals with the LATEST code: correct filing labels,
  // event-driven data), so the preview shows current reality. NO email is sent. Slower (~30-60s).
  if (url.searchParams.get("fresh") === "1") {
    try { await sweepUserTheses(userId, 3, slot === "pm"); } catch { /* fail-soft — render off last sweep */ }
  }
  const market = await fetchMarketContext();
  // ?seen=1 → mark this preview's headlines as shown (simulate the AM↔PM loop: preview AM with &seen=1, then
  // preview PM and watch it skip the morning's articles). Default off so plain previews don't pollute the loop.
  const brief = await buildBrief(userId, market, slot, { markSeen: url.searchParams.get("seen") === "1" });
  if (!brief) {
    return new Response(
      `<div style="font-family:sans-serif;background:#0a0b0d;color:#b4bac3;padding:48px;text-align:center">No brief would be sent — not enough data yet (no theses with a written thesis ≥12 chars, no buy-zone entries, and no captured signals for this account). Add a position with a thesis, run the sweep, then refresh.</div>`,
      { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } }
    );
  }
  if (format === "text") {
    return new Response(brief.text.split("%%UNSUB%%").join("(preview — no unsubscribe)"), { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
  }
  // Render the HTML exactly as it would send; neutralize the unsubscribe placeholder for the preview.
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Brief preview — ${slot || "default"}${" · " + brief.subject}</title></head><body style="margin:0;background:#0a0b0d">${brief.html.split("%%UNSUB%%").join("#preview")}</body></html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}
