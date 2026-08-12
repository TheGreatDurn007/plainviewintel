import { NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { getUserTier, getTierRecord, updateTierRecord, isOwnerEmail, type Tier } from "@/lib/tier";

function env(n: string): string { const v = process.env[n]; if (!v) throw new Error(`Missing ${n}`); return v; }

async function authedUser(): Promise<{ id: string; email: string | null }> {
  const cookieStore = await cookies();
  const supabase = createServerClient(env("NEXT_PUBLIC_SUPABASE_URL"), env("NEXT_PUBLIC_SUPABASE_ANON_KEY"), {
    cookies: { getAll() { return cookieStore.getAll(); }, setAll() { /* read-only */ } },
  });
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) throw new Error("Not authenticated");
  return { id: user.id, email: user.email ?? null };
}

function daysUntil(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = new Date(iso).getTime() - Date.now();
  if (isNaN(ms)) return null;
  return Math.ceil(ms / 86_400_000);
}

export async function GET() {
  try {
    const { id, email } = await authedUser();
    const tier = await getUserTier(id, email);
    const isOwner = isOwnerEmail(email);
    const rec = isOwner ? null : await getTierRecord(id);

    return NextResponse.json({
      tier,
      label: tier === "pro_plus" ? "Advanced" : tier === "pro" ? "Pro" : "Free",
      isOwner,
      expiresAt: rec?.expiresAt ?? null,
      daysLeft: daysUntil(rec?.expiresAt),
      autoRenew: rec?.autoRenew ?? false,
      cancelledAt: rec?.cancelledAt ?? null,
      source: rec?.source ?? (isOwner ? "owner" : null),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "error";
    return NextResponse.json({ error: msg }, { status: msg === "Not authenticated" ? 401 : 500 });
  }
}

export async function POST(req: Request) {
  try {
    const { id, email } = await authedUser();
    if (isOwnerEmail(email)) return NextResponse.json({ error: "Owner tier cannot be modified" }, { status: 400 });

    const body = await req.json();
    const action = body?.action;

    if (action === "toggle_auto_renew") {
      const rec = await getTierRecord(id);
      if (!rec || (rec.tier !== "pro" && rec.tier !== "pro_plus")) {
        return NextResponse.json({ error: "No active subscription" }, { status: 400 });
      }
      await updateTierRecord(id, { autoRenew: !rec.autoRenew });
      return NextResponse.json({ ok: true, autoRenew: !rec.autoRenew });
    }

    if (action === "cancel") {
      const rec = await getTierRecord(id);
      if (!rec || (rec.tier !== "pro" && rec.tier !== "pro_plus")) {
        return NextResponse.json({ error: "No active subscription" }, { status: 400 });
      }
      await updateTierRecord(id, {
        autoRenew: false,
        cancelledAt: new Date().toISOString(),
      });
      return NextResponse.json({ ok: true, cancelled: true });
    }

    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "error";
    return NextResponse.json({ error: msg }, { status: msg === "Not authenticated" ? 401 : 500 });
  }
}
