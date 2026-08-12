import { NextResponse } from "next/server";
import { verifyUnsub, suppressEmail, resubscribeEmail } from "@/lib/daily-brief";

// One unsubscribe endpoint for every Plainview email. Public (links must work straight from the inbox, no
// login). The signed token proves the link was issued by us, so nobody can opt someone else out. GET (a click
// from the footer) shows a friendly confirmation page with an undo; POST is the RFC-8058 one-click that
// mailbox providers fire from their native "Unsubscribe" button. Fail-open.
export const dynamic = "force-dynamic";

function page(title: string, body: string): Response {
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head>`
    + `<body style="margin:0;background:#0a0b0d;color:#e8eaed;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">`
    + `<div style="max-width:440px;margin:12vh auto;padding:30px 26px;background:#111317;border:1px solid #20242b;border-radius:16px;text-align:center">`
    + `<div style="font-weight:800;letter-spacing:.06em;font-size:14px"><span style="display:inline-block;width:22px;height:22px;background:#1fdf64;border-radius:6px;color:#0a0b0d;line-height:22px;margin-right:7px">P</span>PLAINVIEW</div>`
    + `<h1 style="font-size:20px;font-weight:700;margin:20px 0 8px">${title}</h1>`
    + `<div style="color:#b4bac3;font-size:14px;line-height:1.6">${body}</div></div></body></html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}

async function apply(email: string | null, token: string | null, resub: boolean): Promise<boolean> {
  if (!email || !token || !verifyUnsub(email, token)) return false;
  if (resub) await resubscribeEmail(email); else await suppressEmail(email, "link");
  return true;
}

export async function GET(req: Request) {
  const u = new URL(req.url);
  const email = u.searchParams.get("e"), token = u.searchParams.get("t"), resub = u.searchParams.get("resub") === "1";
  const ok = await apply(email, token, resub);
  if (!ok) return page("This link has expired", "We couldn't verify this unsubscribe link. If you keep getting emails you don't want, reply to one and we'll remove you.");
  if (resub) return page("You're resubscribed", `<b style="color:#e8eaed">${email}</b> will receive Plainview emails again.`);
  const e = encodeURIComponent(email!), t = encodeURIComponent(token!);
  return page("You're unsubscribed", `<b style="color:#e8eaed">${email}</b> won't get any more Plainview emails.<br><br><a href="/api/unsubscribe?e=${e}&t=${t}&resub=1" style="color:#1fdf64;text-decoration:none">Changed your mind? Resubscribe &rarr;</a>`);
}

// RFC 8058 one-click — provider POSTs here; params are in the URL. Always 200 so it isn't retried.
export async function POST(req: Request) {
  const u = new URL(req.url);
  await apply(u.searchParams.get("e"), u.searchParams.get("t"), false);
  return NextResponse.json({ ok: true });
}
