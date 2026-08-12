// Data-accuracy harness — hits the PUBLIC /api/xray/{T} JSON for a broad basket and checks
// every ticker against consistency invariants + scoring sanity. $0, no auth. Validation is by
// INTERNAL CONSISTENCY + cross-field recompute (this is a simulated timeline — memorized real-world
// values are invalid; see project memory). Run: node scripts/accuracy-harness.mjs
const BASE = "https://plainviewintel.com/api/xray/";

const TICKERS = [
  // mega/large-cap quality
  "AAPL","MSFT","NVDA","GOOGL","AMZN","META","KO","JNJ","PG","WMT","JPM","V","MA","HD","XOM","CVX","COST","UNH",
  // mid / varied
  "TSLA","AMD","INTC","DIS","NKE","SBUX","PYPL","UBER","F","GM","BA","PLTR","COIN","HOOD","SHOP",
  // weak / meme / turnaround
  "AMC","GME","BB","NOK","SOFI","LCID","RIVN","CHWY","WBD",
  // pre-rev / speculative / miners / space
  "SLS","SMR","ARAAF","TMQ","JOBY","MP","RKLB","ACHR","NU",
  // banks (margin/GM often N/A by design)
  "BAC","WFC","C",
  // ETFs
  "SPY","QQQ","VTI","ARKK","XLE","XLF",
  // crypto
  "BTC-USD","ETH-USD","SOL-USD",
];

function parseNum(v) {
  if (v == null) return null;
  let s = String(v).trim();
  if (!s || /^n\/a$/i.test(s)) return null;
  const neg = /^-|\(/.test(s) || /\$-/.test(s);
  s = s.replace(/[$,%xX×()\s]/g, "");
  let mult = 1;
  if (/B$/i.test(s)) { mult = 1e9; s = s.replace(/B$/i, ""); }
  else if (/T$/i.test(s)) { mult = 1e12; s = s.replace(/T$/i, ""); }
  else if (/M$/i.test(s)) { mult = 1e6; s = s.replace(/M$/i, ""); }
  else if (/K$/i.test(s)) { mult = 1e3; s = s.replace(/K$/i, ""); }
  let f = parseFloat(s.replace(/^-/, ""));
  if (!isFinite(f)) return null;
  return (neg ? -1 : 1) * f * mult;
}

async function fetchXray(t) {
  try {
    const r = await fetch(BASE + encodeURIComponent(t), { headers: { "user-agent": "pv-accuracy-harness" } });
    if (!r.ok) return { t, httpError: r.status };
    return { t, j: await r.json() };
  } catch (e) { return { t, fetchError: String(e.message || e) }; }
}

function analyze(t, j) {
  const all = [...(j.metrics || []), ...(j.valuation || [])];
  const g = (l) => { const x = all.find((m) => m.label === l); return x ? x.value : null; };
  const n = (l) => parseNum(g(l));
  const flags = [];
  const score = (typeof j.score === "number") ? j.score : null;
  const kind = j.scoreKind || (j.scoreUnavailable ? "n/a" : "?");

  // score range
  if (score != null && (score < 0 || score > 10)) flags.push(`SCORE out of range: ${score}`);
  if (score == null && !j.scoreUnavailable) flags.push(`SCORE null but no scoreUnavailable flag`);

  // components in [0,10]
  const comp = j.scoreComponents;
  if (comp && !Array.isArray(comp)) {
    for (const [k, v] of Object.entries(comp)) if (v != null && (v < 0 || v > 10)) flags.push(`component ${k} out of range: ${v}`);
  } else if (Array.isArray(comp)) {
    for (const c of comp) if (c.value != null && (c.value < 0 || c.value > 10)) flags.push(`component ${c.label} out of range: ${c.value}`);
  }

  // fundamentals invariants
  const gm = n("Gross Margin");
  if (gm != null && (gm < 0 || gm > 100)) flags.push(`GROSS MARGIN out of [0,100]: ${g("Gross Margin")}`);
  const ps = n("P/S Ratio");
  if (ps != null && (ps <= 0 || ps > 2000)) flags.push(`P/S absurd: ${g("P/S Ratio")}`);
  const roe = n("Return on Equity");
  // recompute P/S from price * shares / revenue
  const price = n("Current Price"), shares = n("Shares Outstanding"), rev = n("Revenue TTM");
  if (ps != null && price && shares && rev && rev > 0) {
    const calcPS = (price * shares) / rev;
    const diff = Math.abs(calcPS - ps) / ps;
    if (diff > 0.20) flags.push(`P/S mismatch: reported ${ps.toFixed(2)} vs recomputed ${calcPS.toFixed(2)} (Δ${(diff * 100).toFixed(0)}%)`);
  }
  // market cap vs price*shares
  const mc = n("Market Cap");
  if (mc && price && shares) {
    const calc = price * shares;
    const diff = Math.abs(calc - mc) / mc;
    if (diff > 0.06) flags.push(`MktCap mismatch: reported ${(mc/1e9).toFixed(1)}B vs price×shares ${(calc/1e9).toFixed(1)}B (Δ${(diff*100).toFixed(0)}%)`);
  }
  // day change sanity
  if (j.dayChangePct != null && Math.abs(j.dayChangePct) > 40) flags.push(`day change implausible: ${j.dayChangePct}%`);
  // RSI sanity
  const rsi = n("RSI");
  if (rsi != null && (rsi < 0 || rsi > 100)) flags.push(`RSI out of [0,100]: ${g("RSI")}`);
  // short float sanity
  if (j.shortPctFloat != null && (j.shortPctFloat < 0 || j.shortPctFloat > 1)) flags.push(`shortPctFloat not a fraction: ${j.shortPctFloat}`);

  // classification consistency
  if (kind === "stock" && rev === 0) flags.push(`STOCK-kind but $0 revenue (should be pre-rev?)`);

  // growth component value (stock kind)
  const growth = comp && !Array.isArray(comp) ? comp.growth : null;

  return { t, score, kind, name: (j.name || "").slice(0, 24), rev, gm, ps, growth, comp, flags };
}

(async () => {
  const out = [];
  for (let i = 0; i < TICKERS.length; i += 5) {
    const batch = TICKERS.slice(i, i + 5);
    const res = await Promise.all(batch.map(fetchXray));
    for (const r of res) {
      if (r.httpError) { out.push({ t: r.t, err: `HTTP ${r.httpError}` }); continue; }
      if (r.fetchError) { out.push({ t: r.t, err: r.fetchError }); continue; }
      out.push(analyze(r.t, r.j));
    }
    await new Promise((z) => setTimeout(z, 200));
  }

  // ---- Report ----
  const ok = out.filter((o) => !o.err);
  console.log(`\n===== ACCURACY HARNESS — ${ok.length}/${TICKERS.length} tickers loaded =====\n`);

  // 1) HARD INVARIANT VIOLATIONS
  const violations = ok.filter((o) => o.flags && o.flags.length);
  console.log(`--- INVARIANT VIOLATIONS (${violations.length} tickers) ---`);
  if (!violations.length) console.log("  none 🎉");
  for (const v of violations) console.log(`  ${v.t.padEnd(8)} ${(String(v.score)+'/10').padEnd(7)} ${v.kind.padEnd(7)} | ${v.flags.join(" ; ")}`);
  const errs = out.filter((o) => o.err);
  if (errs.length) { console.log(`\n  fetch/parse errors:`); errs.forEach((e) => console.log(`   ${e.t}: ${e.err}`)); }

  // 2) SCORING ANOMALIES
  console.log(`\n--- SCORING ANOMALIES ---`);
  const stocks = ok.filter((o) => o.kind === "stock" && o.score != null);
  const prerev = ok.filter((o) => o.kind === "prerev" && o.score != null);
  // inversion: any prerev scoring >= a stock with real revenue
  const minStock = stocks.length ? Math.min(...stocks.map((s) => s.score)) : null;
  const invs = prerev.filter((p) => stocks.some((s) => p.score > s.score));
  console.log(`  Pre-rev names outranking a real (revenue) company:`);
  for (const p of invs) {
    const beaten = stocks.filter((s) => p.score > s.score).sort((a,b)=>a.score-b.score).slice(0,3).map((s)=>`${s.t} ${s.score}`).join(", ");
    console.log(`    ${p.t} (${p.score}/10, $0 rev) > ${beaten}`);
  }
  if (!invs.length) console.log("    none");
  // growth saturation
  const growths = stocks.map((s) => s.growth).filter((v) => v != null);
  const counts = {};
  growths.forEach((v) => counts[v] = (counts[v] || 0) + 1);
  console.log(`  Growth sub-score distribution (stock-kind): ${Object.entries(counts).sort((a,b)=>b[1]-a[1]).map(([v,c])=>`${v}=${c}`).join("  ")}`);

  // 3) FULL RANKED TABLE
  console.log(`\n--- RANKED (all loaded) ---`);
  ok.filter((o)=>o.score!=null).sort((a, b) => b.score - a.score).forEach((o) => {
    const compStr = o.comp && !Array.isArray(o.comp) ? Object.entries(o.comp).filter(([,v])=>v!=null).map(([k,v])=>`${k[0]}${v}`).join(" ") : (Array.isArray(o.comp)?o.comp.map(c=>`${c.label[0]}${c.value}`).join(" "):"");
    console.log(`  ${(o.score+'/10').padEnd(7)} ${o.kind.padEnd(7)} ${o.t.padEnd(8)} ${o.name.padEnd(25)} ${compStr}`);
  });
  const naScore = ok.filter((o)=>o.score==null);
  if (naScore.length) console.log(`  N/A score: ${naScore.map(o=>o.t).join(", ")}`);

  // 4) DETERMINISM re-fetch
  console.log(`\n--- DETERMINISM (re-fetch 6, score should be stable) ---`);
  for (const t of ["AAPL","AMC","SLS","NVDA","GME","SPY"]) {
    const a = ok.find((o) => o.t === t)?.score;
    const r2 = await fetchXray(t);
    const b = r2.j && typeof r2.j.score === "number" ? r2.j.score : null;
    console.log(`  ${t.padEnd(6)} ${a} -> ${b}  ${a===b?"✓ stable":"⚠ DRIFT"}`);
  }
  console.log("");
})();
