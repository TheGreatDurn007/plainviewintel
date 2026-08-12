// ─── Smart-tier spend meter ───────────────────────────────────────────────────
// The free chain (Cerebras/Groq/Gemini) is $0; the only real Anthropic spend is the SMART judgment tier
// (the thesis verdict on Sonnet/Opus). This records ACTUAL token usage per call into a month-keyed file in
// Supabase Storage (zero-DDL, mirrors ai-quota/usage-log) so the Admin money panel shows real month-to-date
// cost, not a guess. Fail-soft everywhere — metering must never break or slow a verdict.
import { createClient } from "@supabase/supabase-js";

const BUCKET = "plainview-state";
function monthKey(): string { return new Date().toISOString().slice(0, 7); } // YYYY-MM
function spendKey(month: string): string { return `_spend/${month}.json`; }
function admin() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
}

// $ per 1M tokens (input, output). Standard Anthropic price points; an estimate is fine for an owner gauge.
const PRICING: Record<string, { in: number; out: number }> = {
  "claude-sonnet-4-6": { in: 3, out: 15 },
  "claude-opus-4-8": { in: 15, out: 75 },
};
function priceFor(model: string) { return PRICING[model] || { in: 3, out: 15 }; }

export type MonthSpend = { month: string; calls: number; inTokens: number; outTokens: number; costUsd: number; byModel: Record<string, number> };

function empty(month: string): MonthSpend { return { month, calls: 0, inTokens: 0, outTokens: 0, costUsd: 0, byModel: {} }; }

/** Record one smart-tier call's real cost. Fire-and-forget from the route. */
export async function recordSmartSpend(model: string, inTokens: number, outTokens: number): Promise<void> {
  try {
    const month = monthKey();
    const db = admin();
    let cur = empty(month);
    try {
      const { data } = await db.storage.from(BUCKET).download(spendKey(month));
      if (data) { const j = JSON.parse(await data.text()); if (j && j.month === month) cur = { ...empty(month), ...j, byModel: j.byModel || {} }; }
    } catch { /* first call this month */ }
    const p = priceFor(model);
    const cost = (inTokens / 1e6) * p.in + (outTokens / 1e6) * p.out;
    cur.calls += 1;
    cur.inTokens += inTokens || 0;
    cur.outTokens += outTokens || 0;
    cur.costUsd = Math.round((cur.costUsd + cost) * 10000) / 10000;
    cur.byModel[model] = Math.round(((cur.byModel[model] || 0) + cost) * 10000) / 10000;
    await db.storage.from(BUCKET).upload(spendKey(month), new Blob([JSON.stringify(cur)], { type: "application/json" }), { upsert: true, contentType: "application/json" });
  } catch { /* metering is best-effort — never throw */ }
}

/** Month-to-date smart spend for the Admin money panel. */
export async function getSpendThisMonth(): Promise<MonthSpend> {
  const month = monthKey();
  try {
    const { data } = await admin().storage.from(BUCKET).download(spendKey(month));
    if (data) { const j = JSON.parse(await data.text()); if (j && j.month === month) return { ...empty(month), ...j, byModel: j.byModel || {} }; }
  } catch { /* none yet */ }
  return empty(month);
}
