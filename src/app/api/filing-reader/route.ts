import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import Anthropic from "@anthropic-ai/sdk";
import { isFeatureAllowed } from "@/lib/tier";
import { logUsage } from "@/lib/usage-log";
import { recordSignalObservations, type ObservationInput } from "@/lib/nexus-memory";
import { autoDowngradeOnCreditDepletion } from "@/lib/ai-tier";
import { stripThinkBlocks } from "@/lib/market-context";

export const dynamic = "force-dynamic";

// ─── Filing Reader — extract structured insights from SEC filings ────────────
// POST { ticker, accession, filingType, filingDate }
// Fetches the full filing HTML from EDGAR, sends to Sonnet for structured
// extraction, stores results in filing_insights + pipes numerics to
// nexus_signal_observations. Pro-gated. Cached by accession (a filing is immutable).

const SEC_HEADERS = {
  "User-Agent": "Plainview investing tool plainview@dar-fishman.com",
  Accept: "text/html,application/xml,text/xml,*/*",
};

type FilingInsight = {
  category: string;
  fact: string;
  numeric_value: number | null;
  quote: string | null;
  source_section: string | null;
};

function env(n: string): string {
  const v = process.env[n];
  if (!v) throw new Error(`Missing ${n}`);
  return v;
}

function serviceClient() {
  return createClient(env("NEXT_PUBLIC_SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

function stripHtml(raw: string, maxChars = 80000): string {
  return raw
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, (m) => m.slice(9, -3))
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/?(p|div|tr|li|h[1-6])[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, maxChars);
}

function extractFinancialSectionsForReader(raw: string): string {
  const text = stripHtml(raw, 500000);
  // Skip XBRL metadata prefix
  const xbrlEnd = (() => {
    const m = text.match(/\b(UNITED STATES SECURITIES|Consolidated Statements of|CONDENSED CONSOLIDATED|Table of Contents)\b/i);
    return m ? m.index! : 0;
  })();
  const body = text.slice(xbrlEnd);

  function grab(markers: string[], chars: number, lookback = 0): string {
    for (const m of markers) {
      let idx = body.indexOf(m);
      if (idx < 0) idx = body.toLowerCase().indexOf(m.toLowerCase());
      if (idx > 0) {
        const start = Math.max(0, idx - lookback);
        return body.slice(start, start + lookback + chars);
      }
    }
    return "";
  }

  const income = grab(["Cost of sales", "Cost of goods sold", "Cost of revenue"], 4000, 300)
    || grab(["Total revenues", "Total revenue", "Revenues:"], 4000);
  const balance = grab(["Cash and cash equivalents", "CONDENSED CONSOLIDATED BALANCE", "Total assets"], 3500);
  const cashflow = grab(["Cash flows from operating", "CONSOLIDATED STATEMENTS OF CASH"], 3000);
  const mda = grab(["Management's Discussion and Analysis", "Management s Discussion and Analysis"], 8000);
  const risk = grab(["Risk Factors", "RISK FACTORS"], 4000);
  const segments = grab(["Segment Information", "SEGMENT DISCLOSURES", "segment information"], 3000);

  const sections: string[] = [];
  if (income) sections.push("=== INCOME STATEMENT ===\n" + income);
  if (balance) sections.push("=== BALANCE SHEET ===\n" + balance);
  if (cashflow) sections.push("=== CASH FLOWS ===\n" + cashflow);
  if (mda) sections.push("=== MD&A ===\n" + mda);
  if (risk) sections.push("=== RISK FACTORS ===\n" + risk);
  if (segments) sections.push("=== SEGMENTS ===\n" + segments);

  if (!sections.length) return body.slice(0, 60000);
  return sections.join("\n\n").slice(0, 60000);
}

function buildEdgarUrl(accession: string): string {
  const clean = accession.replace(/-/g, "");
  return `https://www.sec.gov/Archives/edgar/data/${clean.slice(0, 10)}/${accession}`;
}

async function fetchFilingIndex(accession: string): Promise<string | null> {
  const clean = accession.replace(/-/g, "");
  const cik = clean.slice(0, 10).replace(/^0+/, "");
  const dashless = clean;
  const url = `https://www.sec.gov/Archives/edgar/data/${cik}/${dashless}/index.json`;
  try {
    const res = await fetch(url, { headers: { ...SEC_HEADERS, Accept: "application/json" } });
    if (!res.ok) return null;
    const idx = (await res.json()) as {
      directory: { item: Array<{ name: string; type: string; size: string }> };
    };
    const items = idx.directory?.item ?? [];
    const htm = items.find(
      (f) => /\.(htm|html)$/i.test(f.name) && !/R\d/.test(f.name) && !f.name.startsWith("R")
    );
    if (!htm) return null;
    const base = `https://www.sec.gov/Archives/edgar/data/${cik}/${dashless}`;
    return `${base}/${htm.name}`;
  } catch {
    return null;
  }
}

const EXTRACTION_PROMPT = `You are a financial analyst extracting structured facts from an SEC filing for a stock research platform. Your job is to pull out the most important, thesis-relevant facts that an investor doing due diligence would care about.

Extract 5-12 structured insights from this filing. For each insight, provide:
- category: one of [revenue, margins, cash_flow, debt, guidance, risk, mgmt_quote, sensitivity, litigation, segment, capital_allocation, outlook]
- fact: a clear, specific statement of the fact (include actual numbers, dates, percentages)
- numeric_value: the key number if applicable (in raw units — e.g. 38300000 not "38.3M"), or null
- quote: a verbatim quote from management if relevant (max 200 chars), or null
- source_section: where in the filing this came from (e.g. "MD&A", "Risk Factors", "Financial Statements")

RULES:
- Extract FACTS, not opinions. "$38.3M Adjusted EBITDA" is a fact. "Strong quarter" is an opinion.
- Include the most important financial metrics: revenue, EBITDA, net income, free cash flow, margins, debt levels, cash position, guidance ranges.
- Capture management's own forward-looking language when it contains specifics (growth targets, sensitivity formulas, expected timelines).
- Flag material risks: covenant breaches, going-concern language, litigation exposure, customer concentration.
- For 10-K/10-Q: prioritize MD&A, financial highlights, and risk factors.
- For 8-K: focus on the material event — what happened and why it matters.
- Always include actual numbers. "Revenue grew" is useless. "Revenue grew 21.2% YoY to $1.05B" is useful.

Respond with a JSON array of objects. No markdown, no explanation — just the JSON array.`;

async function generateFilingText(prompt: string, maxTokens = 4000): Promise<string> {
  // Gemini first — 1M context handles 60K filing text easily, free tier
  if (process.env.GEMINI_API_KEY) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 45000);
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(process.env.GEMINI_API_KEY)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0, maxOutputTokens: maxTokens, thinkingConfig: { thinkingBudget: 0 } },
          }),
          signal: controller.signal,
        }
      );
      if (res.ok) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const data: any = await res.json();
        const raw = (data?.candidates?.[0]?.content?.parts || []).map((p: { text?: string }) => p.text || "").join("");
        const text = stripThinkBlocks(raw).trim();
        if (text) { clearTimeout(timer); return text; }
      }
    } catch { /* fall through */ }
    clearTimeout(timer);
  }

  // Groq — llama-3.3-70b with proper token limit for JSON extraction
  if (process.env.GROQ_API_KEY) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 45000);
    try {
      const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: "llama-3.3-70b-versatile", messages: [{ role: "user", content: prompt }], max_tokens: maxTokens, temperature: 0 }),
        signal: controller.signal,
      });
      if (res.ok) {
        const data = await res.json() as { choices: { message: { content: string } }[] };
        const text = stripThinkBlocks(data?.choices?.[0]?.message?.content || "").trim();
        if (text) { clearTimeout(timer); return text; }
      }
    } catch { /* fall through */ }
    clearTimeout(timer);
  }

  // Cerebras
  if (process.env.CEREBRAS_API_KEY) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 45000);
    try {
      const res = await fetch("https://api.cerebras.ai/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${process.env.CEREBRAS_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: "llama-3.3-70b", messages: [{ role: "user", content: prompt }], max_tokens: maxTokens, temperature: 0 }),
        signal: controller.signal,
      });
      if (res.ok) {
        const data = await res.json() as { choices: { message: { content: string } }[] };
        const text = stripThinkBlocks(data?.choices?.[0]?.message?.content || "").trim();
        if (text) { clearTimeout(timer); return text; }
      }
    } catch { /* fall through */ }
    clearTimeout(timer);
  }

  // Anthropic Haiku — last resort (costs ~$0.005)
  if (process.env.ANTHROPIC_API_KEY) {
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: 60000 });
    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: maxTokens,
      temperature: 0,
      messages: [{ role: "user", content: prompt }],
    });
    return response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
  }
  throw new Error("No AI provider configured");
}

async function extractInsights(
  filingText: string,
  ticker: string,
  filingType: string,
  filingDate: string
): Promise<FilingInsight[]> {
  const userPrompt = `Filing: ${filingType} for ${ticker}, filed ${filingDate}

FILING TEXT (truncated to key sections):
${filingText.slice(0, 60000)}

Extract the structured insights as a JSON array.`;

  let text: string;
  try {
    // Free cascade (Gemini→Groq→Cerebras→Haiku) handles all filing types including 10-K/10-Q.
    // Gemini 2.5 Flash has 1M context and handles structured financial extraction well.
    text = await generateFilingText(EXTRACTION_PROMPT + "\n\n" + userPrompt, 4000);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("credit balance")) throw new Error("AI_CREDITS_LOW");
    throw err;
  }

  try {
    const match = text.match(/\[[\s\S]*\]/);
    if (!match) return [];
    const parsed = JSON.parse(match[0]) as FilingInsight[];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((i) => i && i.category && i.fact)
      .map((i) => ({
        category: String(i.category).toLowerCase().replace(/\s+/g, "_"),
        fact: String(i.fact).slice(0, 500),
        numeric_value: typeof i.numeric_value === "number" && Number.isFinite(i.numeric_value) ? i.numeric_value : null,
        quote: i.quote ? String(i.quote).slice(0, 200) : null,
        source_section: i.source_section ? String(i.source_section).slice(0, 100) : null,
      }));
  } catch {
    return [];
  }
}

type UserContext = {
  shares?: number;
  avg_cost?: number;
  current_price?: number;
  market_cap?: number;
  currency?: string;
  thesis?: string;
};

type Interpretation = {
  thesis_impact: "CONFIRMS" | "CONTRADICTS" | "NEUTRAL" | "MIXED";
  summary: string;
  key_insight: string;
  valuation_note: string | null;
};

const INTERPRET_PROMPT = `You are a financial analyst interpreting SEC filing facts for a specific investor. You have:
1. Structured facts extracted from the filing
2. The investor's position (cost basis, shares) and thesis

Your job: tell them WHAT THIS MEANS FOR THEIR POSITION. Not what the filing says — what it MEANS.

Rules:
- Lead with the thesis verdict: does this filing CONFIRM, CONTRADICT, or leave NEUTRAL their thesis? Or is it MIXED?
- Give a specific "key insight" — the one derived calculation or comparison that matters most (e.g. "$6.45B liquid assets vs $6.7B market cap = you're getting QNX for free")
- Include a valuation note if the numbers let you derive one (price-to-book, EV/EBITDA from the filing, cash per share vs price, etc.)
- Use their cost basis to frame risk: "At your $X.XX avg cost, you're paying Y% above/below book value"
- Be direct and opinionated. "Revenue beat by 3%" is data. "Revenue beat confirms your growth thesis and the stock is still trading at a discount to the implied run-rate" is intelligence.
- If facts contradict the thesis, say so clearly — don't soften it.

Respond with a JSON object:
{
  "thesis_impact": "CONFIRMS" | "CONTRADICTS" | "NEUTRAL" | "MIXED",
  "summary": "2-4 sentences: what this filing means for the investor's position and thesis",
  "key_insight": "The single most important derived insight — the 'so what' number or comparison",
  "valuation_note": "A valuation-derived observation if possible, or null"
}

No markdown, no explanation — just the JSON object.`;

async function interpretForUser(
  insights: FilingInsight[],
  ticker: string,
  filingType: string,
  ctx: UserContext
): Promise<Interpretation | null> {
  if (!insights.length) return null;

  const factsBlock = insights.map(i =>
    `[${i.category}] ${i.fact}${i.numeric_value != null ? ` (${i.numeric_value})` : ''}`
  ).join("\n");

  const posBlock = [
    ctx.shares ? `Shares held: ${ctx.shares}` : null,
    ctx.avg_cost ? `Avg cost: $${ctx.avg_cost}` : null,
    ctx.current_price ? `Current price: $${ctx.current_price}` : null,
    ctx.market_cap ? `Market cap: $${(ctx.market_cap / 1e9).toFixed(2)}B` : null,
    ctx.currency ? `Currency: ${ctx.currency}` : null,
    ctx.thesis ? `Investor thesis: "${ctx.thesis}"` : null,
  ].filter(Boolean).join("\n");

  const userPrompt = `Ticker: ${ticker} (${filingType})

EXTRACTED FACTS:
${factsBlock}

INVESTOR CONTEXT:
${posBlock || "No position details provided"}

Interpret these facts for this investor. JSON object only.`;

  try {
    const text = await generateFilingText(INTERPRET_PROMPT + "\n\n" + userPrompt, 1500);

    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]);
    return {
      thesis_impact: ["CONFIRMS", "CONTRADICTS", "NEUTRAL", "MIXED"].includes(parsed.thesis_impact)
        ? parsed.thesis_impact : "NEUTRAL",
      summary: String(parsed.summary || "").slice(0, 600),
      key_insight: String(parsed.key_insight || "").slice(0, 300),
      valuation_note: parsed.valuation_note ? String(parsed.valuation_note).slice(0, 300) : null,
    };
  } catch {
    return null;
  }
}

async function storeInsights(
  ticker: string,
  filingType: string,
  filingDate: string,
  accession: string,
  insights: FilingInsight[]
): Promise<number> {
  if (!insights.length) return 0;
  const sb = serviceClient();
  const rows = insights.map((i) => ({
    ticker: ticker.toUpperCase(),
    filing_type: filingType,
    filing_date: filingDate,
    accession,
    category: i.category,
    fact: i.fact,
    numeric_value: i.numeric_value,
    quote: i.quote,
    source_section: i.source_section,
  }));

  const { error } = await sb.from("filing_insights").upsert(rows, {
    onConflict: "accession,category,fact",
    ignoreDuplicates: true,
  });
  if (error) {
    console.error("[filing-reader] store error:", error.message);
    return 0;
  }
  return rows.length;
}

function insightsToSignals(ticker: string, insights: FilingInsight[], filingType: string): ObservationInput[] {
  const signals: ObservationInput[] = [];
  for (const i of insights) {
    if (i.numeric_value == null) continue;
    const signalType = `filing_${i.category}`;
    signals.push({
      signal_type: signalType,
      numeric_value: i.numeric_value,
      value: { fact: i.fact, filing_type: filingType, category: i.category },
      source: "SEC EDGAR",
      trust_tier: "authoritative",
    });
  }
  return signals;
}

export async function POST(request: Request) {
  try {
  if (!(await isFeatureAllowed("filing_reader"))) {
    return NextResponse.json(
      { error: "Filing Intelligence requires Pro. Upgrade to unlock.", tier_required: "pro" },
      { status: 403 }
    );
  }

  void logUsage("filing-reader");

  let body: { ticker?: string; accession?: string; filingType?: string; filingDate?: string;
    contentUrl?: string;
    shares?: number; avg_cost?: number; current_price?: number; market_cap?: number; currency?: string; thesis?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const { ticker, accession, filingType, filingDate } = body;
  const userCtx: UserContext | null = (body.shares || body.thesis || body.current_price)
    ? { shares: body.shares, avg_cost: body.avg_cost, current_price: body.current_price,
        market_cap: body.market_cap, currency: body.currency, thesis: body.thesis }
    : null;
  if (!ticker || !accession) {
    return NextResponse.json({ error: "ticker and accession are required" }, { status: 400 });
  }

  const canonical = ticker.trim().toUpperCase();
  const type = filingType || "10-K";
  const date = filingDate || new Date().toISOString().slice(0, 10);

  // Check cache — a filing is immutable, so insights are forever
  const sb = serviceClient();
  const { data: existing } = await sb
    .from("filing_insights")
    .select("category, fact, numeric_value, quote, source_section")
    .eq("accession", accession)
    .limit(20);

  if (existing && existing.length > 0) {
    const interp = userCtx ? await interpretForUser(existing, canonical, type, userCtx) : null;
    return NextResponse.json({
      ticker: canonical,
      filing_type: type,
      filing_date: date,
      accession,
      insights: existing,
      interpretation: interp,
      cached: true,
    });
  }

  // Fetch the filing from EDGAR — prefer contentUrl (from sec-filings primaryDocument)
  const docUrl = body.contentUrl || await fetchFilingIndex(accession);
  if (!docUrl) {
    return NextResponse.json({ error: "Could not locate filing document on EDGAR" }, { status: 404 });
  }

  let rawHtml = "";
  try {
    const res = await fetch(docUrl, { headers: SEC_HEADERS });
    if (!res.ok) {
      return NextResponse.json({ error: `EDGAR returned ${res.status}` }, { status: 502 });
    }
    rawHtml = await res.text();
  } catch (e) {
    return NextResponse.json({ error: `Failed to fetch filing: ${e instanceof Error ? e.message : String(e)}` }, { status: 502 });
  }

  const is10 = type === "10-K" || type === "10-Q";
  const filingText = is10 ? extractFinancialSectionsForReader(rawHtml) : stripHtml(rawHtml, 80000);
  if (filingText.length < 200) {
    return NextResponse.json({ error: "Filing text too short to extract insights" }, { status: 422 });
  }

  // Extract insights via Sonnet
  const insights = await extractInsights(filingText, canonical, type, date);
  if (!insights.length) {
    return NextResponse.json({ error: "No insights could be extracted from this filing" }, { status: 422 });
  }

  // Store to filing_insights table
  const stored = await storeInsights(canonical, type, date, accession, insights);

  // Pipe numeric facts to nexus_signal_observations as Tier-1
  const signals = insightsToSignals(canonical, insights, type);
  if (signals.length > 0) {
    void recordSignalObservations(canonical, signals);
  }

  const interp = userCtx ? await interpretForUser(insights, canonical, type, userCtx) : null;

  return NextResponse.json({
    ticker: canonical,
    filing_type: type,
    filing_date: date,
    accession,
    insights,
    interpretation: interp,
    stored,
    cached: false,
  });
  } catch (err) {
    console.error("[filing-reader] unhandled POST error:", err);
    const raw = err instanceof Error ? err.message : String(err);
    const isCredits = raw === "AI_CREDITS_LOW" || raw.includes("credit balance");
    if (isCredits) void autoDowngradeOnCreditDepletion();
    const friendly = isCredits
      ? "AI credits depleted — filing analysis temporarily unavailable."
      : raw.includes("timeout") || raw.includes("ETIMEDOUT")
        ? "Filing analysis timed out — try again."
        : "Could not analyze this filing right now.";
    return NextResponse.json({ error: friendly }, { status: 500 });
  }
}

// GET: retrieve cached insights for a ticker (used by X-Ray)
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const ticker = searchParams.get("ticker")?.trim().toUpperCase();
  if (!ticker) {
    return NextResponse.json({ error: "ticker is required" }, { status: 400 });
  }

  const limit = Math.min(Number(searchParams.get("limit") || "15"), 30);

  const sb = serviceClient();
  const { data, error } = await sb
    .from("filing_insights")
    .select("category, fact, numeric_value, quote, source_section, filing_type, filing_date, accession")
    .eq("ticker", ticker)
    .order("filing_date", { ascending: false })
    .limit(limit);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({
    ticker,
    insights: data || [],
    count: data?.length || 0,
  });
}
