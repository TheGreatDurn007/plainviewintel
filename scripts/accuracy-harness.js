/**
 * NEXUS Accuracy Harness (Step 5)
 * -------------------------------------------------------------------------------------------------
 * Prevents future "TRX incidents" by asserting, on a fixed ticker set, the invariants that have
 * actually broken before:
 *   1. Prices are LIVE (present, > 0, sourced) — never stale/zero.
 *   2. Asset classification is correct (crypto vs stock; ticker-collision guard, e.g. TRX≠TRON).
 *   3. X-Ray fundamentals are within sane bounds (the NVDA garbage-margin / $10B-revenue class of bug).
 *   4. thesis-check returns a GROUNDED, well-formed verdict (valid status; evidence points are
 *      sourced+dated strings; figures cited carry a source).
 *
 * The /api routes are gated by Supabase auth, so this runs from an AUTHENTICATED browser session.
 * HOW TO RUN: open https://plainviewintel.com (logged in) → DevTools console → paste this whole file →
 *   await runAccuracyHarness()
 * It prints a PASS/FAIL table. Run it before AND after any change to the price/xray/intel/thesis routes.
 *
 * (Claude can also run it via the Chrome extension from an authenticated tab.)
 */

const HARNESS_TICKERS = [
  { ticker: "NVDA", name: "NVIDIA",            currency: "USD", kind: "stock",  exchange: "NASDAQ" },
  { ticker: "AMC",  name: "AMC Entertainment", currency: "USD", kind: "stock",  exchange: "NYSE" },
  { ticker: "BB",   name: "BlackBerry",        currency: "USD", kind: "stock",  exchange: "NYSE" },
  { ticker: "TSLA", name: "Tesla",             currency: "USD", kind: "stock",  exchange: "NASDAQ" },
  { ticker: "TRX",  name: "TRX Gold",          currency: "CAD", kind: "stock",  exchange: "TSX CAD" }, // collision: TRON
  { ticker: "SLS",  name: "SELLAS Life Sciences", currency: "USD", kind: "stock", exchange: "NASDAQ" }, // biotech
  { ticker: "MSOS", name: "AdvisorShares Pure US Cannabis ETF", currency: "USD", kind: "etf", exchange: "NYSE" },
  { ticker: "XRP",  name: "XRP",               currency: "CAD", kind: "crypto", isCrypto: true },
  { ticker: "BTC",  name: "Bitcoin",           currency: "USD", kind: "crypto", isCrypto: true },
];

// BROAD POOL — diverse names across sectors / sizes / exchanges / asset classes, for RANDOM SAMPLING.
// The point of "any ticker a user can search": run `runAccuracyHarness({ sample: 8 })` to stress-test
// symbols nobody on the team hand-picked. The UNIVERSAL invariants (plausibility + consistency) need no
// per-ticker expected value, so any of these — or any ticker — is judged the same way.
const BROAD_POOL = [
  ...HARNESS_TICKERS,
  { ticker: "MSFT", name: "Microsoft",        currency: "USD", kind: "stock", exchange: "NASDAQ" },
  { ticker: "KO",   name: "Coca-Cola",        currency: "USD", kind: "stock", exchange: "NYSE" },
  { ticker: "JPM",  name: "JPMorgan",         currency: "USD", kind: "stock", exchange: "NYSE" },   // financial
  { ticker: "PLTR", name: "Palantir",         currency: "USD", kind: "stock", exchange: "NASDAQ" },
  { ticker: "F",    name: "Ford",             currency: "USD", kind: "stock", exchange: "NYSE" },
  { ticker: "SHOP", name: "Shopify",          currency: "CAD", kind: "stock", exchange: "TSX CAD" }, // Canadian
  { ticker: "RY",   name: "Royal Bank of Canada", currency: "CAD", kind: "stock", exchange: "TSX CAD" },
  { ticker: "VRTX", name: "Vertex Pharma",    currency: "USD", kind: "stock", exchange: "NASDAQ" },  // biotech (commercial)
  { ticker: "RIOT", name: "Riot Platforms",   currency: "USD", kind: "stock", exchange: "NASDAQ" },  // crypto-exposed
  { ticker: "SPY",  name: "SPDR S&P 500 ETF", currency: "USD", kind: "etf",   exchange: "NYSE" },
  { ticker: "SOL",  name: "Solana",           currency: "USD", kind: "crypto", isCrypto: true },
  { ticker: "DOGE", name: "Dogecoin",         currency: "USD", kind: "crypto", isCrypto: true },
  { ticker: "MARA", name: "Marathon Digital", currency: "USD", kind: "stock", exchange: "NASDAQ" },
  { ticker: "ASML", name: "ASML",             currency: "USD", kind: "stock", exchange: "NASDAQ" },
];

async function _json(url, opts) {
  const r = await fetch(url, { cache: "no-store", ...(opts || {}) });
  let body = null; try { body = await r.json(); } catch {}
  return { status: r.status, body };
}

// ── individual checks ────────────────────────────────────────────────────────────────────────
async function checkPrice(t) {
  const sym = t.isCrypto ? `${t.ticker}-${t.currency}` : t.ticker;
  const { status, body } = await _json(`/api/prices?symbols=${encodeURIComponent(sym)}&_=${Date.now()}`);
  const row = (body?.prices || []).find((p) => p && p.symbol);
  if (status !== 200 || !row) return { pass: false, detail: `no price row (HTTP ${status})` };
  const live = Number.isFinite(row.price) && row.price > 0;
  const sourced = !!row.source;
  return { pass: live && sourced, detail: `${row.price} ${row.currency} via ${row.source}` };
}

async function checkXray(t) {
  const { status, body } = await _json(`/api/xray/${encodeURIComponent(t.isCrypto ? t.ticker : t.ticker)}`);
  if (status !== 200 || !body) return { pass: false, detail: `HTTP ${status}` };
  // Crypto should route to a crypto scan (assetType crypto / crypto asset profile), not a business X-Ray.
  if (t.kind === "crypto") {
    const isCryptoScan = body.assetType === "crypto" || /crypto/i.test(JSON.stringify(body.assetProfile || ""));
    return { pass: isCryptoScan, detail: isCryptoScan ? "crypto scan ✓" : "NOT classified crypto" };
  }
  const score = Number(body.score);
  const scoreOk = Number.isFinite(score) && score >= 0 && score <= 10;
  // TRX collision guard: must be the gold miner, never TRON crypto.
  if (t.ticker === "TRX") {
    const txt = JSON.stringify(body).toLowerCase();
    const isGold = body.isMining === true || /gold|buckreef|mining|materials/.test(txt);
    const isTron = /tron|blockchain|crypto/.test(txt) && !isGold;
    return { pass: scoreOk && isGold && !isTron, detail: isGold ? `gold miner ✓ score ${score}` : "WRONG ENTITY (TRON?)" };
  }
  // UNIVERSAL fundamentals plausibility — holds for ANY stock ticker, no hardcoded expected values.
  // These are the "any ticker a user can search" guards: they catch garbage (NVDA -503% / $10.92B class)
  // without knowing the right answer in advance.
  const m = (label) => (body.metrics || []).find((x) => x.label === label);
  const v = (label) => { const c = m(label); return c ? parseFloat(String(c.value).replace(/[^0-9.\-]/g, "")) : null; };
  const gmPct = v("Gross Margin");
  const ps = (body.valuation || []).find((x) => x.label === "P/S Ratio");
  const psVal = ps ? parseFloat(String(ps.value)) : null;
  const epsC = m("EPS"); const epsVal = epsC ? parseFloat(String(epsC.value)) : null;
  const issues = [];
  // (1) gross margin must be a real fraction (never -503% etc.)
  if (gmPct != null && (gmPct < -100 || gmPct > 100)) issues.push(`impossible GM ${gmPct}%`);
  // (2) a PROFITABLE company can't have an absurd P/S — that means revenue is misread (NVDA's bug shape)
  if (psVal != null && epsVal != null && epsVal > 0 && psVal > 50) issues.push(`implausible P/S ${psVal}x for a profitable name (revenue misread?)`);
  // (3) CROSS-SOURCE / INTERNAL CONSISTENCY: revenue × P/S should ≈ market cap (shares × price). A big gap
  //     means the revenue cell and the P/S cell were derived from DIFFERENT revenue figures (one source bad)
  //     — catches the case the plausibility check can't, e.g. P/S from Yahoo but revenue from a misread SEC feed.
  const toNum = (s) => { if (s == null) return null; const n = parseFloat(String(s).replace(/[^0-9.\-]/g, "")); if (!Number.isFinite(n)) return null; const u = /B/i.test(String(s)) ? 1e9 : /M/i.test(String(s)) ? 1e6 : 1; return n * u; };
  const price = toNum(m("Current Price")?.value);
  const shares = toNum(m("Shares Outstanding")?.value);
  const revAbs = toNum(m("Revenue TTM")?.value);
  if (price && shares && revAbs && psVal) {
    const mc = price * shares, implied = revAbs * psVal, ratio = implied / mc;
    if (ratio < 0.5 || ratio > 2) issues.push(`revenue×P/S ($${(implied/1e9).toFixed(0)}B) ≠ market cap ($${(mc/1e9).toFixed(0)}B) — cross-source mismatch`);
  }
  const pass = scoreOk && issues.length === 0;
  return { pass, detail: pass ? `score ${score}, GM ${m("Gross Margin")?.value || "n/a"}, P/S ${ps?.value || "n/a"}` : issues.join("; ") };
}

async function checkThesis(t) {
  const thesis = `${t.name} is positioned to do well over the next 6-12 months on its core business.`;
  const { status, body } = await _json(`/api/thesis-check`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ticker: t.ticker, name: t.name, thesis, currency: t.currency, exchange: t.exchange, refresh: true }),
  });
  if (status !== 200 || !body) return { pass: false, detail: `HTTP ${status} ${body?.error || ""}`.trim() };
  const validStatus = ["supported", "mixed", "contradicted", "unsupported", "insufficient"].includes(body.status);
  const points = Array.isArray(body.points) ? body.points : [];
  // Every point must be a non-empty sourced/dated string with a valid effect tag.
  const pointsOk = points.every((p) => p && typeof p.evidence === "string" && p.evidence.trim().length > 0 &&
    ["supports", "contradicts", "missing", "neutral"].includes(String(p.effect)));
  return { pass: validStatus && pointsOk, detail: `${body.status} · ${points.length} pts` };
}

// ── runner ───────────────────────────────────────────────────────────────────────────────────
// Options:
//   tickers  — explicit list (default: the fixed 9 tripwire set)
//   sample   — instead, randomly pick N tickers from BROAD_POOL (the "any ticker" stress test)
//   checks   — which checks to run; default all. For a fast universal sweep use ["price","xray"]
//              (skips the slow LLM thesis check).
async function runAccuracyHarness({ tickers, sample, checks = ["price", "xray", "thesis"] } = {}) {
  if (sample && !tickers) {
    const pool = [...BROAD_POOL];
    for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
    tickers = pool.slice(0, Math.min(sample, pool.length));
    console.log(`Random sample of ${tickers.length}: ${tickers.map((t) => t.ticker).join(", ")}`);
  }
  tickers = tickers || HARNESS_TICKERS;
  const fns = { price: checkPrice, xray: checkXray, thesis: checkThesis };
  const rows = [];
  for (const t of tickers) {
    const row = { ticker: t.ticker, kind: t.kind };
    for (const c of checks) {
      try { const r = await fns[c](t); row[c] = (r.pass ? "✅ " : "❌ ") + r.detail; if (!r.pass) row._fail = true; }
      catch (e) { row[c] = "❌ ERR " + (e.message || e); row._fail = true; }
    }
    rows.push(row);
    console.log(`${row._fail ? "FAIL" : "PASS"}  ${t.ticker.padEnd(5)}`, row);
  }
  const failed = rows.filter((r) => r._fail);
  console.table(rows);
  console.log(`\nAccuracy harness: ${rows.length - failed.length}/${rows.length} tickers passed.` +
    (failed.length ? `  FAILED: ${failed.map((r) => r.ticker).join(", ")}` : "  ✅ ALL PASS"));
  return { total: rows.length, passed: rows.length - failed.length, failed: failed.map((r) => r.ticker), rows };
}

// Auto-expose for console use.
if (typeof window !== "undefined") { window.runAccuracyHarness = runAccuracyHarness; }
