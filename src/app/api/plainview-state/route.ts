import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { logVisit } from "@/lib/usage-log";
import { getUserTier, getTierRecord, gatingEnabled, isOwnerEmail } from "@/lib/tier";

// Whop checkout-link URLs (public — safe to send to the client). Set these in Vercel env when the
// Whop products exist; until then the upgrade CTAs fall back to a "launching soon" message.
function whopLinks() {
  // Public Whop checkout URLs (not secrets) — hardcoded so the upgrade CTAs work without env juggling;
  // env vars still override if set. Monthly + annual per tier.
  return {
    pro: process.env.WHOP_PRO_URL || "https://whop.com/checkout/plan_tjQP99NUg4iq7",
    proAnnual: process.env.WHOP_PRO_ANNUAL_URL || "https://whop.com/checkout/plan_xF6LTivYYgHgm",
    proPlus: process.env.WHOP_PROPLUS_URL || "https://whop.com/checkout/plan_NKHx33Li92dhp",
    proPlusAnnual: process.env.WHOP_PROPLUS_ANNUAL_URL || "https://whop.com/checkout/plan_W9GOpoCzOhJvd",
    free: process.env.WHOP_FREE_URL || "https://whop.com/checkout/plan_ePdg6yN6SgCLb",
    // Where paid users go to cancel / update their card (Whop is the Merchant of Record).
    manage: process.env.WHOP_MANAGE_URL || "https://whop.com/orders/",
  };
}

const BUCKET = "plainview-state";

// Heavy, regenerable market caches that must NEVER be persisted — they bloat state.json
// (to multiple MB) and break loading on slower/mobile devices. Stripped on both save and
// load so it works regardless of which client-code version a device is running.
// NB: performanceCache is intentionally NOT here — it's small (~17KB) and needed for
// instant % -change rendering on load. Only genuinely heavy/regenerable caches are stripped.
const HEAVY_CACHE_KEYS = [
  "stocktwitsCache", "priceHistory", "newsCache", "newsCoverage",
  "sectorCache", "moversCache", "sentimentTrending",
];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function stripHeavyCaches(state: any) {
  if (state && typeof state === "object") {
    for (const k of HEAVY_CACHE_KEYS) delete state[k];
  }
  return state;
}

function env(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not configured.`);
  return value;
}

async function getAuthenticatedUserId(): Promise<{ id: string; email: string | null; name: string | null }> {
  const cookieStore = await cookies();
  const supabase = createServerClient(
    env("NEXT_PUBLIC_SUPABASE_URL"),
    env("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet: { name: string; value: string; options?: Record<string, unknown> }[]) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              cookieStore.set(name, value, options as any)
            );
          } catch {
            // Read-only context — session refresh handled by middleware
          }
        },
      },
    }
  );

  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();

  if (error || !user) throw new Error("Not authenticated");
  // display_name captured at signup (user_metadata) — used to seed the greeting for new users.
  const meta = (user.user_metadata || {}) as Record<string, unknown>;
  const name = (typeof meta.display_name === "string" && meta.display_name.trim()) ? meta.display_name.trim() : null;
  return { id: user.id, email: user.email ?? null, name };
}

function storageAdmin() {
  return createClient(env("NEXT_PUBLIC_SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

async function ensureBucket(supabase: ReturnType<typeof storageAdmin>) {
  const { data, error } = await supabase.storage.listBuckets();
  if (error) throw error;
  if (data.some((b) => b.name === BUCKET)) return;
  const { error: createError } = await supabase.storage.createBucket(BUCKET, { public: false });
  if (createError) throw createError;
}

export async function GET() {
  try {
    const { id: userId, email, name } = await getAuthenticatedUserId();
    void logVisit(); // count this app-open as activity (active-user tracking), fire-and-forget
    const tier = await getUserTier(userId, email).catch(() => "free" as const);
    const owner = isOwnerEmail(email);
    const tierRec = owner ? null : await getTierRecord(userId).catch(() => null);
    const subExpMs = tierRec?.expiresAt ? new Date(tierRec.expiresAt).getTime() - Date.now() : null;
    const subscription = {
      expiresAt: tierRec?.expiresAt ?? null,
      daysLeft: subExpMs != null && !isNaN(subExpMs) ? Math.ceil(subExpMs / 86_400_000) : null,
      autoRenew: tierRec?.autoRenew ?? false,
      cancelledAt: tierRec?.cancelledAt ?? null,
      source: tierRec?.source ?? (owner ? "owner" : null),
    };
    const supabase = storageAdmin();
    await ensureBucket(supabase);

    const { data, error } = await supabase.storage
      .from(BUCKET)
      .download(`${userId}/state.json`);

    if (error) {
      if (error.message.toLowerCase().includes("not found")) {
        return NextResponse.json({ state: null, tier, email, name, gating: gatingEnabled(), whop: whopLinks(), subscription });
      }
      throw error;
    }

    const state = stripHeavyCaches(JSON.parse(await data.text()));
    // Strip any stale in-flight brief states — these get saved when a request is
    // in-flight and the page is closed/refreshed. They cause permanent "Generating..."
    if (state?.intelBriefCache && typeof state.intelBriefCache === "object") {
      for (const key of Object.keys(state.intelBriefCache)) {
        if (state.intelBriefCache[key]?.loading) delete state.intelBriefCache[key];
      }
    }
    return NextResponse.json({ state, tier, email, name, gating: gatingEnabled(), whop: whopLinks(), subscription });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not load state.";
    const status = message === "Not authenticated" ? 401 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}

export async function PUT(request: Request) {
  try {
    const { id: userId } = await getAuthenticatedUserId();
    const supabase = storageAdmin();
    await ensureBucket(supabase);

    const body = await request.json();
    const state = stripHeavyCaches(body?.state ?? body);
    const payload = JSON.stringify(
      { ...state, savedAt: new Date().toISOString() },
      null,
      2
    );

    const { error } = await supabase.storage
      .from(BUCKET)
      .upload(`${userId}/state.json`, payload, {
        contentType: "application/json",
        upsert: true,
      });

    if (error) throw error;
    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not save state.";
    const status = message === "Not authenticated" ? 401 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}

export async function DELETE() {
  try {
    const { id: userId } = await getAuthenticatedUserId();
    const supabase = storageAdmin();
    await ensureBucket(supabase);

    const { error } = await supabase.storage
      .from(BUCKET)
      .remove([`${userId}/state.json`]);

    if (error) throw error;
    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not clear state.";
    const status = message === "Not authenticated" ? 401 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
