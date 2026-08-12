// ════════════════════════════════════════════════════════════════════════════════════════════
// Trust classification — the jurisdiction-aware fact-admissibility gate (P0.2).
// ════════════════════════════════════════════════════════════════════════════════════════════
// Every fact written to the ledger gets a trust tier based on WHERE it came from, relative to the
// security's own jurisdiction. This is what lets the "was I right?" scorecard (P1) grade only on
// facts we'd independently stand behind — never on an AI-laundered number (the FDY "$30M placement")
// or a lone unverifiable aggregator figure.
//
// THE KEY ABSTRACTION (learned from FDY.TO): Tier-1 is NOT "SEC". Tier-1 is "the canonical primary
// source for this fact, in THIS security's jurisdiction." US equities → SEC EDGAR. Canadian equities
// (.TO/.V/.CN/.NE) → SEDAR+ (registered here so they auto-promote the day we ingest it; today their
// fundamentals fall back to corroborated aggregators). The live exchange PRICE is Tier-1 for EVERY
// jurisdiction. Crypto → CoinGecko. This file hard-codes no US-centric assumption.
//
// The enum is the existing `nexus_trust_tier` (no migration): authoritative = Tier-1 (admissible
// alone) · derived = Tier-2/3 (admissible only if corroborated) · ai_interpretation = inadmissible
// (never grades) · historical = explicitly stale. Pure functions, no I/O, never throw.

import type { TrustTier } from "./nexus-memory";

export type Jurisdiction = "US" | "CA" | "crypto" | "intl";

// Exchange suffix → jurisdiction. Extensible: add a row when a new market is supported. A bare
// symbol (no dotted suffix) is assumed US-listed, which is the platform's default universe.
const SUFFIX_JURISDICTION: { re: RegExp; j: Jurisdiction }[] = [
  { re: /\.(TO|V|CN|NE)$/i, j: "CA" },            // TSX / TSXV / CSE / NEO  (Canada → SEDAR+)
  { re: /\.(L|PA|DE|AS|MI|SW|ST|HE|OL|MC)$/i, j: "intl" }, // LSE & EU primaries
  { re: /\.(AX|NZ|HK|T|SS|SZ|KS|TW|BO|NS)$/i, j: "intl" }, // APAC primaries
];

/** Determine a security's home jurisdiction from its symbol (and an optional crypto flag). */
export function detectJurisdiction(ticker: string, isCrypto = false): Jurisdiction {
  const t = (ticker || "").trim();
  if (isCrypto || /-USD$/i.test(t)) return "crypto";
  for (const { re, j } of SUFFIX_JURISDICTION) if (re.test(t)) return j;
  return "US";
}

// Substring rules over a lowercased source string. Order matters: the inadmissible (AI/self-memory)
// rules run FIRST so a laundered number can never be mistaken for sourced data.
const AI_RE = /\b(ai|llm|gpt|claude|gemini|groq|cerebras)\b|brief|nexus narrative|prior (brief|intel)|from memory|ticker memory|investor('s)? note|user note|their (thesis|guess)|speculat/i;
const SEC_RE = /\bsec\b|edgar|10-?[kq]|8-?k|company ?facts|company ?concept/i;
const SEDAR_RE = /sedar/i;
const CRYPTO_AUTH_RE = /coingecko|coinmarketcap/i;
const AGGREGATOR_RE = /yahoo|finnhub|alpha ?vantage|analyst|stockanalysis|polygon|iex|marketbeat|tipranks/i;
const COMPUTED_RE = /comput|derived|plainview (computed|score)|confluence|beta|technical|rsi|moving average|\bma\d/i;

/**
 * Classify one observation's trust tier, jurisdiction-aware.
 *
 * @param source     free-text provenance string stored with the observation (e.g. "SEC EDGAR",
 *                   "Yahoo financials", "analyst consensus").
 * @param ticker     the canonical symbol — used to know which regulator counts as Tier-1.
 * @param signalType optional — when "price", the datum is the live exchange-traded price, which is
 *                   Tier-1 for ANY jurisdiction regardless of which vendor relayed it.
 * @param isCrypto   optional crypto hint (some crypto tickers carry no -USD suffix here).
 */
export function classifyTrust(
  source: string | null | undefined,
  ticker: string,
  signalType?: string,
  isCrypto = false
): TrustTier {
  const s = (source || "").toLowerCase();
  const j = detectJurisdiction(ticker, isCrypto);

  // The live exchange price is the market's own print — Tier-1 everywhere (US, TSX, TSXV, ...).
  if (signalType === "price") return "authoritative";

  // INADMISSIBLE first: AI prose, prior-brief memory, or the investor's own notes never grade.
  if (AI_RE.test(s)) return "ai_interpretation";

  // TIER-1 — the primary source of truth FOR THIS JURISDICTION only.
  if (j === "US" && SEC_RE.test(s)) return "authoritative";
  if (j === "CA" && SEDAR_RE.test(s)) return "authoritative"; // future: SEDAR+ not yet ingested
  if (j === "crypto" && CRYPTO_AUTH_RE.test(s)) return "authoritative";
  // A regulator filing cited for the WRONG jurisdiction is NOT authoritative here (e.g. an "SEC"
  // string on a .TO name) — fall through to derived rather than over-trust it.

  // TIER-2/3 — aggregators and our own computed values: real, but second-hand → need corroboration.
  if (AGGREGATOR_RE.test(s) || COMPUTED_RE.test(s)) return "derived";

  // Unknown source: fail CLOSED on authority (never Tier-1), but allow it to participate in
  // corroboration as derived. The explicit AI/notes guard above is the real inadmissibility floor;
  // an unmapped-but-genuine vendor shouldn't silently delete real facts. Unmapped sources are worth
  // auditing — the caller may log these to discover provenance strings we should map explicitly.
  return "derived";
}

/** Tier-1: trustworthy enough to grade a prediction on its own. */
export function isAdmissibleAlone(tier: TrustTier): boolean {
  return tier === "authoritative";
}

/** Can this fact count toward the ≥2-source corroboration that promotes derived facts to gradeable? */
export function canCorroborate(tier: TrustTier): boolean {
  return tier === "authoritative" || tier === "derived";
}

/** AI output / self-memory / user notes — may be stored and shown, but can NEVER grade. */
export function isInadmissible(tier: TrustTier): boolean {
  return tier === "ai_interpretation";
}
