export type IntelAssetLens = "stock" | "watchlist" | "mining" | "etf" | "crypto";

type DetectIntelAssetLensInput = {
  isCrypto?: boolean;
  isETF?: boolean;
  isWatchlist?: boolean;
  ticker: string;
  name?: string | null;
  sector?: string | null;
  industry?: string | null;
  description?: string | null;
};

type BuildIntelEvidenceInput = {
  lens: IntelAssetLens;
  ticker: string;
  thesis?: string | null;
  priorKnowledge?: string | null;
  earningsDate?: string | null;
  newsLines?: string[];
  secLines?: string[];
  financialBlock?: string | null;
  xrayBlock?: string | null;
  technicalBlock?: string | null;
  analystTarget?: string | null;
  marketDataBlock?: string | null;
};

const MINING_IDENTITY_RE = /\b(mining|minerals?|mines?|metals?|precious metals|base metals|gold|silver|copper|uranium|lithium|nickel|zinc|rare earth|resources?)\b/i;
const MINING_COMMODITY_RE = /\b(gold|silver|copper|uranium|lithium|nickel|zinc|rare earth|palladium|platinum|cobalt|molybdenum)\b/i;
const MINING_STAGE_RE = /\b(drill|assay|intercept|resource estimate|mineral resource|pea|pfs|feasibility|npv|irr|capex|aisc|deposit|permit|mine|mining|production)\b/i;

const OPERATING_RE = /\b(attendance|patron|spend|revenue|sales|bookings|users?|customers?|deliveries|production|margin|ebitda|eps|cash flow|backlog|contract|guidance|record|growth|yoy|quarter|earnings)\b/i;
const RISK_RE = /\b(debt|cash runway|net cash|leverage|dilution|offering|atm|warrant|capex|permit|lawsuit|margin compression|restructuring|bankruptcy|shortfall|miss)\b/i;
const PRICE_RE = /\b(price|shares?|stock|rallied|surged|jumped|fell|declined|gained|outperform|underperform|rsi|moving average|target|short interest)\b/i;

function compact(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function splitCandidates(text: string): string[] {
  return compact(text)
    .split(/(?<=[.!?])\s+|(?:\s+-\s+)/)
    .map((line) => compact(line.replace(/^\[[^\]]+\]\s*/, "")))
    .filter((line) => line.length >= 20 && line.length <= 260);
}

function uniquePush(items: string[], value: string | null | undefined) {
  if (!value) return;
  const cleaned = compact(value);
  if (!cleaned) return;
  const key = cleaned.toLowerCase();
  if (!items.some((item) => item.toLowerCase() === key)) items.push(cleaned);
}

function scoreCandidate(text: string, lens: IntelAssetLens): number {
  let score = 0;
  if (/\d/.test(text)) score += 3;
  if (OPERATING_RE.test(text)) score += 4;
  if (RISK_RE.test(text)) score += 2;
  if (PRICE_RE.test(text)) score += 1;
  if (lens === "mining" && (MINING_STAGE_RE.test(text) || MINING_COMMODITY_RE.test(text))) score += 5;
  if (lens === "crypto" && /\b(market cap|volume|24h|7d|ath|supply|regulatory|etf|network)\b/i.test(text)) score += 4;
  if (lens === "etf" && /\b(ytd|1-year|volatility|drawdown|holdings|expense|yield|sector|strategy)\b/i.test(text)) score += 4;
  if (/headline|filed|filing|earnings|catalyst|contract|deal|partnership/i.test(text)) score += 2;
  if (/price move|three-month|3-month|5d|1mo|3mo/i.test(text)) score -= 1;
  return score;
}

function topCandidates(text: string, lens: IntelAssetLens, limit: number): string[] {
  return splitCandidates(text)
    .map((candidate) => ({ candidate, score: scoreCandidate(candidate, lens) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((item) => item.candidate)
    .filter((candidate, index, arr) => arr.findIndex((x) => x.toLowerCase() === candidate.toLowerCase()) === index)
    .slice(0, limit);
}

export function detectIntelAssetLens(input: DetectIntelAssetLensInput): IntelAssetLens {
  if (input.isCrypto) return "crypto";
  if (input.isETF) return "etf";

  const identity = compact([
    input.name,
    input.sector,
    input.industry,
    input.description,
  ].filter(Boolean).join(" "));

  const strongMiningIdentity =
    MINING_IDENTITY_RE.test(identity) &&
    (MINING_COMMODITY_RE.test(identity) || MINING_STAGE_RE.test(identity) || /\b(mining|minerals?|metals?|mines?)\b/i.test(identity));

  if (strongMiningIdentity) return "mining";
  return input.isWatchlist ? "watchlist" : "stock";
}

export function buildIntelEvidenceBlock(input: BuildIntelEvidenceInput): string | null {
  const evidence: string[] = [];
  const contextText = [
    input.thesis,
    input.priorKnowledge,
    ...(input.newsLines ?? []),
    ...(input.secLines ?? []),
    input.xrayBlock,
    input.financialBlock,
    input.marketDataBlock,
    input.technicalBlock,
  ].filter(Boolean).join(" ");

  const candidates = topCandidates(contextText, input.lens, 7);

  if (input.lens === "mining") {
    uniquePush(evidence, candidates.find((line) => MINING_STAGE_RE.test(line) || MINING_COMMODITY_RE.test(line)));
  } else if (input.lens === "etf") {
    uniquePush(evidence, candidates.find((line) => /\b(ytd|1-year|volatility|drawdown|holdings|sector|strategy)\b/i.test(line)));
  } else if (input.lens === "crypto") {
    uniquePush(evidence, candidates.find((line) => /\b(market cap|volume|24h|7d|ath|supply)\b/i.test(line)));
  } else {
    uniquePush(evidence, candidates.find((line) => OPERATING_RE.test(line)));
  }

  uniquePush(evidence, candidates.find((line) => RISK_RE.test(line)));
  if (input.earningsDate) uniquePush(evidence, `Next earnings date: ${input.earningsDate}`);
  uniquePush(evidence, candidates.find((line) => /headline|filing|contract|deal|partnership|record|earnings|catalyst/i.test(line)));
  uniquePush(evidence, candidates.find((line) => PRICE_RE.test(line)));
  if (input.analystTarget) uniquePush(evidence, input.analystTarget);

  for (const candidate of candidates) {
    if (evidence.length >= 8) break;
    uniquePush(evidence, candidate);
  }

  if (!evidence.length) return null;

  const lensLabel =
    input.lens === "mining" ? "mining / natural-resource" :
    input.lens === "etf" ? "ETF" :
    input.lens === "crypto" ? "crypto" :
    input.lens === "watchlist" ? "watchlist equity" :
    "standard equity";

  return `Plainview ranked evidence packet for ${input.ticker} (${lensLabel}; use this first when deciding what changed, risk, catalyst, and thesis check):\n${evidence
    .slice(0, 8)
    .map((item, index) => `${index + 1}. ${item}`)
    .join("\n")}`;
}
