// ════════════════════════════════════════════════════════════════════════════════════════════
// Form 4 insight unit test — verify the deterministic conviction + stake-delta logic (P0.3).
// Pure, no DB/network. Run:  npx tsx scripts/form4-insight-test.mjs
// ════════════════════════════════════════════════════════════════════════════════════════════
import { buildForm4Insight, form4PurchaseSummary, form4Action } from "../src/lib/form4-insight.ts";

let ok = true;
const check = (label, cond, detail = "") => { ok = ok && cond; console.log(`${cond ? "✅" : "❌"} ${label}${detail ? " — " + detail : ""}`); };

const parsed = (over = {}) => ({
  codes: [{ code: "P", shares: 10000, price: 5 }],
  ownerName: "Doe Jane", role: "officer", officerTitle: "Chief Executive Officer",
  ownedAfter: 110000, scheduled: false, ...over,
});

console.log("── Form 4 insight unit test ──\n");

// action detection
check("P → buy", form4Action([{ code: "P" }]) === "buy");
check("S → sell", form4Action([{ code: "S" }]) === "sell");
check("A → grant", form4Action([{ code: "A" }]) === "grant");
check("P+S → mixed", form4Action([{ code: "P" }, { code: "S" }]) === "mixed");

console.log("");

// A CEO, discretionary, sizable, +10% stake, clustered buy → HIGH conviction
const strong = buildForm4Insight(parsed(), 3, 5);
check("strong buy is non-null", !!strong);
check("value computed ($50K)", strong.value === 50000, `value=${strong.value}`);
// prior = 110000 − 10000 = 100000 → +10% to stake
check("stake-delta = +10%", Math.abs(strong.pctOfStake - 0.10) < 1e-9, `pct=${strong.pctOfStake}`);
check("distinct buyers carried", strong.distinctBuyers === 3);
// score: officer +2, discretionary +1, cluster +2, ≥10% stake +1 = 6 → high
check("conviction = high", strong.conviction === "high", `got ${strong.conviction}`);

console.log("");

// A lone director, 10b5-1 scheduled, small, no stake info → LOW conviction
const weak = buildForm4Insight(
  parsed({ role: "director", officerTitle: "", codes: [{ code: "P", shares: 100, price: 5 }], ownedAfter: null, scheduled: true }),
  1, 1,
);
// score: director +1, scheduled −1 = 0 → low
check("weak buy conviction = low", weak.conviction === "low", `got ${weak.conviction}`);
check("null ownedAfter → pctOfStake null", weak.pctOfStake === null);

console.log("");

// A grant/sale is NOT a buy → no insight (gem card leads with buys only)
check("grant → null insight", buildForm4Insight(parsed({ codes: [{ code: "A", shares: 5000, price: 0 }] }), 1, 1) === null);
check("sale → null insight", buildForm4Insight(parsed({ codes: [{ code: "S", shares: 5000, price: 5 }] }), 1, 1) === null);

console.log("");

// Summary string renders role + stake + cluster + discretionary
const summary = form4PurchaseSummary(strong);
check("summary leads with CEO", /^CEO open-market buy/.test(summary), summary);
check("summary shows stake-delta", /\+10% to stake/.test(summary));
check("summary shows cluster", /3 insiders buying/.test(summary));
check("summary shows discretionary", /discretionary/.test(summary));

console.log(`\n${ok ? "✅ ALL PASS" : "❌ FAILURES — see above"}`);
process.exit(ok ? 0 : 1);
