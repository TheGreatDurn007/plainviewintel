// ─── Subscription tiers (Free / Pro / Pro+) ───────────────────────────────────
// Step 1 of monetization (see WHITEPAPER.md). Zero-DDL, mirrors usage-log.ts: a tiny JSON file per
// user in Supabase Storage holds their tier, written ONLY server-side (by the Whop webhook later) so
// the client can never grant itself paid access. ENFORCEMENT is gated behind PAID_GATING_ENABLED
// (default OFF) — until launch, every user is treated as if they have access, so nothing changes for
// current users. Fully fail-open: a tier lookup must never break a real request (errors → "free").
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

export type Tier = "free" | "pro" | "pro_plus";

const BUCKET = "plainview-state";
const PREFIX = "_tiers"; // _tiers/<userId>.json
const OWNER_EMAILS = new Set(["dar_fishman@hotmail.com"]); // founder always has top tier (for testing)

function env(n: string): string { const v = process.env[n]; if (!v) throw new Error(`Missing ${n}`); return v; }
function admin() {
  return createClient(env("NEXT_PUBLIC_SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
}

const RANK: Record<Tier, number> = { free: 0, pro: 1, pro_plus: 2 };

/** Whether tier enforcement is live. OFF by default so current users keep full access until launch. */
export function gatingEnabled(): boolean {
  return process.env.PAID_GATING_ENABLED === "true";
}

/** Which tier each gated feature needs. Free features aren't listed (no gate).
 *  DOCTRINE "track free, judgment paid": tracking (portfolio/watchlist/dashboard) is FREE — it's the data
 *  NEXUS eats. We gate the JUDGMENT only: the thesis verdict/stress-test and the NEXUS memory layer (brief,
 *  strength chip, contradiction alerts, Act-Now — all read from nexus-memory). */
export const FEATURE_TIER: Record<string, Tier> = {
  thesis: "pro",           // thesis verdict / stress-test (the Sonnet judgment call)
  nexus: "pro",            // the moat — daily sweep, brief, memory reads (strength chip, contradiction alerts)
  filing_reader: "pro",    // Filing Intelligence — structured extraction from 10-K/10-Q/8-K (Sonnet)
  // Pro+ exclusives (reserved for Opus-grade / power features) go here later, e.g.:
  // deep_contradiction: "pro_plus",
};

export interface TierRecord {
  tier: Tier;
  email?: string | null;
  source?: string | null;
  updatedAt?: string | null;
  expiresAt?: string | null;
  autoRenew?: boolean;
  cancelledAt?: string | null;
}

/** Read a user's full tier record from storage. Returns null when no file exists. */
export async function getTierRecord(userId: string): Promise<TierRecord | null> {
  try {
    const { data } = await admin().storage.from(BUCKET).download(`${PREFIX}/${userId}.json`);
    if (!data) return null;
    return JSON.parse(await data.text()) as TierRecord;
  } catch { return null; }
}

/** Write a tier record (merges with existing). */
export async function updateTierRecord(userId: string, patch: Partial<TierRecord>): Promise<void> {
  const existing = await getTierRecord(userId) || { tier: "free" as Tier };
  const merged = { ...existing, ...patch, updatedAt: new Date().toISOString() };
  const body = JSON.stringify(merged);
  await admin().storage.from(BUCKET).upload(`${PREFIX}/${userId}.json`, body, { upsert: true, contentType: "application/json" });
}

/** Read a user's tier. Founder → pro_plus. Expired → free. Missing file / any error → free. */
export async function getUserTier(userId: string | null, email?: string | null): Promise<Tier> {
  if (email && OWNER_EMAILS.has(email.toLowerCase())) return "pro_plus";
  if (!userId) return "free";
  try {
    const rec = await getTierRecord(userId);
    if (!rec) return "free";
    const t = rec.tier;
    if (t !== "pro" && t !== "pro_plus") return "free";
    if (rec.expiresAt) {
      const exp = new Date(rec.expiresAt).getTime();
      if (!isNaN(exp) && Date.now() > exp) return "free";
    }
    return t;
  } catch { return "free"; }
}

/** Set a user's tier (called by the Whop webhook on purchase / cancel). Best-effort. */
export async function setUserTier(userId: string, tier: Tier, meta?: { email?: string; source?: string }): Promise<void> {
  try {
    const body = JSON.stringify({ tier, email: meta?.email ?? null, source: meta?.source ?? "manual", updatedAt: new Date().toISOString() });
    const blob = new Blob([body], { type: "application/json" });
    await admin().storage.from(BUCKET).upload(`${PREFIX}/${userId}.json`, blob, { upsert: true, contentType: "application/json" });
  } catch { /* fail open — never throw from a billing webhook handler */ }
}

/** Resolve a Supabase user by email, then set their tier. Used by the Whop webhook (Whop knows the
 *  buyer by email; we map it to the Plainview account). Small user base → paginate a few pages. */
export async function setTierByEmail(email: string, tier: Tier, source?: string): Promise<{ ok: boolean; reason?: string; userId?: string }> {
  if (!email) return { ok: false, reason: "no_email" };
  try {
    const db = admin();
    let userId: string | null = null;
    for (let page = 1; page <= 15 && !userId; page++) {
      const { data, error } = await db.auth.admin.listUsers({ page, perPage: 200 });
      if (error || !data?.users?.length) break;
      const u = data.users.find((x) => (x.email || "").toLowerCase() === email.toLowerCase());
      if (u) userId = u.id;
      if (data.users.length < 200) break;
    }
    if (!userId) return { ok: false, reason: "no_user_for_email" };
    await setUserTier(userId, tier, { email, source });
    return { ok: true, userId };
  } catch (e) { return { ok: false, reason: e instanceof Error ? e.message : String(e) }; }
}

/** Is this email a platform owner (founder)? Used to gate owner-only admin controls. */
export function isOwnerEmail(email: string | null | undefined): boolean {
  return !!email && OWNER_EMAILS.has(email.toLowerCase());
}

/** Does `userTier` meet `required`? */
export function meetsTier(userTier: Tier, required: Tier): boolean {
  return RANK[userTier] >= RANK[required];
}

/** Gate check for a feature. When enforcement is OFF, everything is allowed (current behaviour). */
export function canUseFeature(userTier: Tier, feature: string): boolean {
  if (!gatingEnabled()) return true;
  const required = FEATURE_TIER[feature];
  if (!required) return true; // not a gated feature
  return meetsTier(userTier, required);
}

/** Resolve the CURRENT request's user (id + email) from the session cookie. Fail-soft → nulls. */
async function currentRequestUser(): Promise<{ userId: string | null; email: string | null }> {
  try {
    const cookieStore = await cookies();
    const supabase = createServerClient(env("NEXT_PUBLIC_SUPABASE_URL"), env("NEXT_PUBLIC_SUPABASE_ANON_KEY"), {
      cookies: { getAll() { return cookieStore.getAll(); }, setAll() { /* read-only */ } },
    });
    const { data: { user } } = await supabase.auth.getUser();
    return { userId: user?.id ?? null, email: user?.email ?? null };
  } catch { return { userId: null, email: null }; }
}

/**
 * Request-scoped gate: is the CURRENT user allowed to use `feature`? Resolves their tier from the session
 * (owner/founder → pro_plus). When PAID_GATING_ENABLED is off, always true. Use at the top of a judgment
 * route to enforce "track free, judgment paid" server-side (so it can't be bypassed by calling the API).
 */
export async function isFeatureAllowed(feature: string): Promise<boolean> {
  if (!gatingEnabled()) return true;
  if (!FEATURE_TIER[feature]) return true;
  const { userId, email } = await currentRequestUser();
  const tier = await getUserTier(userId, email).catch(() => "free" as Tier);
  return canUseFeature(tier, feature);
}
