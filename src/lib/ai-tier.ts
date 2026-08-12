// ─── Judgment-model routing knob (the "smart tier") ───────────────────────────
// NEXUS's genuine reasoning calls (the thesis verdict) can run on a stronger paid model. Two layers:
//   1. RUNTIME override (Supabase, owner-toggled from the Admin tab) — flips Free↔Sonnet with ONE
//      click, no redeploy, and is an instant cost kill-switch. This is authoritative when set.
//   2. SMART_MODEL env var — the fallback/default when no runtime override exists.
//   • "free" / unset       → null → caller uses its free-first chain ($0)
//   • "claude-sonnet-4-6"  → route the thesis verdict to Sonnet (the judgment tier)
//   • "claude-opus-4-8"    → Pro+ hardest calls
// See WHITEPAPER.md §6.
import { createClient } from "@supabase/supabase-js";

const CONFIG_BUCKET = "plainview-state";
const CONFIG_KEY = "_config/nexus-model.json";
// What the Admin toggle may select. "free" = the $0 chain; the rest are real Anthropic model ids.
export const ALLOWED_JUDGMENT_MODELS = ["free", "claude-sonnet-4-6", "claude-opus-4-8"] as const;
export type JudgmentModelSetting = (typeof ALLOWED_JUDGMENT_MODELS)[number];

/** Normalize a setting string → a real model id, or null for the free chain. */
function normModel(m: string | null | undefined): string | null {
  const s = (m || "").trim();
  return s && s.toLowerCase() !== "free" ? s : null;
}

/** Env-only knob (sync) — the default when no runtime override is set. */
export function judgmentModel(): string | null {
  return normModel(process.env.SMART_MODEL);
}

function configAdmin() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );
}

// 60s per-instance cache: a toggle change propagates within a minute, without a Supabase read on
// every judgment call. Caches the RESOLVED value (including the env fallback / "free").
let _cache: { model: string | null; ts: number } | null = null;
const CACHE_TTL = 60_000;

/**
 * The judgment model to use right now: runtime override (Admin toggle) if present, else the env knob,
 * else free ($0). Fail-open — any error resolves to the env/free default, never throws or blocks.
 */
export async function getJudgmentModel(): Promise<string | null> {
  if (_cache && Date.now() - _cache.ts < CACHE_TTL) return _cache.model;
  let resolved = judgmentModel(); // env/free default
  try {
    const { data } = await configAdmin().storage.from(CONFIG_BUCKET).download(CONFIG_KEY);
    if (data) {
      const j = JSON.parse(await data.text());
      resolved = normModel(String(j?.model ?? ""));
    }
  } catch { /* no runtime override → keep env/free default */ }
  _cache = { model: resolved, ts: Date.now() };
  return resolved;
}

/** The raw setting string for display in Admin ("free" | model id). */
export async function getJudgmentSetting(): Promise<string> {
  return (await getJudgmentModel()) ?? "free";
}

/** Set the runtime judgment model (owner-only, from the Admin tab). Updates the cache immediately. */
export async function setJudgmentModel(model: string): Promise<JudgmentModelSetting> {
  const chosen = (ALLOWED_JUDGMENT_MODELS as readonly string[]).includes(model)
    ? (model as JudgmentModelSetting) : "free";
  const body = JSON.stringify({ model: chosen, setAt: new Date().toISOString() });
  await configAdmin().storage.from(CONFIG_BUCKET).upload(
    CONFIG_KEY, new Blob([body], { type: "application/json" }),
    { upsert: true, contentType: "application/json" }
  );
  _cache = { model: normModel(chosen), ts: Date.now() };
  return chosen;
}

export function isSmartJudgmentOn(): boolean {
  return judgmentModel() !== null;
}

/**
 * Circuit breaker: auto-downgrade to free when Anthropic credits are depleted.
 * Any route that catches a "credit balance too low" error should call this.
 * Prevents crons from silently burning through retry cycles on a dead key.
 */
export async function autoDowngradeOnCreditDepletion(): Promise<void> {
  try {
    const current = await getJudgmentModel();
    if (!current) return; // already on free
    console.warn("[ai-tier] AUTO-DOWNGRADE: Anthropic credits depleted — switching NEXUS to Free to stop the bleed.");
    await setJudgmentModel("free");
  } catch { /* best-effort — if this fails, at least the in-memory cache expires in 60s */ }
}
