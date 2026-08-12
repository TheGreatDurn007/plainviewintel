import { NextResponse } from "next/server";
import crypto from "crypto";
import { setTierByEmail, type Tier } from "@/lib/tier";

// ─── Whop subscription webhook ────────────────────────────────────────────────
// Whop POSTs here on purchase / cancel. We verify the signature, map the buyer's EMAIL to their
// Plainview (Supabase) account, and flip their tier. Whop's published docs don't pin down the exact
// payload field names, so this parses DEFENSIVELY across the likely shapes and logs the real event —
// after one live test we lock the mapping. Events (per docs): payment.succeeded / membership.activated
// (grant) and membership.deactivated (revoke). Must be PUBLIC (Whop is unauthenticated) — see middleware.

function planIdFromUrl(u?: string | null): string | null {
  const m = (u || "").match(/plan_[A-Za-z0-9]+/);
  return m ? m[0] : null;
}
// Map a plan id → tier. All four paid plans (monthly + annual) hardcoded so any purchase grants the right
// tier; env vars still override. Pro monthly/annual → "pro"; Advanced monthly/annual → "pro_plus".
function planTierMap(): Record<string, Tier> {
  const map: Record<string, Tier> = {
    plan_tjQP99NUg4iq7: "pro",       // Pro monthly
    plan_xF6LTivYYgHgm: "pro",       // Pro annual
    plan_NKHx33Li92dhp: "pro_plus",  // Advanced monthly
    plan_W9GOpoCzOhJvd: "pro_plus",  // Advanced annual
  };
  const pro = planIdFromUrl(process.env.WHOP_PRO_URL); if (pro) map[pro] = "pro";
  const proAnnual = planIdFromUrl(process.env.WHOP_PRO_ANNUAL_URL); if (proAnnual) map[proAnnual] = "pro";
  const proPlus = planIdFromUrl(process.env.WHOP_PROPLUS_URL); if (proPlus) map[proPlus] = "pro_plus";
  const proPlusAnnual = planIdFromUrl(process.env.WHOP_PROPLUS_ANNUAL_URL); if (proPlusAnnual) map[proPlusAnnual] = "pro_plus";
  return map;
}

// Whop uses Svix for webhooks. Svix signs over "{msg_id}.{timestamp}.{body}" with the secret
// (base64-decoded after stripping the whsec_/ws_ prefix). The signature header is "v1,<b64>".
function verifySignature(raw: string, headers: Headers, secret: string): { ok: boolean; mode: string } {
  if (!secret) return { ok: true, mode: "no_secret" };
  const sigHeader = headers.get("webhook-signature") || headers.get("x-whop-signature") || null;
  if (!sigHeader) return { ok: false, mode: "no_header" };

  // Svix-style: sign over "{msg_id}.{timestamp}.{body}"
  const msgId = headers.get("webhook-id") || headers.get("svix-id") || "";
  const timestamp = headers.get("webhook-timestamp") || headers.get("svix-timestamp") || "";

  // Strip ws_/whsec_ prefix and base64-decode the secret
  const rawSecret = secret.replace(/^(whsec_|ws_)/, "");
  const keyBuf = Buffer.from(rawSecret, "base64");

  // Try Svix scheme first (msg_id.timestamp.body)
  if (msgId && timestamp) {
    const toSign = `${msgId}.${timestamp}.${raw}`;
    const svixSig = crypto.createHmac("sha256", keyBuf).update(toSign, "utf8").digest("base64");
    const sigs = String(sigHeader).split(" ");
    for (const s of sigs) {
      const val = s.replace(/^v1,/, "");
      if (val === svixSig) return { ok: true, mode: "svix" };
    }
  }

  // Fallback: simple HMAC over raw body (plain secret, not base64-decoded)
  const hex = crypto.createHmac("sha256", secret).update(raw, "utf8").digest("hex");
  const b64 = crypto.createHmac("sha256", secret).update(raw, "utf8").digest("base64");
  const h = String(sigHeader);
  if (h.includes(hex) || h.includes(b64)) return { ok: true, mode: "hmac" };

  return { ok: false, mode: "mismatch" };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function pick(obj: any, paths: string[]): any {
  for (const p of paths) {
    const v = p.split(".").reduce((o, k) => (o == null ? o : o[k]), obj);
    if (v != null && v !== "") return v;
  }
  return null;
}

export async function POST(req: Request) {
  const raw = await req.text();
  const secret = process.env.WHOP_WEBHOOK_SECRET || "";
  const v = verifySignature(raw, req.headers, secret);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let evt: any;
  try { evt = JSON.parse(raw); } catch { return NextResponse.json({ ok: false, error: "bad_json" }, { status: 400 }); }

  const type = String(pick(evt, ["action", "type", "event"]) || "").replace(/_/g, ".");
  const d = evt?.data ?? evt;
  const email = pick(d, ["user.email", "email", "member.email", "customer.email", "user_email", "membership.user.email"]);
  const planId = pick(d, ["plan.id", "plan_id", "plan", "product_id", "product", "membership.plan.id"]);

  // Log everything — shape, signature result, and headers — so we can lock down verification after the first real event.
  const sigHeader = req.headers.get("webhook-signature") || req.headers.get("x-whop-signature") || "";
  const msgId = req.headers.get("webhook-id") || req.headers.get("svix-id") || "";
  console.log("[whop-webhook]", JSON.stringify({ sigMode: v.mode, sigOk: v.ok, type, email, planId, sigHeader: sigHeader.slice(0, 80), msgId, keys: Object.keys(evt || {}), dataKeys: Object.keys(d || {}), sample: raw.slice(0, 1000) }));

  if (!v.ok) console.warn("[whop-webhook] SIGNATURE MISMATCH — processing anyway to avoid blocking payments. Lock down after confirming Whop's exact signing scheme from these logs.");

  const tier: Tier = (planId && planTierMap()[planId]) || "pro"; // unknown plan on a purchase → default Pro

  if (/payment\.succeeded|membership\.(activated|went_valid|created|valid)/i.test(type)) {
    if (email) { const r = await setTierByEmail(String(email), tier, "whop:" + type); console.log("[whop-webhook] grant", JSON.stringify({ email, tier, r })); }
    return NextResponse.json({ ok: true, action: "grant", email: !!email, tier });
  }
  if (/membership\.(deactivated|went_invalid|cancell?ed|expired|invalid)/i.test(type)) {
    if (email) { const r = await setTierByEmail(String(email), "free", "whop:" + type); console.log("[whop-webhook] revoke", JSON.stringify({ email, r })); }
    return NextResponse.json({ ok: true, action: "revoke", email: !!email });
  }
  return NextResponse.json({ ok: true, ignored: type || "unknown" });
}
