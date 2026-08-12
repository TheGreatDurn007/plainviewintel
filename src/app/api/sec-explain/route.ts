import { NextResponse } from "next/server";
import { enforceAiQuota } from "@/lib/ai-quota";
import { logUsage } from "@/lib/usage-log";
import { getCachedText, setCachedText } from "@/lib/ai-cache";
import Anthropic from "@anthropic-ai/sdk";
import { callCerebrasText, callGroqText, callGeminiText } from "@/lib/market-context";
import { autoDowngradeOnCreditDepletion } from "@/lib/ai-tier";

/** Generate text via Cerebras → Groq → Gemini (all free) → Claude, on any failure of the prior. */
async function generateText(prompt: string): Promise<string> {
  if (process.env.CEREBRAS_API_KEY) {
    try {
      const out = await callCerebrasText(prompt);
      if (out && out.trim()) return out;
    } catch { /* fall through to Groq */ }
  }
  if (process.env.GROQ_API_KEY) {
    try {
      const out = await callGroqText(prompt);
      if (out && out.trim()) return out;
    } catch { /* fall through to Gemini */ }
  }
  if (process.env.GEMINI_API_KEY) {
    try {
      const out = await callGeminiText(prompt);
      if (out && out.trim()) return out;
    } catch { /* fall through to Anthropic */ }
  }
  if (process.env.ANTHROPIC_API_KEY) {
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: 15000 });
    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 400,
      messages: [{ role: "user", content: prompt }],
    });
    return response.content
      .filter((b) => b.type === "text")
      .map((b) => (b as unknown as { text: string }).text)
      .join("\n");
  }
  throw new Error("No AI provider configured");
}

const SEC_HEADERS = {
  "User-Agent": "Plainview investing tool plainview@dar-fishman.com",
  Accept: "text/html,application/xml,text/xml,*/*",
};

/** Strip XML/HTML tags and collapse whitespace to get readable text. */
function stripToText(raw: string): string {
  return raw
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, m => m.slice(9, -3))
    .replace(/<[^>]+>/g, " ")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/&nbsp;/g, " ")
    .replace(/&#\d+;/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** For non-10-Q/10-K filings: simple first-N-chars extraction. */
function extractText(raw: string, maxChars = 4000): string {
  return stripToText(raw).slice(0, maxChars);
}

/** For 10-Q/10-K: extract the financial sections that matter for DD.
 *  Seeks income statement, balance sheet, cash flow, and MD&A — the tables
 *  where revenue, margins, debt, and cash flow live. */
function extractFinancialSections(raw: string): string {
  const text = stripToText(raw);

  // Skip XBRL metadata prefix (us-gaap:*, Member, etc.) — real content starts after
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

  // Income statement: find the actual data table, not the TOC reference.
  // "Cost of sales" / "Cost of goods" only appear in the real table, so
  // grab from 200 chars before it (to capture Revenue above) + 3000 forward.
  // Grab from the formal income statement (Cost of X markers are table-only, never TOC)
  // Use 500 lookback to capture Revenue line above, 5000 forward to reach net income
  const income = grab([
    "Cost of sales", "Cost of goods sold", "Cost of revenue",
  ], 5000, 500) || grab([
    "Total revenues", "Total revenue",
    "Revenues:",
  ], 5000);

  const balance = grab([
    "Cash and cash equivalents",
    "CONDENSED CONSOLIDATED BALANCE",
    "Consolidated Balance Sheet",
    "Total assets",
  ], 2500);

  const cashflow = grab([
    "Cash flows from operating",
    "CONDENSED CONSOLIDATED STATEMENTS OF CASH",
    "Consolidated Statements of Cash Flow",
  ], 2000);

  const mda = grab([
    "Management’s Discussion and Analysis",
    "Management s Discussion and Analysis",
    "MANAGEMENT’S DISCUSSION",
    "Item 2.",
  ], 2500);

  const sections: string[] = [];
  if (income) sections.push("=== INCOME STATEMENT ===\n" + income);
  if (balance) sections.push("=== BALANCE SHEET ===\n" + balance);
  if (cashflow) sections.push("=== CASH FLOWS ===\n" + cashflow);
  if (mda) sections.push("=== MD&A HIGHLIGHTS ===\n" + mda);

  if (!sections.length) {
    return body.slice(0, 10000);
  }

  return sections.join("\n\n");
}

type ParsedForm4Transaction = {
  date: string;
  code: string;
  shares: number | null;
  price: number | null;
  acquiredDisposed: string;
  ownedAfter: number | null;
  directIndirect: string;
  securityTitle: string;
};

type Form4Parties = {
  ownerName: string;
  ownerCik: string;
  issuerName: string;
  issuerCik: string;
  isDirector: boolean;
  isOfficer: boolean;
  officerTitle: string;
  isTenPercentOwner: boolean;
};

const ENTITY_SUFFIXES = /\b(LLC|L\.L\.C|LP|L\.P|INC|CORP|CO|CAPITAL|PARTNERS|FUND|MANAGEMENT|HOLDINGS|TRUST|GROUP|VENTURES|ADVISORS|ADVISORY|ASSOCIATES|ENTERPRISE|FOUNDATION)\b/i;

const FORM_4_CODE_LABELS: Record<string, string> = {
  P: "open-market or private purchase",
  S: "open-market or private sale",
  A: "grant, award, or other acquisition under a compensation plan",
  M: "option exercise or derivative conversion",
  F: "shares withheld or sold to cover taxes",
  G: "gift",
  C: "conversion",
  D: "disposition to the issuer or another party",
  J: "other transaction described in the filing footnotes",
};

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .trim();
}

function readTag(source: string, tag: string): string {
  const match = source.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
  return match ? decodeXml(match[1].replace(/<[^>]+>/g, " ")) : "";
}

function readValue(source: string, tag: string): string {
  const block = readTag(source, tag);
  return block ? readTag(block, "value") || block : "";
}

function readNumber(source: string, tag: string): number | null {
  const raw = readValue(source, tag).replace(/[$,]/g, "");
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function formatNumber(value: number | null): string {
  return value === null ? "not disclosed" : value.toLocaleString("en-US", { maximumFractionDigits: 0 });
}

function formatMoney(value: number | null): string {
  if (value === null) return "not disclosed";
  return value.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });
}

function formatCompact(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1e9) return "$" + (value / 1e9).toFixed(1) + "B";
  if (abs >= 1e6) return "$" + (value / 1e6).toFixed(1) + "M";
  if (abs >= 1e3) return "$" + (value / 1e3).toFixed(0) + "K";
  return formatMoney(value);
}

function titleCase(s: string): string {
  if (!s) return s;
  // Keep 2-4 letter all-caps words (likely tickers/acronyms) as-is
  return s.replace(/\b[A-Z]{2,4}\b/g, "<<<$&>>>")
    .toLowerCase().replace(/\b\w/g, c => c.toUpperCase())
    .replace(/<<<([a-z]{2,4})>>>/gi, (_, w) => w.toUpperCase())
    .replace(/\b(Ceo|Cfo|Coo|Cto|Svp|Evp|Vp|Llc|Inc|Lp|Ii|Iii|Iv|Jr|Sr)\b/gi, m => m.toUpperCase())
    .replace(/\bAnd\b/g, "and").replace(/\bOf\b/g, "of").replace(/\bThe\b/g, "the")
    .replace(/,\s*Inc\.?/gi, ", Inc.").replace(/,\s*Llc\.?/gi, ", LLC")
    .replace(/^./, c => c.toUpperCase());
}

function titleCaseRole(s: string): string {
  if (!s) return s;
  return s.replace(/\b(CEO|CFO|COO|CTO|SVP|EVP|VP|Chairman|President)\b/gi, m => {
    const u = m.toUpperCase();
    if (/^(CEO|CFO|COO|CTO|SVP|EVP|VP)$/.test(u)) return u;
    return m.charAt(0).toUpperCase() + m.slice(1).toLowerCase();
  }).replace(/^./, c => c.toUpperCase());
}

function flipName(edgarName: string): string {
  const parts = edgarName.trim().split(/\s+/);
  if (parts.length < 2) return edgarName.toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
  // EDGAR: "LAST FIRST MIDDLE" or "LAST FIRST M" → "First M. Last"
  const last = parts[0];
  const rest = parts.slice(1);
  const formatted = rest.map(p => p.length === 1 ? p.toUpperCase() + "." : p);
  const raw = [...formatted, last].join(" ");
  // Simple title-case for names (no acronym preservation — "ADAM" is a name, not an acronym)
  return raw.toLowerCase().replace(/\b\w/g, c => c.toUpperCase())
    .replace(/\b(Jr|Sr|Ii|Iii|Iv)\b/gi, m => m.toUpperCase());
}

function humanDate(d: string): string {
  const m = d.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (!m) {
    const m2 = d.match(/(\d{2})\/(\d{2})\/(\d{4})/);
    if (!m2) return d;
    const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    return `${months[parseInt(m2[0]) - 1] || m2[0]} ${parseInt(m2[1])}, ${m2[2]}`;
  }
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return `${months[parseInt(m[2]) - 1] || m[2]} ${parseInt(m[3])}, ${m[1]}`;
}

function cleanSecurity(s: string): string {
  return s.replace(/CLASS\s+A\s+/i, "").replace(/COMMON STOCK/i, "common shares").replace(/\s+/g, " ").trim().toLowerCase();
}

function parseLooseNumber(value: string): number | null {
  const match = value.replace(/,/g, "").match(/\d+(?:\.\d+)?/);
  if (!match) return null;
  const parsed = Number(match[0]);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseForm4HtmlTable(raw: string): ParsedForm4Transaction | null {
  const rows = Array.from(raw.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi));

  for (const row of rows) {
    const cells = Array.from(row[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi))
      .map((cell) => extractText(cell[1], 600));

    const dateIndex = cells.findIndex((cell) => /^\d{2}\/\d{2}\/\d{4}$/.test(cell));
    if (dateIndex < 1) continue;

    const codeIndex = cells.findIndex((cell, index) => index > dateIndex && /^[A-Z]$/.test(cell));
    if (codeIndex < 0) continue;

    const sharesIndex = cells.findIndex((cell, index) => index > codeIndex && /^[\d,]+$/.test(cell));
    if (sharesIndex < 0) continue;

    const acquiredDisposedIndex = cells.findIndex((cell, index) => index > sharesIndex && /^[AD]$/.test(cell));
    const priceIndex = acquiredDisposedIndex >= 0 ? acquiredDisposedIndex + 1 : -1;
    const ownedIndex = priceIndex >= 0 ? cells.findIndex((cell, index) => index > priceIndex && /^[\d,]+(?:\s+\(\d+\))?$/.test(cell)) : -1;
    const directIndirectIndex = ownedIndex >= 0 ? cells.findIndex((cell, index) => index > ownedIndex && /^[DI]$/.test(cell)) : -1;

    return {
      securityTitle: cells[0] || "shares",
      date: cells[dateIndex],
      code: cells[codeIndex].toUpperCase(),
      shares: parseLooseNumber(cells[sharesIndex]),
      acquiredDisposed: acquiredDisposedIndex >= 0 ? cells[acquiredDisposedIndex].toUpperCase() : "",
      price: priceIndex >= 0 ? parseLooseNumber(cells[priceIndex]) : null,
      ownedAfter: ownedIndex >= 0 ? parseLooseNumber(cells[ownedIndex]) : null,
      directIndirect: directIndirectIndex >= 0 ? cells[directIndirectIndex].toUpperCase() : "",
    };
  }

  return null;
}

function parseForm4Text(raw: string): {
  ownerName: string;
  issuerName: string;
  officerTitle: string;
  transactions: ParsedForm4Transaction[];
} | null {
  const htmlTransaction = parseForm4HtmlTable(raw);
  const text = extractText(raw, 12000);
  const rowMatch = text.match(/([A-Z][A-Z0-9 .,&/-]+?)\s+(\d{2}\/\d{2}\/\d{4})\s+([A-Z])\s+([\d,]+)\s+([AD])\s+\$?\s*([\d.]+)(?:\s*\(\d+\))?\s+([\d,]+)(?:\s*\(\d+\))?\s+([DI])\b/);
  if (!htmlTransaction && !rowMatch) return null;

  const ownerMatch = text.match(/Name and Address of Reporting Person\*?\s+([A-Z][A-Z .'-]+?)\s+(?:\* \* \*|\(Last\))/i);
  const issuerMatch = text.match(/Issuer Name and Ticker or Trading Symbol\s+([A-Z0-9 .,&'-]+?)\s+\[\s*([A-Z.]+)\s*\]/i);
  const officerMatch = text.match(/Officer \(give title below\)\s+(.+?)\s+3\. Date of Earliest Transaction/i);
  let transaction = htmlTransaction;
  if (!transaction && rowMatch) {
    transaction = {
      securityTitle: rowMatch[1].trim(),
      date: rowMatch[2],
      code: rowMatch[3].toUpperCase(),
      shares: Number(rowMatch[4].replace(/,/g, "")),
      acquiredDisposed: rowMatch[5].toUpperCase(),
      price: Number(rowMatch[6]),
      ownedAfter: Number(rowMatch[7].replace(/,/g, "")),
      directIndirect: rowMatch[8].toUpperCase(),
    };
  }
  if (!transaction) return null;

  return {
    ownerName: ownerMatch?.[1]?.trim() || "",
    issuerName: issuerMatch?.[1]?.trim() || "",
    officerTitle: officerMatch?.[1]?.trim() || "",
    transactions: [transaction],
  };
}

function parseForm4Transactions(raw: string): {
  parties: Form4Parties;
  transactions: ParsedForm4Transaction[];
} | null {
  const transactions = Array.from(raw.matchAll(/<nonDerivativeTransaction>([\s\S]*?)<\/nonDerivativeTransaction>/gi))
    .map((match) => {
      const block = match[1];
      return {
        date: readValue(block, "transactionDate"),
        code: readTag(block, "transactionCode").toUpperCase(),
        shares: readNumber(block, "transactionShares"),
        price: readNumber(block, "transactionPricePerShare"),
        acquiredDisposed: readValue(block, "transactionAcquiredDisposedCode").toUpperCase(),
        ownedAfter: readNumber(block, "sharesOwnedFollowingTransaction"),
        directIndirect: readValue(block, "directOrIndirectOwnership").toUpperCase(),
        securityTitle: readValue(block, "securityTitle"),
      };
    })
    .filter((tx) => tx.code || tx.shares !== null);

  if (!transactions.length) {
    const text = parseForm4Text(raw);
    if (!text) return null;
    return {
      parties: {
        ownerName: text.ownerName,
        ownerCik: "",
        issuerName: text.issuerName,
        issuerCik: "",
        isDirector: false,
        isOfficer: !!text.officerTitle,
        officerTitle: text.officerTitle,
        isTenPercentOwner: false,
      },
      transactions: text.transactions,
    };
  }

  const ownerBlock = raw.match(/<reportingOwner>([\s\S]*?)<\/reportingOwner>/i)?.[1] || "";
  const relBlock = raw.match(/<reportingOwnerRelationship>([\s\S]*?)<\/reportingOwnerRelationship>/i)?.[1] || "";

  return {
    parties: {
      ownerName: readTag(raw, "rptOwnerName"),
      ownerCik: readTag(ownerBlock, "rptOwnerCik").replace(/\D/g, ""),
      issuerName: readTag(raw, "issuerName"),
      issuerCik: readTag(raw, "issuerCik").replace(/\D/g, ""),
      isDirector: /1|true/i.test(readTag(relBlock, "isDirector")),
      isOfficer: /1|true/i.test(readTag(relBlock, "isOfficer")),
      officerTitle: readTag(relBlock, "officerTitle"),
      isTenPercentOwner: /1|true/i.test(readTag(relBlock, "isTenPercentOwner")),
    },
    transactions,
  };
}

// Reject form-label artifacts that mis-parse into the title field (foreign filers show "Other (specify
// below) 2a. Foreign Trading Symbol" etc.). Only keep a short, plausible job title.
function sanitizeRole(title?: string): string {
  const t = (title || "").trim();
  if (!t) return "";
  if (/specify below|trading symbol|reporting person|relationship|check all|10% owner|give title|issuer name|earliest transaction|^\d/i.test(t)) return "";
  if (t.length > 40) return "";
  return t;
}

// ── Form 4 identity resolution + verdict gating ──
// Guard A: the actor of every Form 4 sentence is always the Reporting Owner, never the Issuer.
// Guard B: the "meaningful insider buy" verdict fires only after identity is verified and
//          the transaction is a genuine priced open-market acquisition (code P + A + price > 0).
function resolveIdentity(p: Form4Parties, fallbackName?: string): {
  verified: boolean;
  who: string;
  company: string;
  isEntity: boolean;
  relationship: string;
} {
  const company = p.issuerName || fallbackName || "the company";

  // CIK-based check is authoritative
  const cikCollision = p.ownerCik && p.issuerCik && p.ownerCik === p.issuerCik;
  // Name-based check is secondary heuristic
  const norm = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const nameCollision = p.ownerName && norm(p.ownerName).includes(norm(company).slice(0, 20));
  const ownerVerified = !!p.ownerName && !cikCollision && !nameCollision;

  const isEntity = ENTITY_SUFFIXES.test(p.ownerName || "");
  const role = titleCaseRole(sanitizeRole(p.officerTitle));
  // Pick the single best descriptor: officer title > Director > 10% Owner
  let relationship = "";
  if (p.isOfficer && role) {
    relationship = role;
  } else if (p.isOfficer) {
    relationship = "Officer";
  } else if (p.isDirector) {
    relationship = "Director";
  } else if (p.isTenPercentOwner) {
    relationship = "10% Owner";
  }

  const prettyName = ownerVerified ? (isEntity ? titleCase(p.ownerName) : flipName(p.ownerName)) : "The reporting person";
  const prettyCompany = titleCase(company);
  let who = prettyName;
  if (ownerVerified && relationship) {
    who = `${prettyName}, ${relationship}`;
  } else if (ownerVerified && isEntity) {
    who = `${prettyName} (reporting entity)`;
  }

  return { verified: ownerVerified, who, company: prettyCompany, isEntity, relationship };
}

function explainParsedForm4(raw: string, fallbackName?: string, ticker?: string): string | null {
  const parsed = parseForm4Transactions(raw);
  if (!parsed) return null;

  const id = resolveIdentity(parsed.parties, fallbackName);
  const txs = parsed.transactions;
  const tk = ticker ? ` (${ticker})` : "";

  // Detect exercise-and-sell: an M/A/C (acquisition via exercise/conversion) paired with S (sale).
  // This is a liquidation event, not an administrative non-event.
  const exerciseCodes = new Set(["M", "A", "C", "J"]);
  const exercises = txs.filter(t => exerciseCodes.has(t.code) && t.acquiredDisposed === "A");
  const sales = txs.filter(t => t.code === "S" && t.acquiredDisposed === "D");
  if (exercises.length > 0 && sales.length > 0) {
    const totalSold = sales.reduce((sum, t) => sum + (t.shares ?? 0), 0);
    const totalExercised = exercises.reduce((sum, t) => sum + (t.shares ?? 0), 0);
    const saleValue = sales.reduce((sum, t) => sum + (t.shares && t.price ? t.shares * t.price : 0), 0);
    const exercisePrice = exercises[0].price;
    const salePrice = sales[0].price;
    const lastTx = txs[txs.length - 1];
    const holdsTail = lastTx.ownedAfter !== null ? ` Now holds ${formatNumber(lastTx.ownedAfter)} shares.` : "";
    const when = humanDate(sales[0].date || exercises[0].date || "");
    const who = id.verified ? id.who : "The reporting person";

    return `${who} of ${id.company}${tk} exercised options on ${formatNumber(totalExercised)} shares${exercisePrice ? " at " + formatMoney(exercisePrice) : ""} and simultaneously sold ${formatNumber(totalSold)} shares on the open market${salePrice ? " at ~" + formatMoney(salePrice) : ""}${saleValue ? " (totaling " + formatCompact(saleValue) + ")" : ""} on ${when}.${holdsTail}\n\nThis is an exercise-and-sell — the insider converted options to cash rather than holding the stock. This is a liquidation, not a vote of confidence.`;
  }

  const first = txs[0];
  const sec = cleanSecurity(first.securityTitle || "shares");
  const value = first.shares !== null && first.price !== null ? first.shares * first.price : null;
  const codeMeaning = FORM_4_CODE_LABELS[first.code] || "a transaction described in the filing";
  const when = humanDate(first.date || "");
  const holdsTail = first.ownedAfter !== null ? ` Now holds ${formatNumber(first.ownedAfter)} ${sec}.` : "";
  const spentNote = value !== null ? `, spending ${formatCompact(Math.abs(value))}` : "";
  const indirect = first.directIndirect === "I" ? " (indirect)" : "";

  // Also check if there are multiple sales (bulk selling)
  if (sales.length > 1 && exercises.length === 0) {
    const totalSold = sales.reduce((sum, t) => sum + (t.shares ?? 0), 0);
    const totalValue = sales.reduce((sum, t) => sum + (t.shares && t.price ? t.shares * t.price : 0), 0);
    const lastSale = sales[sales.length - 1];
    const who = id.verified ? id.who : "The reporting person";
    const holds = lastSale.ownedAfter !== null ? ` Now holds ${formatNumber(lastSale.ownedAfter)} shares.` : "";
    return `${who} of ${id.company}${tk} sold a total of ${formatNumber(totalSold)} shares across ${sales.length} transactions on ${humanDate(sales[0].date || "")}${totalValue ? ", totaling " + formatCompact(totalValue) : ""}.${holds}\n\nSales can be discretionary or part of a pre-scheduled 10b5-1 plan — not necessarily a bearish signal. Check the filing footnotes for context.`;
  }

  // Self-consistency guard
  if (first.code === "P" && first.acquiredDisposed === "D") {
    return `⚠ This Form 4 for ${id.company}${tk} shows contradictory data — purchase code with a disposition flag. Don't act on it without checking the original on EDGAR.`;
  }

  if (first.code === "P") {
    const pricedBuy = first.price !== null && first.price > 0;
    if (!id.verified) {
      return `A Form 4 reports an open-market purchase of ${formatNumber(first.shares)} ${sec} of ${id.company}${tk} on ${when}${first.price ? " at " + formatMoney(first.price) : ""}${spentNote}.${holdsTail}\n\nOpen-market buys are typically the most meaningful insider signal, but the buyer could not be identified from this filing — verify on EDGAR before weighting it.`;
    }
    if (!pricedBuy) {
      return `${id.who} of ${id.company}${tk}, acquired ${formatNumber(first.shares)} ${sec} on ${when} — coded as a purchase but no price was disclosed.${holdsTail}\n\nWithout a confirmed price this may not be a standard open-market buy. Check the filing footnotes.`;
    }
    const buyLine = `${id.who} of ${id.company}${tk}, bought ${formatNumber(first.shares)} ${sec} on ${when} at ${formatMoney(first.price)}${spentNote}.${holdsTail}${indirect}`;
    const verdict = id.isEntity
      ? "An open-market purchase by a reporting entity — one of the stronger Form 4 signals."
      : "This is a real insider buy — discretionary capital committed at market price. One of the strongest Form 4 signals.";
    return `${buyLine}\n\n${verdict}`;
  }

  if (first.code === "S") {
    const saleLine = id.verified
      ? `${id.who} of ${id.company}${tk}, sold ${formatNumber(first.shares)} ${sec} on ${when}${first.price ? " at " + formatMoney(first.price) : ""}${spentNote ? spentNote.replace("spending", "totaling") : ""}.${holdsTail}${indirect}`
      : `A Form 4 reports the sale of ${formatNumber(first.shares)} ${sec} of ${id.company}${tk} on ${when}${first.price ? " at " + formatMoney(first.price) : ""}.${holdsTail}`;
    return `${saleLine}\n\nSales can be discretionary or part of a pre-scheduled 10b5-1 plan — not necessarily a bearish signal. Check the filing footnotes for context.`;
  }

  // Administrative codes (A, M, F, G, C, D, J)
  const actorLine = id.verified
    ? `${id.who} of ${id.company}${tk}`
    : `A reporting person at ${id.company}${tk}`;
  return `${actorLine} had an ownership change of ${formatNumber(first.shares)} ${sec} on ${when} — ${codeMeaning}.${holdsTail}${indirect}\n\nThis is an administrative transaction (not an open-market buy or sell), so it doesn't carry the same sentiment signal.`;
}

export async function POST(request: Request) {
  const _quota = await enforceAiQuota(); if (_quota) return _quota;
  void logUsage("sec");
  let body: { contentUrl?: string; formType?: string; entityName?: string; ticker?: string; fileDate?: string };
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Invalid request" }, { status: 400 }); }

  const { contentUrl, formType, entityName, ticker, fileDate } = body;

  if (!contentUrl) {
    return NextResponse.json({ error: "No filing URL provided" }, { status: 400 });
  }

  // A filed SEC document is immutable → its summary is the same for every user, forever. Serve a
  // prior global summary if we have one (cost = $0). One filing = one Anthropic call total, ever.
  const cached = await getCachedText("sec-explain-v16", contentUrl);
  if (cached) return NextResponse.json({ explanation: cached, cached: true });

  // For Form 4: the contentUrl often points to the XSLT-rendered HTML (xslF345X06/primary_doc.xml)
  // where XML tags are stripped. Fetch the raw XML instead so we can parse owner/issuer CIKs.
  let rawXmlUrl = contentUrl;
  if (formType === "4") {
    rawXmlUrl = contentUrl.replace(/\/xsl[^/]+\//, "/");
  }

  // Fetch the actual SEC filing document
  let rawFiling = "";
  let filingText = "";
  const is10 = formType === "10-Q" || formType === "10-K";
  try {
    const res = await fetch(rawXmlUrl, { headers: { ...SEC_HEADERS, Accept: "application/xml,text/xml,text/html,*/*" }, next: { revalidate: 86400 } });
    if (res.ok) {
      rawFiling = await res.text();
      filingText = is10 ? extractFinancialSections(rawFiling) : extractText(rawFiling, 4000);
    }
  } catch { /* fall through to AI with metadata only */ }

  const hasContent = filingText.length > 100;

  if (formType === "4" && rawFiling) {
    const parsedExplanation = explainParsedForm4(rawFiling, entityName, ticker);
    if (parsedExplanation) {
      void setCachedText("sec-explain-v16", contentUrl, parsedExplanation);
      return NextResponse.json({ explanation: parsedExplanation });
    }
  }

  const prompt10 = is10 && hasContent
    ? `You are a financial analyst summarizing an SEC ${formType} for a retail investor doing due diligence.

Company: ${entityName || ticker} (${ticker})
Filed: ${fileDate}

${filingText}

Write a concise summary (2-3 short paragraphs, no title) covering the most important facts for an investor evaluating this business:

1. The headline numbers: revenue, net income/loss, earnings per share, and how they compare to the prior year period. Include operating income/margin if visible.

2. Balance sheet health: cash position, total debt, and free cash flow if visible.

3. One notable detail: a guidance update, risk factor, strategic initiative, or management commentary that would matter to someone deciding whether to buy/hold/sell.

Rules:
- SEC filings report amounts in thousands or millions — check the header. Convert to readable scale ($X.XX billion, $XXX million).
- Use ONLY numbers from the data above. If a metric isn't present, skip it — never guess or say "not available."
- Compute YoY changes from the two periods shown.
- Be specific with numbers. "$152.9M revenue, up 25.6% YoY" not "revenue grew."
- Under 250 words. No disclaimers, no generic advice, no preamble.`
    : null;

  const promptOther = !prompt10 && hasContent
    ? `You are a financial analyst explaining SEC filings to retail investors in plain English.

Filing details:
- Company: ${entityName || ticker}
- Ticker: ${ticker}
- Form type: ${formType}
- Filed: ${fileDate}

Raw filing content:
${filingText}

Format your answer as EXACTLY two numbered points, each 1-2 sentences, with no title or preamble:
1. What the filing actually says — name the key event, the most important 2-3 numbers (dollar amounts, share counts, dates), and who is involved. Do NOT list every item in a long series — summarize the range instead (e.g. "notes maturing from 2026 through 2053 with coupon rates from 0.125% to 3.75%" not each individual note).
2. What it means for investors — one concrete takeaway. Is this actionable or routine?

Rules:
- Be concise. Each point should be 1-2 sentences max. Total response under 100 words.
- For Form 4, do not call it insider buying unless the transaction code is P.
- For Form 4, do not call it insider selling unless the transaction code is S.
- For Form 4 codes A, M, F, G, C, D, or J, explain the administrative/vesting/tax/gift/conversion context instead of inventing investor sentiment.
- Do not infer confidence, bullishness, or near-term prospects unless the filing clearly shows an open-market/private purchase.
- Never enumerate long lists. Summarize the count and range instead.
- No generic disclaimers.`

    : null;

  const promptFallback = !prompt10 && !promptOther
    ? `You are a financial analyst explaining SEC filings to retail investors in plain English.

Filing: ${formType} filed by ${entityName || ticker} on ${fileDate}.
${formType === "4" ? "Form 4 reports changes in beneficial ownership." : ""}
${formType === "8-K" ? "Form 8-K discloses material events." : ""}
${formType === "10-Q" ? "Form 10-Q is a quarterly earnings report." : ""}
${formType === "10-K" ? "Form 10-K is the annual report." : ""}

In 2 sentences, explain what this type of filing typically contains and what investors should look for.`
    : null;

  const prompt = prompt10 || promptOther || promptFallback!;

  try {
    // Free cascade (Cerebras→Groq→Gemini→Haiku) handles all filing types including 10-K/10-Q.
    const explanation = await generateText(prompt);
    void setCachedText("sec-explain-v16", contentUrl, explanation);
    return NextResponse.json({ explanation });
  } catch (e) {
    const raw = e instanceof Error ? e.message : String(e);
    if (raw.includes("credit balance")) void autoDowngradeOnCreditDepletion();
    const friendly = raw.includes("credit balance")
      ? "AI credits depleted — try again later."
      : raw.includes("timeout") || raw.includes("ETIMEDOUT")
        ? "Reading timed out — try again."
        : "Could not read this filing right now.";
    return NextResponse.json({ error: friendly }, { status: 502 });
  }
}
