// ════════════════════════════════════════════════════════════════════════════════════════════
// Pre-revenue OVERALL score — the asset-QUALITY grade for a cash-burning, no-revenue stock (P0/Gate1).
// ════════════════════════════════════════════════════════════════════════════════════════════
// THE RULE (owner, explicit): this is the OVERALL/quality axis, and it must NEVER let a speculative
// pre-revenue name outrank a real company. A pre-revenue business is unproven, so its overall score
// is hard-CAPPED below the "good company" band (≥7). Within that capped band it still discriminates
// hard: a well-funded explorer with years of runway scores near the top (~6); a near-bankrupt one
// scores ~1. Good vs bad pre-revenue separates clearly — without diluting the X-Ray score.
//
// This is NOT the "setup" score. Whether it's a good ENTRY right now (oversold, catalyst near, TA) is
// a SEPARATE axis that can legitimately run hotter than a blue-chip. Quality ≠ opportunity. This file
// only answers "how sound is this speculative asset?", capped — never "is now a good time to buy?".
//
// Deterministic, $0, no AI. Pure — unit tested. The dominant signal is SURVIVAL: a pre-revenue
// company's whole job is to live long enough (without crippling dilution) to prove its thesis, so
// cash runway + balance-sheet strength carry the score.

// Firm ceiling: the best possible pre-revenue overall score. Kept strictly below the proven-company
// "good" band (≥7) so quality ranking across stocks stays intact. A great explorer tops out here.
export const PREREV_SCORE_CAP = 6.0;

export type PreRevInputs = {
  runwayMonths: number | null; // months of cash left at current burn (computed by the caller)
  netCash: number | null;      // total cash − total debt (the cushion; >0 = cash-rich)
  totalCash: number | null;
  marketCap: number | null;
  dayChangePct: number | null; // light market-validation signal
};

export type PreRevScore = {
  score: number;               // 0..PREREV_SCORE_CAP — the capped overall quality grade
  components: Array<{ label: string; value: number }>; // 0..10 bars for the breakdown UI
};

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));

/**
 * Compute the capped pre-revenue overall (quality) score + its component bars.
 * Internal points sum to 100, then map onto [0, PREREV_SCORE_CAP]. Returns null only when there is
 * genuinely nothing to judge (no runway, no balance-sheet signal at all) — the caller then shows N/A.
 */
export function computePreRevScore(i: PreRevInputs): PreRevScore | null {
  const hasRunway = i.runwayMonths != null && isFinite(i.runwayMonths);
  const hasBalance = i.netCash != null || i.totalCash != null;
  if (!hasRunway && !hasBalance) return null; // nothing to judge → caller shows N/A

  // ── Survival / runway (0–50): the backbone. Can it live to prove the thesis without diluting? ──
  let runwayPts: number;
  if (hasRunway) {
    const m = i.runwayMonths as number;
    runwayPts = m >= 24 ? 50 : m >= 18 ? 42 : m >= 12 ? 33 : m >= 6 ? 20 : m >= 3 ? 9 : 3;
  } else {
    runwayPts = 22; // unknown burn → neutral
  }

  // ── Balance-sheet strength (0–30): net cash vs debt + cash cushion relative to market cap. ──
  let balancePts: number;
  if (i.netCash != null) {
    if (i.netCash > 0) {
      balancePts = 20;
      if (i.totalCash != null && i.marketCap && i.marketCap > 0) {
        const cushion = i.totalCash / i.marketCap;
        balancePts += cushion >= 0.4 ? 10 : cushion >= 0.2 ? 5 : 0;
      }
    } else {
      balancePts = 6; // carrying more debt than cash — fragile for a pre-revenue name
    }
  } else {
    balancePts = 12; // unknown
  }

  // ── Market validation (0–20): light — momentum as a soft proxy the market is pricing in progress. ──
  let marketPts = 8; // baseline so this axis never dominates
  if (i.dayChangePct != null) marketPts += i.dayChangePct > 0 ? 12 : 4;
  else marketPts += 6;
  marketPts = clamp(marketPts, 0, 20);

  const internal = runwayPts + balancePts + marketPts; // 0..100
  const score = Math.round((internal / 100) * PREREV_SCORE_CAP * 10) / 10;

  return {
    score: clamp(score, 0, PREREV_SCORE_CAP),
    components: [
      { label: "Survival & runway", value: Math.round((runwayPts / 50) * 10 * 10) / 10 },
      { label: "Balance-sheet strength", value: Math.round((balancePts / 30) * 10 * 10) / 10 },
      { label: "Market validation", value: Math.round((marketPts / 20) * 10 * 10) / 10 },
    ],
  };
}
