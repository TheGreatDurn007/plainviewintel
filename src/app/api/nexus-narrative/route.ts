import Anthropic from "@anthropic-ai/sdk";
import { enforceAiQuota } from "@/lib/ai-quota";
import { logUsage } from "@/lib/usage-log";
import { NextResponse } from "next/server";
import { callCerebrasText, callGroqText, callGeminiText } from "@/lib/market-context";
import { getJudgmentModel } from "@/lib/ai-tier";

// NEXUS narrative — turns the day's structured brief (pulse + conviction shifts + buy-zone events)
// into ONE short, honest paragraph in NEXUS's voice. The client generates this once per day and caches
// it, so it's cheap. Free providers first (Cerebras→Groq→Gemini→Claude), same doctrine as the rest.
export const dynamic = "force-dynamic";

async function generateText(prompt: string): Promise<string> {
  // FREE CASCADE FIRST — Cerebras→Groq→Gemini at $0. Anthropic is the emergency-only fallback.
  if (process.env.CEREBRAS_API_KEY) { try { const o = await callCerebrasText(prompt); if (o && o.trim()) return o; } catch {} }
  if (process.env.GROQ_API_KEY) { try { const o = await callGroqText(prompt); if (o && o.trim()) return o; } catch {} }
  if (process.env.GEMINI_API_KEY) { try { const o = await callGeminiText(prompt); if (o && o.trim()) return o; } catch {} }
  // Anthropic fallback — only fires when all free providers failed.
  if (process.env.ANTHROPIC_API_KEY) {
    const smart = await getJudgmentModel();
    const model = smart || "claude-haiku-4-5-20251001";
    const a = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: 15000 });
    const r = await a.messages.create({ model, max_tokens: 260, temperature: 0, messages: [{ role: "user", content: prompt }] });
    return r.content.filter((b) => b.type === "text").map((b) => (b as unknown as { text: string }).text).join("\n");
  }
  throw new Error("No AI provider configured");
}

export async function POST(request: Request) {
  const _q = await enforceAiQuota(); if (_q) return _q;
  void logUsage("nexus");
  let body: { pulse?: { strengthening?: number; weakening?: number; total?: number; health?: number | null };
              changed?: Array<{ ticker: string; status: string; delta: number }>;
              zone?: Array<{ ticker: string; event: string }> };
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Invalid request" }, { status: 400 }); }

  const p = body.pulse || {};
  const changed = (body.changed || []).slice(0, 8).map((c) => `${c.ticker}: thesis ${c.status}, conviction ${c.delta > 0 ? "+" : ""}${c.delta}`).join("; ");
  const zone = (body.zone || []).slice(0, 8).map((z) => `${z.ticker} ${z.event}`).join("; ");

  const prompt = `You are NEXUS, the judgment layer of a personal investing tool. Write the investor's morning brief: ONE short paragraph (2-3 sentences, max ~55 words), plain and direct, second person ("your book", "you").

Today's facts (do not invent anything beyond these):
- Conviction pulse: ${p.strengthening ?? 0} theses strengthening, ${p.weakening ?? 0} weakening, ${p.total ?? 0} tracked${p.health != null ? `, book health ${p.health}/10` : ""}.
- Conviction shifts since the last check: ${changed || "none"}.
- Buy-zone events: ${zone || "none"}.

Lead with the single most important thing. Name specific tickers. Be honest and a little skeptical — never cheerlead, never give buy/sell orders. If nothing material changed, say the book is steady. No preamble, no sign-off, no markdown.`;

  try {
    const text = (await generateText(prompt)).trim();
    return NextResponse.json({ text });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "failed" }, { status: 502 });
  }
}
