// Pre-revenue score unit test — verify the capped, discriminating survival grade (Gate 1).
// Run:  npx tsx scripts/prerev-score-test.mjs
import { computePreRevScore, PREREV_SCORE_CAP } from "../src/lib/prerev-score.ts";

let ok = true;
const check = (label, cond, detail = "") => { ok = ok && cond; console.log(`${cond ? "✅" : "❌"} ${label}${detail ? " — " + detail : ""}`); };

console.log("── Pre-revenue score unit test ──\n");

// A strong explorer: 30mo runway, cash-rich, big cushion, positive momentum → top of the band
const strong = computePreRevScore({ runwayMonths: 30, netCash: 80e6, totalCash: 100e6, marketCap: 200e6, dayChangePct: 4 });
// A doomed one: 2mo runway, net debt, falling
const weak = computePreRevScore({ runwayMonths: 2, netCash: -20e6, totalCash: 5e6, marketCap: 300e6, dayChangePct: -3 });

check("strong is non-null", !!strong, `score=${strong && strong.score}`);
check("weak is non-null", !!weak, `score=${weak && weak.score}`);

// THE CORE RULE: never beats a good company. Cap respected, and even the best pre-rev stays < 7.
check("strong respects the cap (≤ " + PREREV_SCORE_CAP + ")", strong.score <= PREREV_SCORE_CAP, `score=${strong.score}`);
check("best pre-rev stays BELOW the 'good company' band (< 7)", strong.score < 7, `score=${strong.score}`);

// Discriminates good vs bad clearly
check("strong clearly beats weak", strong.score - weak.score >= 2.5, `${strong.score} vs ${weak.score}`);
check("weak is low (≤ 2.5)", weak.score <= 2.5, `score=${weak.score}`);

// Components present, 0–10 bars
check("3 component bars", strong.components.length === 3);
check("bars within 0–10", strong.components.every(c => c.value >= 0 && c.value <= 10), JSON.stringify(strong.components.map(c=>c.value)));
check("strong survival bar is high", strong.components[0].value >= 8, `runway bar=${strong.components[0].value}`);

// Sparse data: runway unknown but cash-rich → still scores (not null), still capped
const sparse = computePreRevScore({ runwayMonths: null, netCash: 40e6, totalCash: 50e6, marketCap: 120e6, dayChangePct: null });
check("sparse (no runway) still scores", !!sparse && sparse.score > 0, `score=${sparse && sparse.score}`);
check("sparse respects cap", sparse.score <= PREREV_SCORE_CAP);

// Genuinely nothing to judge → null (caller shows N/A)
check("no data at all → null", computePreRevScore({ runwayMonths: null, netCash: null, totalCash: null, marketCap: null, dayChangePct: null }) === null);

console.log(`\n${ok ? "✅ ALL PASS" : "❌ FAILURES — see above"}`);
process.exit(ok ? 0 : 1);
