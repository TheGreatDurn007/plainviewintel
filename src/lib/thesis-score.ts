// NEXUS-THESIS — Phase 1 deterministic scorer.
//
// Implements §2.1 (Evidence), §2.4 (Contradiction) and §5 (Critical-Unknown-lite) of NEXUS-THESIS.md.
// Pure + deterministic: given the decomposed thesis claims and the SOURCES fetched for each, the scores
// are computed in code with NO LLM judgment — same inputs → same scores, every time. The LLM only ever
// extracted the claims and fetched the sources; the weighting and the verdict are arithmetic here.
//
// Phase 1 deliberately scores only what's deterministic + free: is each claim backed, by how strong a
// source, and what's the load-bearing unverified one. Logic + Magnitude (the judged pillars) are Phase 2/3.

export type ClaimSource = { kind: "edgar" | "news"; source: string; title: string; date: string };
export type ScoredClaim = {
  type: string;
  raw: string;
  weight: number;          // claim importance (catalyst weight from extractClaims, ~5–9)
  bestTierWeight: number;  // 0..1 — reliability of the best backing source found
  bestSource: string | null;
  verified: boolean;       // has credible backing (bestTierWeight ≥ VERIFY_THRESHOLD)
};
export type OpposingFact = { text: string; tierWeight: number };

// A claim with no source at or above this reliability is "unverified" (counts 0 toward Evidence, and is a
// Critical-Unknown candidate). 0.4 sits above financial-media (0.30) and below PR/press (0.55).
const VERIFY_THRESHOLD = 0.4;

// Source → reliability weight (NEXUS-THESIS §2.1). A reputable headline that STATES a confirmed event IS
// evidence for that event, so legitimate NEWS counts (0.45, above the 0.4 verify bar); only forums / social
// / content-farms are "weak". (Previously any source not in a hardcoded major-outlet list fell to 0.05 →
// real press like The Business Journals / FOX / Yahoo wrongly read as "unverified". Inverted here.)
const PR_WIRE = /\b(globe\s?newswire|business\s?wire|pr\s?newswire|prnewswire|accesswire|newswire)\b/i;
const STRONG_PRESS = /\b(reuters|bloomberg|wall street journal|wsj|financial times|\bft\b|barron'?s|cnbc|associated press|\bap\b|the economist|forbes|marketwatch|dow jones|cnn|nbc|abc news|cbs|\bfox\b|fox\s*\d|business journal|the verge|techcrunch|axios|politico|the guardian|new york times|washington post)\b/i;
const WEAK_SRC = /\b(reddit|stocktwits|wallstreetbets|wsb|4chan|discord|telegram|twitter|x\.com|facebook|message board|forum|fool\.com\/community|comment)\b/i;

export function tierWeightForSource(kind: string, source: string): { w: number; label: string } {
  if (kind === "edgar") return { w: 1.0, label: "SEC/EDGAR filing" };
  const s = source || "";
  if (PR_WIRE.test(s)) return { w: 0.6, label: "company newswire" };
  if (STRONG_PRESS.test(s)) return { w: 0.65, label: "reputable press" };
  if (WEAK_SRC.test(s)) return { w: 0.1, label: "forum/social" };
  if (s.trim()) return { w: 0.5, label: "news" };        // any other named news source confirms a qualitative event
  return { w: 0.05, label: "no source" };
}

// Tier the SOURCE cited at the end of an evidence point ("… (Business Journals, 2026-06-12)") — so the
// scorecard's Evidence/Opposition are scored from the SAME ▲▼ points the user sees, not a separate pipeline.
export function parsePointTier(evidence: string): number {
  const m = evidence.match(/\(([^)]*)\)\s*$/);
  let src = m ? m[1] : "";
  src = src.replace(/,?\s*\d{4}-\d{2}-\d{2}.*$/, "").replace(/,\s*$/, "").trim();
  if (!src) return 0.5; // no explicit source on the point but the LLM asserted it from the facts packet
  if (/^(facts?|computed|data|technical data|analyst consensus|market data)$/i.test(src)) return 0.55; // derived/hard data
  if (/\b(sec|edgar|10-?[kq]\b|8-?k\b|form\s*4|filing|sedar)\b/i.test(src)) return 1.0;
  return tierWeightForSource("news", src).w;
}

// Turn the LLM's classified evidence POINTS into scored claims (supports = backed, missing = the unverified
// load-bearing claim). One source of truth → the scorecard can never disagree with the points list shown.
// ── DETERMINISTIC IDENTITY GUARD ─────────────────────────────────────────────────────────────────────
// A ticker can collide across exchanges (MAG = Magnite US vs MAG Silver; USA = a US fund vs Americas Gold;
// TRX = TRON vs TRX Gold). If symbol resolution picks the WRONG listing, the engine analyzes the wrong
// company and presents it as truth — the worst possible failure. The user's holding already carries the
// RIGHT company name, so compare it to the name the data resolved to: clearly different → flag, never
// silently analyze. Conservative (a missed company-alias only costs a soft "verify the listing" notice).
function normalizeCompanyTokens(n: string): string[] {
  return (n || "")
    .toLowerCase()
    .replace(/[.,&'"()/-]/g, " ")
    .replace(/\b(inc|incorporated|corp|corporation|ltd|limited|plc|sa|nv|ag|co|company|companies|holdings?|group|the|class|series|common|stock|shares?|ordinary|adr|reit|trust|lp|llc|spa|ab|oyj|asa|nl)\b/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 2);
}
// True when the user's company name and the resolved data's company name are LIKELY different companies.
export function isLikelyDifferentCompany(userName: string | null | undefined, resolvedName: string | null | undefined): boolean {
  if (!userName || !resolvedName) return false;
  const a = normalizeCompanyTokens(userName), b = normalizeCompanyTokens(resolvedName);
  if (!a.length || !b.length) return false;
  if (a.some((t) => b.includes(t))) return false; // a shared exact token → same company (NVIDIA / NVIDIA Corp)
  // First-token strong prefix (≥4 shared leading chars) → same (handles abbreviations / formatting drift).
  const x = a[0], y = b[0];
  if (x.length >= 4 && y.length >= 4 && (x.startsWith(y.slice(0, 4)) || y.startsWith(x.slice(0, 4)))) return false;
  return true; // no shared token, no strong prefix overlap → likely a different company (wrong listing)
}

export function pointsToClaims(points: { evidence: string; effect: string }[]): ScoredClaim[] {
  const out: ScoredClaim[] = [];
  for (const p of points || []) {
    const eff = (p.effect || "").toLowerCase();
    // The computed magnitude/consensus point ("target is within consensus … (computed)") is a PRICE-target
    // plausibility check, NOT a sourced fact confirming the thesis's catalyst. It belongs to the Magnitude
    // pillar, not Evidence. Counting it as a ✓ claim let a thin-retrieval thesis (no real facts found) read
    // "Partly supported" off arithmetic alone (MAG bug). Exclude it from evidence scoring.
    if (/\(computed\)\s*$/i.test(p.evidence)) continue;
    const raw = String(p.evidence || "").replace(/\s*\([^)]*\)\s*$/, "").trim();
    if (!raw) continue;
    if (eff === "supports") { const w = parsePointTier(p.evidence); out.push({ type: "point", raw, weight: 6, bestTierWeight: w, bestSource: null, verified: w >= VERIFY_THRESHOLD }); }
    else if (eff === "missing") { out.push({ type: "point", raw, weight: 8, bestTierWeight: 0, bestSource: null, verified: false }); }
  }
  return out;
}

export function scoreClaim(claim: { type: string; raw: string; weight: number }, sources: ClaimSource[]): ScoredClaim {
  let bestW = 0;
  let bestLabel: string | null = null;
  for (const src of sources) {
    const t = tierWeightForSource(src.kind, src.source);
    if (t.w > bestW) { bestW = t.w; bestLabel = t.label; }
  }
  return { type: claim.type, raw: claim.raw, weight: claim.weight, bestTierWeight: bestW, bestSource: bestLabel, verified: bestW >= VERIFY_THRESHOLD };
}

// Evidence Score 0–10 = weighted claim coverage (mean best-tier weight across the thesis's claims).
export function evidenceScore(claims: ScoredClaim[]): { score: number; backed: number; total: number } {
  if (!claims.length) return { score: 0, backed: 0, total: 0 };
  const coverage = claims.reduce((s, c) => s + c.bestTierWeight, 0) / claims.length; // 0..1
  return { score: Math.round(coverage * 100) / 10, backed: claims.filter((c) => c.verified).length, total: claims.length };
}

// Contradiction Score 0–10 = 10 − weighted opposing evidence (10 = no quality opposition found).
export function contradictionScore(opposing: OpposingFact[]): { score: number } {
  const opp = opposing.reduce((s, o) => s + o.tierWeight, 0);
  return { score: Math.round(Math.max(0, 10 - opp * 3.5) * 10) / 10 };
}

// Critical-Unknown-lite (§5, Phase-1 form): the highest-importance claim that has NO credible backing —
// the load-bearing thing the thesis rests on that isn't yet confirmed.
export function criticalUnknownLite(claims: ScoredClaim[]): ScoredClaim | null {
  const unv = claims.filter((c) => !c.verified).sort((a, b) => b.weight - a.weight)[0];
  return unv || null;
}

// Phase-1 verdict — evidence + contradiction ONLY (Logic/Magnitude are Phase 2/3), so it speaks to how
// well-EVIDENCED the thesis is, not whether it's "supported" (which needs the reasoning pillars).
export function phase1Verdict(ev: number, con: number, hasClaims: boolean, coreVerified: boolean): string {
  if (!hasClaims) return "Insufficient — no specific, checkable claims to test yet.";
  if (con <= 3) return "Contradicted — hard evidence works against this thesis.";
  // The load-bearing (highest-weight) claim being unconfirmed caps the verdict — a verified side-fact can't
  // make a thesis "well-evidenced" when the thing it actually rests on is unverified.
  if (!coreVerified) return "Partly evidenced — the thesis's core claim isn't confirmed by any credible source (see the critical unknown).";
  if (ev >= 6.5) return "Well-evidenced — the thesis's core claims are backed by credible sources.";
  if (ev >= 3.5) return "Partly evidenced — some claims are confirmed, the rest are unverified.";
  return "Thinly evidenced — the thesis rests on claims no credible source confirms.";
}

// ── §2.3 MAGNITUDE — historical-plausibility band, NEVER a kill switch ───────────────────────────────
// Deterministic band lookup over (computed annualized implied move) × (judged catalyst materiality). The
// only judged input is materiality; the move and the band are pure arithmetic. A low score flags a target
// as "aggressive", it does NOT mark the thesis false (that's Evidence/Contradiction's job).
export type MagnitudeResult = { score: number; annualizedPct: number; materiality: string; horizonMonths: number; label: string };
const MAG_BANDS: Record<string, number[]> = {
  transformational: [9, 8, 6, 4],
  significant: [8, 6, 4, 2],
  incremental: [6, 4, 2, 1],
  negligible: [3, 2, 1, 0],
};
// Parse a horizon in MONTHS from the thesis text (range → midpoint); default 12 — to annualize the move.
export function parseHorizonMonths(thesis: string): number {
  const t = (thesis || "").toLowerCase();
  let m = t.match(/(\d{1,2})\s*(?:-|–|—|to)\s*(\d{1,2})\s*month/);
  if (m) return Math.max(1, (parseInt(m[1]) + parseInt(m[2])) / 2);
  m = t.match(/(\d{1,2})\s*month/);
  if (m) return Math.max(1, parseInt(m[1]));
  m = t.match(/(\d{1,2})\s*(?:-|–|—|to)\s*(\d{1,2})\s*year/);
  if (m) return Math.max(1, ((parseInt(m[1]) + parseInt(m[2])) / 2) * 12);
  m = t.match(/(\d{1,2})\s*year/);
  if (m) return Math.max(1, parseInt(m[1]) * 12);
  return 12;
}
export function buildMagnitude(opts: { price: number | null; target: number | null; thesis: string; materiality: string | null }): MagnitudeResult | null {
  const price = opts.price && opts.price > 0 ? opts.price : null;
  const target = opts.target && opts.target > 0 ? opts.target : null;
  if (!price || !target) return null;
  const materiality = opts.materiality && MAG_BANDS[opts.materiality] ? opts.materiality : "significant"; // default if unjudged
  const months = parseHorizonMonths(opts.thesis);
  const annualized = ((target - price) / price) * 100 * (12 / months);
  const col = annualized < 25 ? 0 : annualized < 60 ? 1 : annualized < 150 ? 2 : 3;
  const score = MAG_BANDS[materiality][col];
  const plaus = score >= 7 ? "well within reach" : score >= 5 ? "ambitious but plausible" : score >= 3 ? "a stretch" : "a long shot";
  const label = `a ${materiality} catalyst, target implies ${annualized >= 0 ? "+" : ""}${Math.round(annualized)}%/yr — ${plaus} by historical precedent`;
  return { score, annualizedPct: Math.round(annualized), materiality, horizonMonths: months, label };
}

export type ThesisScorecard = {
  evidence: number;
  evidenceBacked: number;
  evidenceTotal: number;
  contradiction: number;
  verdict: string;
  criticalUnknown: string | null;
  criticalUnknownType: string | null;
  claims: { raw: string; type: string; verified: boolean; source: string | null }[];
  opposing: string[];
  coreVerified: boolean; // is the highest-weight (load-bearing) claim backed? — drives the verdict
  logic?: { score: number; chain: string[]; weakestLink: string } | null; // §2.2 — judged (smart tier), attached by the route
  magnitude?: MagnitudeResult | null; // §2.3 — band-scored plausibility, attached by the route (never kills a thesis)
  competing?: { explanation: string; discriminator: string } | null; // §5.1 — alternative story for the same facts + the discriminator
  context?: string[]; // neutral facts the engine retrieved but that neither back nor break the thesis — shown so nothing is silently hidden
  engine: "phase1";
};

// §4 — the verdict EMERGES from the scorecard PROFILE (a deterministic pattern-match), not from an LLM
// status. Gated like a decision tree: contradiction first, then broken logic, then the support patterns.
// Honors the constitution: Magnitude NEVER kills (low → "aggressive"); "unverified" ≠ "unsupported"
// (a forward-looking thesis with sound reasoning is "plausible but unconfirmed", not a failure).
export function deriveVerdict(sc: ThesisScorecard): string {
  if (!sc.evidenceTotal) return "Insufficient — no specific, checkable claims to test yet.";
  const ev = sc.evidence, con = sc.contradiction;
  const lg = sc.logic ? sc.logic.score : null;
  const mg = sc.magnitude ? sc.magnitude.score : null;
  const core = !!sc.coreVerified;
  if (con <= 3) return "Contradicted — hard evidence works against this thesis.";
  // No confirmed facts at all → unsupported (this OUTRANKS "broken logic": you can't have "real facts" when none are backed).
  if (ev < 2 && sc.evidenceBacked === 0) return "Unsupported — we couldn't find a credible source confirming the thesis's core claim.";
  if (lg != null && lg <= 3) return "Real facts, broken logic — the conclusion doesn't follow from the evidence.";
  if (ev >= 6.5 && (lg == null || lg >= 6) && (mg == null || mg >= 5)) return "Supported — the facts, the logic, and the price line up.";
  if (mg != null && mg <= 3 && ev >= 3.5) return "Right idea, aggressive price — the catalyst holds up, but the target is a stretch by historical precedent.";
  if (!core || ev < 5) return "Plausible but unconfirmed — the reasoning holds, but the core claim isn't verified yet (see the critical unknown).";
  return "Partly supported — most claims check out; the rest are unverified or aggressive.";
}

// Assemble the full scorecard from scored claims + detected opposing facts. Deterministic end-to-end. The
// verdict is set here (Evidence/Contradiction only); the route RE-derives it once Logic/Magnitude attach.
export function buildScorecard(scored: ScoredClaim[], opposing: OpposingFact[]): ThesisScorecard {
  const ev = evidenceScore(scored);
  const con = contradictionScore(opposing);
  const cu = criticalUnknownLite(scored);
  const core = [...scored].sort((a, b) => b.weight - a.weight)[0];
  const sc: ThesisScorecard = {
    evidence: ev.score,
    evidenceBacked: ev.backed,
    evidenceTotal: ev.total,
    contradiction: con.score,
    verdict: "",
    criticalUnknown: cu ? cu.raw : null,
    criticalUnknownType: cu ? cu.type : null,
    claims: scored.map((c) => ({ raw: c.raw, type: c.type, verified: c.verified, source: c.bestSource })),
    opposing: opposing.map((o) => o.text),
    coreVerified: core ? core.verified : false,
    engine: "phase1",
  };
  sc.verdict = deriveVerdict(sc);
  return sc;
}
