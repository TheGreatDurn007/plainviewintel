// Figure provenance check — the deterministic guard that makes Intel briefs "credible by
// construction" instead of "credible by prompt-hope."
//
// The Intel brief is AI prose. No matter how many prompt rules forbid it, a model will
// occasionally launder a number from the investor's OWN notes or from a prior Plainview brief
// into "What changed"/"Next catalyst" as though it were a freshly-sourced fact (the FDY "$30M
// private placement" leak; the SNBR/CAN class). Prompt rules reduce this; they cannot prevent it.
//
// So we VERIFY the output: every monetary/percentage figure the brief states must trace back to
// the ADMISSIBLE evidence set (sourced facts only — news, SEC, financials, X-Ray, technicals,
// analyst targets). The investor's own notes and prior-brief memory are NOT admissible — they are
// exactly the contamination sources, so they are excluded from `admissibleText` by the caller.
//
// Output is advisory: a list of figures that don't trace back. The caller decides what to do with
// it (shadow-log first; surface an "unverified figures" badge once the false-positive rate is known).
// This file has ZERO side effects and never throws — pure string in, structured result out.

export type FigureKind = "currency" | "percent";

export interface ExtractedFigure {
  raw: string;        // the text as it appeared, e.g. "$30 million", "+21%"
  kind: FigureKind;
  value: number;      // normalized magnitude: currency in absolute dollars; percent as the number before %
}

export interface FigureAudit {
  total: number;              // figures examined in the brief
  unverified: ExtractedFigure[]; // figures with no match in the admissible evidence
}

const MULTIPLIER: Record<string, number> = {
  k: 1e3, thousand: 1e3,
  m: 1e6, mm: 1e6, million: 1e6,
  b: 1e9, bn: 1e9, billion: 1e9,
  t: 1e12, trillion: 1e12,
};

// Matches "$30 million", "$30M", "$120 million", "$7.50", "C$5.10", "US$1.2bn", "950M" (with unit),
// and standalone percentages "+21%", "12.5 %". Bare integers/years (e.g. "2026", "551 meters") are
// intentionally NOT matched — too noisy and rarely the kind of fabricated financial claim we guard.
const CURRENCY_RE = /(?:US|C|A|CA|CAD|USD|AUD)?\s?[$€£]\s?(\d[\d,]*(?:\.\d+)?)\s?(thousand|million|billion|trillion|mm|bn|[kmbt])?\b/gi;
const PERCENT_RE = /([+\-]?\d[\d,]*(?:\.\d+)?)\s?%/g;

function toNumber(numStr: string, unit?: string | null): number {
  const n = parseFloat(numStr.replace(/,/g, ""));
  if (!isFinite(n)) return NaN;
  const mult = unit ? (MULTIPLIER[unit.toLowerCase()] ?? 1) : 1;
  return n * mult;
}

export function extractFigures(text: string): ExtractedFigure[] {
  if (!text) return [];
  const out: ExtractedFigure[] = [];
  let m: RegExpExecArray | null;

  CURRENCY_RE.lastIndex = 0;
  while ((m = CURRENCY_RE.exec(text)) !== null) {
    const value = toNumber(m[1], m[2]);
    if (isFinite(value)) out.push({ raw: m[0].trim(), kind: "currency", value });
  }

  PERCENT_RE.lastIndex = 0;
  while ((m = PERCENT_RE.exec(text)) !== null) {
    const value = Math.abs(toNumber(m[1]));
    if (isFinite(value)) out.push({ raw: m[0].trim(), kind: "percent", value });
  }

  return out;
}

// Two magnitudes "match" within a small relative tolerance so that "$120 million" verifies against
// "$120.4M" and rounding in the prose doesn't trip a false alarm. 1.5% relative (or tiny absolute
// for small numbers) is loose enough for rounding, tight enough that $30M ≠ $73M/$100M.
function near(a: number, b: number): boolean {
  if (a === b) return true;
  const diff = Math.abs(a - b);
  const tol = Math.max(Math.abs(a), Math.abs(b)) * 0.015;
  return diff <= tol || diff <= 0.01;
}

// Audits the brief's figures against the admissible evidence. A brief figure is VERIFIED when a
// same-kind figure of (near-)equal magnitude appears anywhere in the admissible text. Anything that
// doesn't trace back is returned as `unverified` — the caller decides whether to badge or just log.
export function auditFigures(brief: string, admissibleText: string): FigureAudit {
  const briefFigs = extractFigures(brief);
  const evidenceFigs = extractFigures(admissibleText);
  const byKind = (k: FigureKind) => evidenceFigs.filter((f) => f.kind === k).map((f) => f.value);

  const unverified = briefFigs.filter((bf) => {
    const pool = byKind(bf.kind);
    return !pool.some((ev) => near(bf.value, ev));
  });

  // De-dupe by normalized (kind+value) so "$30 million" said twice is one finding.
  const seen = new Set<string>();
  const deduped = unverified.filter((f) => {
    const key = `${f.kind}:${f.value}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return { total: briefFigs.length, unverified: deduped };
}
