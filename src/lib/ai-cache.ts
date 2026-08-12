import { createClient } from "@supabase/supabase-js";
import { createHash } from "crypto";

// Global, cross-user cache for AI-generated text — store once, serve to everyone, forever.
// Cost design: an immutable input (e.g. a filed SEC document) should cost exactly ONE Anthropic
// call total, ever — not one per user per click. Lives in Supabase Storage (zero-DDL), keyed by a
// hash of the input. Fully fail-open: a cache miss/error just means we generate fresh (never breaks).
const BUCKET = "plainview-state";
const PREFIX = "_aicache";

function env(n: string): string { const v = process.env[n]; if (!v) throw new Error(`Missing ${n}`); return v; }
function admin() {
  return createClient(env("NEXT_PUBLIC_SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
}
function keyFor(namespace: string, input: string): string {
  const h = createHash("sha256").update(input).digest("hex").slice(0, 40);
  return `${PREFIX}/${namespace}/${h}.json`;
}

/**
 * Return previously-cached text for this input, or null on miss/error/expiry.
 * @param maxAgeMs omit (or <=0) for an immutable input that never expires (e.g. a filed document).
 */
export async function getCachedText(namespace: string, input: string, maxAgeMs?: number): Promise<string | null> {
  try {
    const { data } = await admin().storage.from(BUCKET).download(keyFor(namespace, input));
    if (!data) return null;
    const j = JSON.parse(await data.text()) as { text?: string; ts?: number };
    if (typeof j.text !== "string") return null;
    if (maxAgeMs && maxAgeMs > 0 && j.ts && Date.now() - j.ts > maxAgeMs) return null;
    return j.text;
  } catch { return null; }
}

/** Store generated text for this input. Best-effort — failure is swallowed (we already have the answer). */
export async function setCachedText(namespace: string, input: string, text: string): Promise<void> {
  try {
    const blob = new Blob([JSON.stringify({ text, ts: Date.now() })], { type: "application/json" });
    await admin().storage.from(BUCKET).upload(keyFor(namespace, input), blob, { upsert: true, contentType: "application/json" });
  } catch { /* fail open */ }
}

/** How many entries are cached under a namespace (for the founder's cache-savings readout). */
export async function countCached(namespace: string): Promise<number> {
  try {
    const { data } = await admin().storage.from(BUCKET).list(`${PREFIX}/${namespace}`, { limit: 10000 });
    return (data || []).filter((f) => f.name.endsWith(".json")).length;
  } catch { return 0; }
}
