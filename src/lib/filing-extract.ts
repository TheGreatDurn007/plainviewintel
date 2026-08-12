// ════════════════════════════════════════════════════════════════════════════════
// Deterministic SEC filing extractor — $0, no AI, pure regex.
// Parses 10-K/10-Q HTML into structured FilingInsight rows identical to the AI
// path so the same filing_insights table, same UI cards, same hive-mind wiring.
// ════════════════════════════════════════════════════════════════════════════════

export type FilingInsight = {
  category: string;
  fact: string;
  numeric_value: number | null;
  quote: string | null;
  source_section: string | null;
};

// ── HTML → clean text ────────────────────────────────────────────────────────
function stripHtml(raw: string): string {
  return raw
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/?(p|div|tr|li|h[1-6])[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Skip XBRL/namespace junk to reach real content
function skipXbrl(text: string): string {
  const m = text.match(/\b(UNITED STATES SECURITIES|Consolidated Statements of|CONDENSED CONSOLIDATED|Table of Contents)\b/i);
  return m ? text.slice(m.index!) : text;
}

// ── Section grabber ──────────────────────────────────────────────────────────
function grab(body: string, markers: string[], chars: number, lookback = 0): string {
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

// ── Number parsing ───────────────────────────────────────────────────────────
// Handles "$1,234.5", "(1,234.5)" for negatives, "1,234" plain
function parseNum(s: string): number | null {
  const clean = s.replace(/[$,\s]/g, "");
  const neg = /^\(/.test(s.trim());
  const n = parseFloat(clean.replace(/[()]/g, ""));
  if (!Number.isFinite(n)) return null;
  return neg ? -n : n;
}

// Detect scale from common filing headers: "in thousands", "in millions"
function detectScale(section: string): number {
  const head = section.slice(0, 800).toLowerCase();
  if (/in millions|amounts in millions|\(millions\)/.test(head)) return 1_000_000;
  if (/in thousands|amounts in thousands|\(thousands\)/.test(head)) return 1_000;
  if (/in billions/.test(head)) return 1_000_000_000;
  return 1;
}

// Format a raw number (in original units) to human-readable
function fmt(n: number): string {
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(0)}K`;
  return `${sign}$${abs.toFixed(0)}`;
}

// ── Line-item finder ─────────────────────────────────────────────────────────
// Finds a line matching a label pattern, extracts the first 1-2 numbers after it.
// Returns { current, prior } if two numbers found (current period, comparison period).
type LineMatch = { current: number; prior: number | null; raw: string };

function findLineItem(section: string, patterns: RegExp[], scale: number): LineMatch | null {
  const lines = section.split("\n");
  for (const pat of patterns) {
    for (const line of lines) {
      if (!pat.test(line)) continue;
      // Extract all number-like tokens on this line
      const nums = line.match(/\(?\$?\d[\d,]*\.?\d*\)?/g);
      if (!nums || !nums.length) continue;
      const vals = nums.map(parseNum).filter((n): n is number => n !== null);
      if (!vals.length) continue;
      return {
        current: vals[0] * scale,
        prior: vals.length > 1 ? vals[1] * scale : null,
        raw: line.trim().slice(0, 200),
      };
    }
  }
  return null;
}

// ── YoY calculation ──────────────────────────────────────────────────────────
function yoy(current: number, prior: number | null): string {
  if (prior == null || prior === 0) return "";
  const pct = ((current - prior) / Math.abs(prior)) * 100;
  return ` (${pct >= 0 ? "+" : ""}${pct.toFixed(1)}% YoY)`;
}

// ── Main extractor ───────────────────────────────────────────────────────────
export function extractDeterministic(rawHtml: string, ticker: string, filingType: string): FilingInsight[] {
  const text = skipXbrl(stripHtml(rawHtml));
  const insights: FilingInsight[] = [];

  // Grab sections
  const income = grab(text, ["Cost of sales", "Cost of goods sold", "Cost of revenue"], 5000, 500)
    || grab(text, ["Total revenues", "Total revenue", "Revenues:"], 5000);
  const balance = grab(text, ["Cash and cash equivalents", "CONDENSED CONSOLIDATED BALANCE", "Total assets"], 4000);
  const cashflow = grab(text, ["Cash flows from operating", "CONSOLIDATED STATEMENTS OF CASH", "Net cash provided by operating"], 4000);

  // ── Income Statement ───────────────────────────────────────────────────────
  if (income) {
    const scale = detectScale(income);

    const rev = findLineItem(income, [
      /^[\s]*(?:Total\s+)?(?:net\s+)?revenues?\b/i,
      /^[\s]*(?:Total\s+)?net\s+sales\b/i,
      /^[\s]*Revenue\s/i,
    ], scale);
    if (rev) {
      insights.push({
        category: "revenue",
        fact: `Revenue was ${fmt(rev.current)}${yoy(rev.current, rev.prior)}`,
        numeric_value: rev.current,
        quote: null,
        source_section: "Consolidated Statements of Operations",
      });
    }

    const cogs = findLineItem(income, [
      /cost of (?:sales|goods sold|revenue)/i,
    ], scale);

    const grossProfit = findLineItem(income, [/gross profit/i], scale);
    if (grossProfit && rev) {
      const margin = (grossProfit.current / rev.current) * 100;
      if (margin > 0 && margin < 100) {
        const priorMargin = grossProfit.prior && rev.prior ? (grossProfit.prior / rev.prior) * 100 : null;
        const delta = priorMargin ? `, ${margin > priorMargin ? "up" : "down"} from ${priorMargin.toFixed(1)}%` : "";
        insights.push({
          category: "margins",
          fact: `Gross margin was ${margin.toFixed(1)}%${delta}`,
          numeric_value: Math.round(margin * 100) / 100,
          quote: null,
          source_section: "Consolidated Statements of Operations",
        });
      }
    } else if (cogs && rev && rev.current > 0) {
      const margin = ((rev.current - cogs.current) / rev.current) * 100;
      if (margin > 0 && margin < 100) {
        insights.push({
          category: "margins",
          fact: `Gross margin was ${margin.toFixed(1)}% (revenue ${fmt(rev.current)} less COGS ${fmt(cogs.current)})`,
          numeric_value: Math.round(margin * 100) / 100,
          quote: null,
          source_section: "Consolidated Statements of Operations",
        });
      }
    }

    const netIncome = findLineItem(income, [
      /^[\s]*net (?:income|loss|earnings)\b/i,
      /^[\s]*net (?:income|loss) attributable to/i,
    ], scale);
    if (netIncome) {
      const label = netIncome.current >= 0 ? "Net income" : "Net loss";
      insights.push({
        category: "revenue",
        fact: `${label} was ${fmt(Math.abs(netIncome.current))}${yoy(netIncome.current, netIncome.prior)}`,
        numeric_value: netIncome.current,
        quote: null,
        source_section: "Consolidated Statements of Operations",
      });
    }

    // EPS
    const eps = findLineItem(income, [
      /(?:basic|diluted)\s+(?:net\s+)?(?:income|loss|earnings)\s+per\s+(?:common\s+)?share/i,
      /earnings per share.*(?:basic|diluted)/i,
    ], 1); // EPS is always in dollars, not scaled
    if (eps) {
      insights.push({
        category: "revenue",
        fact: `EPS was $${eps.current.toFixed(2)}${eps.prior != null ? ` vs $${eps.prior.toFixed(2)} prior year` : ""}`,
        numeric_value: eps.current,
        quote: null,
        source_section: "Consolidated Statements of Operations",
      });
    }
  }

  // ── Balance Sheet ──────────────────────────────────────────────────────────
  if (balance) {
    const scale = detectScale(balance);

    const cash = findLineItem(balance, [
      /cash(?:,?\s*cash\s+equivalents)?(?:\s*and\s+(?:short[- ]term\s+)?(?:investments|marketable\s+securities))?/i,
    ], scale);
    if (cash) {
      insights.push({
        category: "debt",
        fact: `Cash and equivalents was ${fmt(cash.current)}${cash.prior != null ? ` vs ${fmt(cash.prior)} prior period` : ""}`,
        numeric_value: cash.current,
        quote: null,
        source_section: "Balance Sheet",
      });
    }

    const totalDebt = findLineItem(balance, [
      /total\s+(?:long[- ]term\s+)?debt/i,
      /long[- ]term\s+debt(?:\s*,\s*net)?/i,
      /total\s+borrowings/i,
    ], scale);
    if (totalDebt) {
      insights.push({
        category: "debt",
        fact: `Total debt was ${fmt(totalDebt.current)}${totalDebt.prior != null ? ` vs ${fmt(totalDebt.prior)} prior period` : ""}`,
        numeric_value: totalDebt.current,
        quote: null,
        source_section: "Balance Sheet",
      });
    }

    // Net debt = debt - cash (derived)
    if (cash && totalDebt) {
      const netDebt = totalDebt.current - cash.current;
      insights.push({
        category: "debt",
        fact: netDebt >= 0
          ? `Net debt was ${fmt(netDebt)} (total debt ${fmt(totalDebt.current)} less cash ${fmt(cash.current)})`
          : `Net cash position of ${fmt(Math.abs(netDebt))} (cash ${fmt(cash.current)} exceeds debt ${fmt(totalDebt.current)})`,
        numeric_value: netDebt,
        quote: null,
        source_section: "Balance Sheet (derived)",
      });
    }

    const totalAssets = findLineItem(balance, [/total\s+assets/i], scale);
    if (totalAssets) {
      insights.push({
        category: "capital_allocation",
        fact: `Total assets were ${fmt(totalAssets.current)}${totalAssets.prior != null ? ` vs ${fmt(totalAssets.prior)} prior period` : ""}`,
        numeric_value: totalAssets.current,
        quote: null,
        source_section: "Balance Sheet",
      });
    }

    const shares = findLineItem(balance, [
      /(?:common\s+)?shares?\s+(?:outstanding|issued)/i,
    ], 1); // shares are never scaled by thousands/millions header
    // But actually shares ARE sometimes in thousands/millions per the header
    if (shares) {
      const shareScale = detectScale(balance);
      const shareCount = shares.current * (shareScale > 1 ? shareScale : 1);
      if (shareCount > 1000) { // sanity: at least 1000 shares
        insights.push({
          category: "capital_allocation",
          fact: `Shares outstanding: ${(shareCount / 1e6).toFixed(1)}M`,
          numeric_value: shareCount,
          quote: null,
          source_section: "Balance Sheet",
        });
      }
    }
  }

  // ── Cash Flow Statement ────────────────────────────────────────────────────
  if (cashflow) {
    const scale = detectScale(cashflow);

    const opCF = findLineItem(cashflow, [
      /net cash (?:provided by|used in) operating/i,
      /cash flows? from operating/i,
    ], scale);
    if (opCF) {
      insights.push({
        category: "cash_flow",
        fact: `Operating cash flow was ${fmt(opCF.current)}${yoy(opCF.current, opCF.prior)}`,
        numeric_value: opCF.current,
        quote: null,
        source_section: "Consolidated Statements of Cash Flows",
      });
    }

    const capex = findLineItem(cashflow, [
      /(?:purchases?|acquisitions?) of (?:property|capital|fixed)/i,
      /capital expenditures/i,
    ], scale);
    if (capex && opCF) {
      const fcf = opCF.current - Math.abs(capex.current);
      insights.push({
        category: "cash_flow",
        fact: `Free cash flow was approximately ${fmt(fcf)} (operating CF ${fmt(opCF.current)} less capex ${fmt(Math.abs(capex.current))})`,
        numeric_value: fcf,
        quote: null,
        source_section: "Consolidated Statements of Cash Flows (derived)",
      });
    }

    // Share repurchases
    const buyback = findLineItem(cashflow, [
      /repurchase[sd]? of (?:common\s+)?(?:stock|shares)/i,
      /treasury (?:stock|shares)\s+(?:acquired|purchased|repurchased)/i,
    ], scale);
    if (buyback && Math.abs(buyback.current) > 0) {
      insights.push({
        category: "capital_allocation",
        fact: `Share repurchases totaled ${fmt(Math.abs(buyback.current))}${buyback.prior != null ? ` vs ${fmt(Math.abs(buyback.prior))} prior period` : ""}`,
        numeric_value: Math.abs(buyback.current),
        quote: null,
        source_section: "Consolidated Statements of Cash Flows",
      });
    }

    // Dividends
    const divs = findLineItem(cashflow, [
      /dividends?\s+paid/i,
      /payment of dividends/i,
    ], scale);
    if (divs && Math.abs(divs.current) > 0) {
      insights.push({
        category: "capital_allocation",
        fact: `Dividends paid were ${fmt(Math.abs(divs.current))}`,
        numeric_value: Math.abs(divs.current),
        quote: null,
        source_section: "Consolidated Statements of Cash Flows",
      });
    }
  }

  return insights;
}
