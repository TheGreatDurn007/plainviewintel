import { NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { isAdmin } from "@/lib/usage-log";

// Cost-protection only (NOT monetization): a generous per-user daily cap on the LLM-calling endpoints
// so a runaway loop or abuse can't quietly run up the AI bill. Invisible to normal use. Counter lives
// in Supabase Storage (no DDL), keyed by day+user. Override the cap with AI_DAILY_LIMIT.
const BUCKET = "plainview-state";
const DEFAULT_LIMIT = 150;
const CONFIG_KEY = "_config/ai-quota.json"; // runtime override, owner-toggled from the Admin tab

// Env defaults — the fallback when no runtime override has been saved. The Admin toggle (stored in
// Supabase) is authoritative when present, so the owner can flip the user cap on/off with no redeploy.
function envEnabled(): boolean { return String(process.env.AI_QUOTA_ENABLED || "").toLowerCase() === "true"; }
function envLimit(): number { const n = Number(process.env.AI_DAILY_LIMIT); return Number.isFinite(n) && n > 0 ? n : DEFAULT_LIMIT; }

function env(n: string): string { const v = process.env[n]; if (!v) throw new Error(`Missing ${n}`); return v; }
function dayKey(): string { return new Date().toISOString().slice(0, 10); }
function quotaKey(userId: string): string { return `_quota/${dayKey()}/${userId}.json`; }
function admin() { return createClient(env("NEXT_PUBLIC_SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } }); }

export type QuotaConfig = { enabled: boolean; limit: number };

// 60s per-instance cache so a toggle change propagates within a minute without a Supabase read on every
// AI call. Fail-open: any error resolves to the env/default config — cost-protection must never break a call.
let _cfgCache: { cfg: QuotaConfig; ts: number } | null = null;
const CFG_TTL = 60_000;

/** The effective quota config right now: runtime override (Admin toggle) if saved, else env/defaults. */
export async function getQuotaConfig(): Promise<QuotaConfig> {
  if (_cfgCache && Date.now() - _cfgCache.ts < CFG_TTL) return _cfgCache.cfg;
  let cfg: QuotaConfig = { enabled: envEnabled(), limit: envLimit() };
  try {
    const { data } = await admin().storage.from(BUCKET).download(CONFIG_KEY);
    if (data) {
      const j = JSON.parse(await data.text());
      cfg = { enabled: !!j.enabled, limit: Number.isFinite(Number(j.limit)) && Number(j.limit) > 0 ? Number(j.limit) : envLimit() };
    }
  } catch { /* no override → env/default */ }
  _cfgCache = { cfg, ts: Date.now() };
  return cfg;
}

/** Save the runtime quota config (owner-only, from the Admin tab). Updates the cache immediately. */
export async function setQuotaConfig(enabled: boolean, limitVal?: number): Promise<QuotaConfig> {
  const cap = Number.isFinite(Number(limitVal)) && Number(limitVal) > 0 ? Math.round(Number(limitVal)) : (await getQuotaConfig()).limit;
  const cfg: QuotaConfig = { enabled: !!enabled, limit: cap };
  try {
    await admin().storage.from(BUCKET).upload(CONFIG_KEY, new Blob([JSON.stringify({ ...cfg, setAt: new Date().toISOString() })], { type: "application/json" }), { upsert: true, contentType: "application/json" });
  } catch { /* fail-open — the in-memory cache still reflects the choice for this instance */ }
  _cfgCache = { cfg, ts: Date.now() };
  return cfg;
}

async function currentUserId(): Promise<string | null> {
  try {
    const cookieStore = await cookies();
    const supabase = createServerClient(env("NEXT_PUBLIC_SUPABASE_URL"), env("NEXT_PUBLIC_SUPABASE_ANON_KEY"), {
      cookies: { getAll() { return cookieStore.getAll(); }, setAll() { /* read-only */ } },
    });
    const { data: { user } } = await supabase.auth.getUser();
    return user?.id || null;
  } catch { return null; }
}

/**
 * Count one AI action for the current user. Returns ok:false only once the generous daily cap is hit.
 * Fails OPEN on any storage/identity error — cost-protection must never break a legitimate request.
 */
export async function enforceAiQuota(): Promise<NextResponse | null> {
  const cfg = await getQuotaConfig();
  if (!cfg.enabled) return null; // dormant (Admin toggle / env) — no counting, no blocking
  if (await isAdmin()) return null; // owner/admin testing the platform is never rate-limited
  const userId = await currentUserId();
  if (!userId) return null; // can't identify (already behind auth middleware) → don't block
  const cap = cfg.limit;
  const db = admin();
  let count = 0;
  try {
    const { data } = await db.storage.from(BUCKET).download(quotaKey(userId));
    if (data) { const j = JSON.parse(await data.text()); count = Number(j.count) || 0; }
  } catch { /* no counter yet → 0 */ }
  if (count >= cap) {
    return NextResponse.json(
      { error: "You've hit today's AI usage limit. It resets tomorrow — this keeps the free service sustainable.", _quota: { used: count, limit: cap } },
      { status: 429 }
    );
  }
  try {
    const blob = new Blob([JSON.stringify({ count: count + 1, day: dayKey() })], { type: "application/json" });
    await db.storage.from(BUCKET).upload(quotaKey(userId), blob, { upsert: true, contentType: "application/json" });
  } catch { /* fail open */ }
  return null;
}
