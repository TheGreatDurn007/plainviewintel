import { NextResponse } from "next/server";
import { z } from "zod";
import { readTickerMemory, fetchSecSignals, type SecSignal } from "@/lib/market-context";

// ─── SEC Alerts — proactive filing notifications ──────────────────────────────
// Accepts a list of tickers (portfolio + watchlist) + a "since" timestamp.
// Returns new SEC filings of alert-worthy types filed since that date.
//
// Uses ticker memory first (instant — already populated by Intel/XRay/Radar routes).
// Falls back to live EDGAR fetch if memory is cold or stale.
// Fails open per ticker — one bad ticker never blocks the rest.

// Filing types that warrant a user alert (per Codex guardrails — SEC alerts only, this round)
const ALERT_FORMS = new Set([
  "4",                        // insider buy/sell
  "8-K", "8-K/A",             // material events (agreements, bankruptcy, restatement, covenant)
  "10-K", "10-K/A",           // annual report
  "10-Q", "10-Q/A",           // quarterly report
  "S-3", "S-3/A",             // shelf registration (potential dilution)
  "424B3", "424B4", "424B5",  // active offering (near-term dilution)
  "NT 10-Q", "NT 10-K", "NT 20-F", // late filing notices
  "SC 13D", "SC 13D/A",       // 5%+ activist/strategic stakeholder
  "SC 13G", "SC 13G/A",       // passive 5%+ holder
]);

const Body = z.object({
  tickers: z.array(z.string().min(1)).min(1).max(150),
  since: z.string().optional(), // ISO date string — default 7 days ago
});

/** Detect raw EDGAR header boilerplate masquerading as a real snippet.
 *  These patterns appear in the first ~1KB of any filing but contain zero investor signal. */
function isBoilerplate(text: string): boolean {
  if (!text || text.length < 10) return true;
  const t = text.trim();
  // Filename fragment, registration numbers, or "Filed Pursuant to Rule NNN" = raw header
  if (/\.(htm|txt|xml)\b/i.test(t)) return true;
  if (/registration\s+no\.?\s+\d{3}-\d+/i.test(t)) return true;
  if (/filed\s+pursuant\s+to\s+rule\s+\d/i.test(t)) return true;
  if (/commission\s+file\s+number/i.test(t)) return true;
  // Starts with the form type repeated (e.g. "424B3 1 dh25828d424b3.htm 424B3")
  if (/^(424B|S-3|10-K|10-Q|8-K|SC 13)/i.test(t) && /\d{5,}/.test(t.slice(0, 60))) return true;
  return false;
}

/** Map 8-K item codes to plain-English labels. */
function describeItems(items: string): string {
  const map: Record<string, string> = {
    "1.01": "material agreement entered",
    "1.02": "material agreement terminated",
    "1.03": "bankruptcy or receivership",
    "1.04": "mine safety — reportable incident",
    "2.01": "acquisition or disposition of assets",
    "2.02": "results of operations / earnings release",
    "2.03": "new debt obligation created",
    "2.04": "triggering events — debt acceleration risk",
    "2.05": "cost-cutting or exit plan",
    "2.06": "material impairment charge",
    "3.01": "delisting notice from exchange",
    "3.02": "unregistered equity sale",
    "3.03": "material modification to shareholder rights",
    "4.01": "change of auditor",
    "4.02": "non-reliance on prior financials — restatement risk",
    "5.01": "change in control",
    "5.02": "director / officer departure or appointment",
    "5.03": "articles or bylaws amended",
    "5.04": "temporary suspension of trading plan",
    "5.05": "executive compensation amendment",
    "5.06": "shell company status change",
    "5.07": "shareholder vote results",
    "5.08": "shareholder nomination deadline",
    "6.01": "ABS informational disclosures",
    "7.01": "Regulation FD disclosure",
    "8.01": "other material events",
    "9.01": "financial statements / exhibits filed",
  };
  const codes = items.split(/[,\s]+/).map(c => c.trim()).filter(Boolean);
  const labels = codes.map(c => map[c]).filter(Boolean);
  if (!labels.length) return `Item ${items}`;
  // Deduplicate and show up to 3
  const unique = [...new Set(labels)].slice(0, 3);
  return unique.join("; ");
}

/** Build human-readable alert text. Neutral and careful per Codex guardrails:
 *  insider sales are not automatically bearish; buys carry stronger signal. */
function buildAlertText(sig: SecSignal): string {
  const { form, summary, items } = sig;
  const snippet = !isBoilerplate(summary) ? summary : "";

  if (form === "4") {
    return summary.slice(0, 200) + (summary.length > 200 ? "…" : "");
  }

  if (form === "NT 10-Q" || form === "NT 10-K" || form === "NT 20-F") {
    return "Late filing notice — company could not file on time. Check for reason (audit, restatement, liquidity)";
  }

  if (form === "8-K" || form === "8-K/A") {
    // Item codes are the most reliable signal — map them first
    const itemLabel = items ? describeItems(items) : "";
    // High-signal keyword overrides
    if (/bankruptcy|receivership/i.test(snippet)) return `Bankruptcy or receivership filing${items ? ` (Item ${items})` : ""}`;
    if (/non.reliance|restatement/i.test(snippet)) return `Non-reliance on prior financials — restatement risk${items ? ` (Item ${items})` : ""}`;
    if (/covenant|debt acceleration/i.test(snippet)) return `Debt covenant or acceleration event${items ? ` (Item ${items})` : ""}`;
    if (itemLabel) {
      return itemLabel.charAt(0).toUpperCase() + itemLabel.slice(1);
    }
    return snippet ? snippet.slice(0, 250) + (snippet.length > 250 ? "…" : "") : `8-K filed${items ? ` (Item ${items})` : ""} — read for substance`;
  }

  if (form === "10-K" || form === "10-K/A") {
    return snippet ? snippet.slice(0, 250) + (snippet.length > 250 ? "…" : "") : "Annual report filed — review financials and risk factors";
  }

  if (form === "10-Q" || form === "10-Q/A") {
    return snippet ? snippet.slice(0, 250) + (snippet.length > 250 ? "…" : "") : "Quarterly report filed — review results and guidance";
  }

  if (form === "S-3" || form === "S-3/A") {
    const low = snippet.toLowerCase();
    if (/selling stockholder|resale|resell|no proceeds to the company/.test(low))
      return "Shelf registration for resale — existing holders registering shares, no new dilution from this filing.";
    if (/we are offering|we are selling|aggregate offering|proceeds to (?:us|the company)/.test(low))
      return "Shelf registration — company authorized to issue new shares in future offerings. Potential dilution.";
    return snippet ? snippet.slice(0, 250) + (snippet.length > 250 ? "…" : "") : "Shelf registration filed — shares authorized for future offering (not an active sale yet)";
  }

  if (form === "424B3" || form === "424B4" || form === "424B5") {
    const low = snippet.toLowerCase();
    const isResale = /selling stockholder|resale|resell|previously issued|no proceeds to the company/.test(low);
    const isActive = /we are offering|we are selling|new shares|aggregate offering price|proceeds to (?:us|the company)/.test(low);
    const isWarrant = /issuable upon exercise of warrant|shares of common stock issuable|upon exercise of the warrant/.test(low);
    if (isResale)
      return "Resale prospectus — existing holders selling registered shares, company receives no proceeds. No new dilution.";
    if (isActive)
      return `Active offering — company issuing new shares, dilutive to existing holders.${snippet ? " " + snippet.slice(0, 160) + (snippet.length > 160 ? "…" : "") : ""}`;
    if (isWarrant)
      return `Warrant exercise prospectus — shares issuable upon warrant exercise. Potential dilution if warrants are exercised.${snippet ? " " + snippet.slice(0, 160) + (snippet.length > 160 ? "…" : "") : ""}`;
    return snippet ? snippet.slice(0, 280) + (snippet.length > 280 ? "…" : "") : "Prospectus supplement filed — review to determine if resale registration (no dilution) or active share offering (dilutive).";
  }

  if (form === "SC 13D" || form === "SC 13D/A") {
    return snippet ? snippet.slice(0, 250) + (snippet.length > 250 ? "…" : "") : "New 13D: 5%+ stakeholder with active intent — may be activist, strategic, or control-related";
  }

  if (form === "SC 13G" || form === "SC 13G/A") {
    return snippet ? snippet.slice(0, 250) + (snippet.length > 250 ? "…" : "") : "New 13G: 5%+ passive institutional holder or fund — read for size and identity";
  }

  return snippet ? snippet.slice(0, 130) + (snippet.length > 130 ? "…" : "") : `${form} filed`;
}

/** Stable filing ID for dedup/dismiss state stored client-side */
function filingId(ticker: string, sig: SecSignal): string {
  return `${ticker}_${sig.form}_${sig.date}`.replace(/\s+/g, "_").replace(/[^A-Za-z0-9_.-]/g, "");
}

/** EDGAR search URL — enough for "View Filing" link without needing the accession number */
function edgarUrl(ticker: string, form: string): string {
  return `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${encodeURIComponent(ticker)}&type=${encodeURIComponent(form)}&dateb=&owner=include&count=10&search_text=`;
}

export const maxDuration = 30;

export async function POST(request: Request) {
  let body: unknown;
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Bad JSON" }, { status: 400 }); }

  const parsed = Body.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid request" }, { status: 400 });

  const { tickers, since } = parsed.data;
  // 10-K/10-Q: only alert if filed within last 7 days (otherwise every portfolio ticker
  // would have a 10-Q dot from the most recent quarterly — that's noise, not an alert)
  const tenKQSince = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const sinceDate = since ? new Date(since) : new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
  const sinceDateStr = sinceDate.toISOString().slice(0, 10);
  const memTtl = 6 * 60 * 60 * 1000; // 6h — SEC filings don't change once posted; new ones are caught on next refresh

  // Deduplicate after warrant/unit normalization so INFQ.WS → INFQ doesn't double-fetch
  const normalizeForSec = (t: string) =>
    t.toUpperCase().replace(/\.(WS|WT|WS\.A|WS\.B|U|UN|R|RT)$/i, "");
  const secTickers = [...new Set(tickers.map(normalizeForSec))];

  const perTicker = await Promise.all(
    secTickers.map(async (rawTicker) => {
      const ticker = rawTicker.toUpperCase();
      try {
        let signals: SecSignal[] = [];

        // Try memory first (fast — already stored by Intel/XRay/Radar)
        const memory = await readTickerMemory(ticker);
        const memAge = memory?.secUpdatedAt
          ? Date.now() - new Date(memory.secUpdatedAt).getTime()
          : Infinity;

        if (memory?.secSignals?.length && memAge < memTtl) {
          signals = memory.secSignals;
        } else {
          // Memory cold or stale — live EDGAR fetch with 5s cap
          signals = await Promise.race([
            fetchSecSignals(ticker),
            new Promise<SecSignal[]>(r => setTimeout(() => r([]), 5000)),
          ]);
        }

        // Filter: alert-worthy form + filed since the requested date
        // 10-K / 10-Q are high-frequency so only alert on very recent filings (7 days)
        const filtered = signals.filter(s => {
          if (!ALERT_FORMS.has(s.form)) return false;
          if (s.form === "10-K" || s.form === "10-K/A" || s.form === "10-Q" || s.form === "10-Q/A") {
            return s.date >= tenKQSince;
          }
          return s.date >= sinceDateStr;
        });

        // Group Form 4s per ticker — show one consolidated alert (most recent date)
        // with a count note rather than flooding the banner with every individual filing
        const form4s = filtered.filter(s => s.form === "4").sort((a, b) => b.date.localeCompare(a.date));
        const others = filtered.filter(s => s.form !== "4");

        const deduped: typeof filtered = [...others];
        if (form4s.length > 0) {
          const top = form4s[0];
          const countNote = form4s.length > 1 ? ` (${form4s.length} filings in window)` : "";
          deduped.push({
            ...top,
            summary: top.summary + countNote,
          });
        }

        // Max 3 alerts per ticker so one noisy ticker can't bury others
        const capped = deduped.slice(0, 3);

        const alerts = capped.map(s => ({
          ticker,
          form: s.form,
          date: s.date,
          signal: s.signal,
          summary: s.summary,
          items: s.items ?? null,
          alertText: buildAlertText(s),
          filingId: filingId(ticker, s),
          edgarUrl: edgarUrl(ticker, s.form),
          source: "SEC EDGAR",
        }));

        return alerts;
      } catch {
        return []; // fail open — one bad ticker never blocks the batch
      }
    })
  );

  const alerts = perTicker
    .flat()
    .sort((a, b) => b.date.localeCompare(a.date)); // newest first

  return NextResponse.json({
    alerts,
    checked: secTickers.length,
    since: sinceDateStr,
    ts: new Date().toISOString(),
  });
}
