// ════════════════════════════════════════════════════════════════════════════════════════════
// Form 4 insider insight — the deterministic "who bought, how strongly" breakdown (P0.3).
// ════════════════════════════════════════════════════════════════════════════════════════════
// Pure, no I/O — the parsed Form 4 comes in, a structured insight + legible summary come out.
// Conviction is DERIVED from Tier-1 SEC facts (role × open-market × discretionary × cluster × size ×
// stake-delta), never judged by a model. This is "credible by construction": the strongest free
// signal on the gem card, with zero hallucination surface. Lives in its own file so it can be unit
// tested without pulling the server-only deps of market-context.

export type Form4Role = "officer" | "director" | "tenPercentOwner" | "insider";

// What parseForm4Codes (in market-context) extracts from the filing XML.
export type Form4Parsed = {
  codes: Array<{ code: string; shares: number; price: number }>;
  ownerName: string;
  role: Form4Role;
  officerTitle: string;
  ownedAfter: number | null; // shares beneficially owned following the (last) transaction
  scheduled: boolean | null; // 10b5-1 pre-scheduled (true) / discretionary (false) / unknown (null)
};

export type Form4Insight = {
  action: "buy" | "sell" | "grant" | "mixed" | "other";
  conviction: "high" | "medium" | "low";
  ownerName?: string;        // reporting person, e.g. "Smith John A"
  role: Form4Role;           // strongest relationship flagged on the filing
  officerTitle?: string;     // e.g. "CEO", "Chief Financial Officer" (when role=officer)
  shares: number;            // shares transacted (sum of the relevant code)
  value: number | null;      // $ when price disclosed
  pctOfStake: number | null; // % the buy ADDED to the person's prior holding (stake-delta)
  scheduled: boolean | null; // true = 10b5-1 pre-scheduled · false = discretionary · null = unknown
  distinctBuyers: number;    // distinct reporting owners buying across the 30-day window (cluster)
  totalFilings: number;      // total Form 4 filings in the window
};

export const ROLE_LABEL: Record<Form4Role, string> = {
  officer: "Officer", director: "Director", tenPercentOwner: "10% owner", insider: "Insider",
};

/** Tighten a long officer title to a badge (e.g. "Chief Executive Officer" → "CEO"). */
export function shortTitle(title: string | undefined, role: Form4Role): string {
  if (title) {
    if (/chief exec/i.test(title)) return "CEO";
    if (/chief financ/i.test(title)) return "CFO";
    if (/chief oper/i.test(title)) return "COO";
    if (/chief tech/i.test(title)) return "CTO";
    if (title.length <= 24) return title;
  }
  return ROLE_LABEL[role];
}

/** Classify the dominant action of a Form 4 from its transaction codes. */
export function form4Action(codes: Array<{ code: string }>): Form4Insight["action"] {
  const has = (c: string) => codes.some(x => x.code === c);
  const buy = has("P"), sell = has("S");
  if (buy && sell) return "mixed";
  if (buy) return "buy";
  if (sell) return "sell";
  if (codes.some(c => ["A", "M", "F", "G", "C", "W", "X", "D"].includes(c.code))) return "grant";
  return "other";
}

/**
 * Build the structured insider insight from a parsed Form 4 + the cluster context. Returns null for
 * non-buy filings (the gem card leads with buys; sells/grants keep the plain summary).
 * distinctBuyers/totalFilings describe the 30-day window, not this one filing.
 */
export function buildForm4Insight(
  p: Form4Parsed,
  distinctBuyers: number,
  totalFilings: number,
): Form4Insight | null {
  const action = form4Action(p.codes);
  if (action !== "buy") return null;

  const buys = p.codes.filter(c => c.code === "P");
  const shares = buys.reduce((s, c) => s + c.shares, 0);
  const value = buys.reduce((sum, c) => sum + c.shares * c.price, 0) || null;
  // Stake-delta: what % the buy ADDED to the prior holding. prior = ownedAfter − sharesBought.
  let pctOfStake: number | null = null;
  if (p.ownedAfter != null && shares > 0) {
    const prior = p.ownedAfter - shares;
    if (prior > 0) pctOfStake = shares / prior;
  }

  // Conviction (deterministic). A discretionary, senior, sizable, or clustered buy scores higher.
  let score = 0;
  if (p.role === "officer") score += 2; else if (p.role === "director") score += 1;
  if (p.scheduled === false) score += 1;                 // discretionary, not 10b5-1
  if (distinctBuyers >= 2) score += 2;                    // a cluster of different insiders
  if ((value ?? 0) >= 250_000) score += 1;
  if ((pctOfStake ?? 0) >= 0.10) score += 1;             // added ≥10% to their stake
  if (p.scheduled === true) score -= 1;                   // pre-scheduled → weaker
  const conviction: Form4Insight["conviction"] = score >= 4 ? "high" : score >= 2 ? "medium" : "low";

  return {
    action, conviction,
    ownerName: p.ownerName || undefined,
    role: p.role,
    officerTitle: p.officerTitle || undefined,
    shares, value, pctOfStake, scheduled: p.scheduled,
    distinctBuyers, totalFilings,
  };
}

/** A richer, role/stake/cluster-aware one-liner for a purchase — replaces the old "Verify role" punt. */
export function form4PurchaseSummary(insight: Form4Insight): string {
  const buyer = shortTitle(insight.officerTitle, insight.role);
  const fmt$ = (v: number) => v >= 1_000_000 ? `$${(v / 1_000_000).toFixed(1)}M` : v >= 1_000 ? `$${(v / 1_000).toFixed(0)}K` : `$${v.toFixed(0)}`;
  const parts = [`${insight.shares.toLocaleString("en", { maximumFractionDigits: 0 })} sh`];
  if (insight.value) parts.push(`~${fmt$(insight.value)}`);
  if (insight.pctOfStake != null) parts.push(`+${(insight.pctOfStake * 100).toFixed(0)}% to stake`);
  const sched = insight.scheduled === false ? ", discretionary" : insight.scheduled === true ? ", 10b5-1 scheduled" : "";
  const cluster = insight.distinctBuyers >= 2 ? `; ${insight.distinctBuyers} insiders buying` : "";
  return `${buyer} open-market buy — ${parts.join(" · ")}${cluster}${sched}.`;
}
