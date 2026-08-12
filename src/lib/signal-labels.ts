// ════════════════════════════════════════════════════════════════════════════════
// SIGNAL LABELS — deterministic, $0, shared across ALL AI surfaces.
//
// Every surface that passes context to an LLM (Intel Brief, Plainview Brief,
// Decide, thesis-check) calls these functions so the signals it receives are
// pre-interpreted identically. Consistency is enforced by architecture: one
// function, not four prompts kept in sync.
//
// Design rules:
//   - Deterministic: same inputs → same label, no randomness, no AI.
//   - Neutral by default: labels describe what the data shows, not what to think.
//     A "WEAK" score doesn't say "sell" — it says the fundamentals are a headwind.
//     A "RECOVERING" price action doesn't say "buy" — it says the trend is turning.
//   - Scalable: works for any ticker, sector, or asset class with whatever subset
//     of signals is available. Missing data → field omitted, never fabricated.
// ════════════════════════════════════════════════════════════════════════════════

import type { TechnicalData } from "@/lib/market-context";
import type { TickerObservation } from "@/lib/ticker-context";

// ─── 1. FINANCIAL STANDING (from X-Ray score) ────────────────────────────────
// Translates the 0-10 score into what it means for thesis execution.
// The AI receives a verdict it can report, not a raw number it has to interpret.
export function labelFinancialStanding(score: number | null): string | null {
  if (score === null || !Number.isFinite(score)) return null;
  if (score >= 7)   return `STRONG (${score.toFixed(1)}/10) — fundamentals broadly support thesis execution`;
  if (score >= 5)   return `AVERAGE (${score.toFixed(1)}/10) — neither a clear tailwind nor headwind; execution risk matters`;
  if (score >= 3)   return `WEAK (${score.toFixed(1)}/10) — fundamentals are a meaningful headwind the thesis must overcome`;
  return             `DISTRESSED (${score.toFixed(1)}/10) — significant financial concerns; thesis requires a specific near-term catalyst`;
}

// ─── 2. PRICE ACTION (from technical data + current price) ───────────────────
// Covers trend (MA position), momentum direction (MA slope), sentiment (RSI),
// and participation (volume ratio). Each piece is independently optional so the
// label degrades gracefully for tickers with thin data (foreign listings, micro-caps).
export function labelPriceAction(ta: TechnicalData, currentPrice: number | null): string | null {
  const parts: string[] = [];

  // MA position — where is price relative to the trend lines?
  if (currentPrice && ta.ma50 && ta.ma200) {
    const above50  = currentPrice > ta.ma50;
    const above200 = currentPrice > ta.ma200;
    if (above50 && above200)   parts.push("price above both MAs — established uptrend");
    else if (above50)          parts.push("price above 50-day but below 200-day — recovering from downtrend");
    else if (above200)         parts.push("price below 50-day but above 200-day — short-term pullback in longer uptrend");
    else                       parts.push("price below both MAs — in downtrend");
  } else if (currentPrice && ta.ma50) {
    parts.push(currentPrice > ta.ma50 ? "price above 50-day MA" : "price below 50-day MA");
  }

  // MA slope — is the trend accelerating, flattening, or rolling over?
  if (ta.ma50Slope !== null) {
    const slope = ta.ma50Slope;
    if (slope > 0.003)        parts.push("50-day MA rising (momentum building)");
    else if (slope > 0.0005)  parts.push("50-day MA slowly rising (gentle upturn)");
    else if (slope < -0.003)  parts.push("50-day MA falling (trend deteriorating)");
    else if (slope < -0.0005) parts.push("50-day MA slowly falling (weakening)");
    else                      parts.push("50-day MA flat (no directional trend)");
  }

  // RSI — momentum / overbought-oversold positioning
  if (ta.rsi !== null) {
    const rsi = ta.rsi;
    if (rsi >= 70)      parts.push(`RSI ${rsi.toFixed(0)} — overbought (extended, caution on new entries)`);
    else if (rsi >= 55) parts.push(`RSI ${rsi.toFixed(0)} — bullish momentum`);
    else if (rsi >= 45) parts.push(`RSI ${rsi.toFixed(0)} — neutral`);
    else if (rsi >= 30) parts.push(`RSI ${rsi.toFixed(0)} — weakening momentum`);
    else                parts.push(`RSI ${rsi.toFixed(0)} — oversold (potential setup if thesis is intact)`);
  }

  // Volume ratio — is money actually moving into/out of this stock?
  if (ta.currentVolume && ta.avgVolume && ta.avgVolume > 0) {
    const ratio = ta.currentVolume / ta.avgVolume;
    if (ratio >= 2.0)        parts.push(`volume ${ratio.toFixed(1)}× average — strong interest`);
    else if (ratio >= 1.4)   parts.push(`volume ${ratio.toFixed(1)}× average — elevated activity`);
    else if (ratio <= 0.4)   parts.push(`volume ${ratio.toFixed(1)}× average — very low participation`);
    else if (ratio <= 0.7)   parts.push(`volume ${ratio.toFixed(1)}× average — below-average conviction`);
    // near-average volume: not noteworthy, omit
  }

  return parts.length ? parts.join("; ") : null;
}

// ─── 3. SCORE TREND (from NEXUS observation log) ─────────────────────────────
// Shows whether the business fundamentals have been improving or deteriorating
// over the observation window — the turnaround signal. Deterministic: computed
// from the hive-mind daily score log, not AI-inferred.
//
// Minimum 5 scored observations to produce a label; fewer = not enough history.
export function labelScoreTrend(observations: TickerObservation[]): string | null {
  const scored = observations.filter(o => o.score != null && Number.isFinite(o.score));
  if (scored.length < 5) return null;

  // Use a 90-day window (or full history if shorter) to avoid noise from a single bad day.
  const window = scored.slice(-Math.min(scored.length, 90));
  const first = window[0].score!;
  const last  = window[window.length - 1].score!;
  const delta = last - first;
  const days  = window.length;

  if (delta >= 1.0)       return `IMPROVING — X-Ray score up +${delta.toFixed(1)} over ${days} observations (trend supportive of thesis)`;
  if (delta >= 0.4)       return `SLOWLY IMPROVING — X-Ray score up +${delta.toFixed(1)} over ${days} observations`;
  if (delta <= -1.0)      return `DETERIORATING — X-Ray score down ${delta.toFixed(1)} over ${days} observations (headwind to thesis)`;
  if (delta <= -0.4)      return `SLOWLY DETERIORATING — X-Ray score down ${delta.toFixed(1)} over ${days} observations`;
  return                   `STABLE — X-Ray score steady around ${last.toFixed(1)} over ${days} observations`;
}

// ─── COMPOSITE BLOCK (convenience wrapper) ───────────────────────────────────
// Returns a pre-formatted evidence section ready to inject into any AI prompt.
// Omits any dimension for which data is unavailable — never fabricates.
export function buildSignalBlock(opts: {
  score: number | null;
  technicals: TechnicalData;
  currentPrice: number | null;
  observations: TickerObservation[];
}): string | null {
  const lines: string[] = [];

  const standing = labelFinancialStanding(opts.score);
  if (standing) lines.push(`Financial standing: ${standing}`);

  const trend = labelScoreTrend(opts.observations);
  if (trend) lines.push(`Business trend (NEXUS history): ${trend}`);

  const price = labelPriceAction(opts.technicals, opts.currentPrice);
  if (price) lines.push(`Price action: ${price}`);

  return lines.length ? lines.join("\n") : null;
}
