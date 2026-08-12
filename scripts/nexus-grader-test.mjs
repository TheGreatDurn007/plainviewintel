// NEXUS grader unit test — verify the pure grading decision (P1). Run: npx tsx scripts/nexus-grader-test.mjs
import { gradePrediction } from "../src/lib/nexus-grader.ts";

let ok = true;
const check = (label, got, want) => { const p = got === want; ok = ok && p; console.log(`${p ? "✅" : "❌"} ${label} — got ${got}${p ? "" : `, wanted ${want}`}`); };

const FUT = "2027-01-01", PAST = "2025-01-01", TODAY = "2026-06-13";
const reaches = (t, h) => ({ id: "x", ticker: "CAN", direction: "reaches", threshold: t, horizon_date: h });

console.log("── NEXUS grader unit test ──\n");

// EARLY HIT: target touched → hit even though horizon is in the future
check("reaches 0.60, high 0.62, future horizon → hit", gradePrediction(reaches(0.60, FUT), { high: 0.62, low: 0.30 }, TODAY), "hit");
// Not reached, horizon future → still open (null)
check("reaches 0.60, high 0.45, future horizon → open (null)", gradePrediction(reaches(0.60, FUT), { high: 0.45, low: 0.30 }, TODAY), null);
// Not reached, horizon passed → miss
check("reaches 0.60, high 0.45, past horizon → miss", gradePrediction(reaches(0.60, PAST), { high: 0.45, low: 0.30 }, TODAY), "miss");
// Exactly at threshold counts as reached
check("reaches 0.60, high exactly 0.60 → hit", gradePrediction(reaches(0.60, FUT), { high: 0.60, low: 0.30 }, TODAY), "hit");

console.log("");
// 'below' direction (a downside target)
const below = { id: "x", ticker: "X", direction: "below", threshold: 0.20, horizon_date: FUT };
check("below 0.20, low 0.18 → hit", gradePrediction(below, { high: 0.40, low: 0.18 }, TODAY), "hit");
check("below 0.20, low 0.25, future → open", gradePrediction(below, { high: 0.40, low: 0.25 }, TODAY), null);

console.log("");
// No admissible price window
check("no window, future horizon → open (null)", gradePrediction(reaches(0.60, FUT), null, TODAY), null);
check("no window, past horizon → unresolved (never guessed)", gradePrediction(reaches(0.60, PAST), null, TODAY), "unresolved");

console.log("");
// Ungradeable types
check("null threshold → null (not gradeable on price)", gradePrediction({ id:"x",ticker:"X",direction:"reaches",threshold:null,horizon_date:FUT }, { high: 9, low: 1 }, TODAY), null);
check("'occurs' event → null (v1 unsupported)", gradePrediction({ id:"x",ticker:"X",direction:"occurs",threshold:1,horizon_date:FUT }, { high: 9, low: 1 }, TODAY), null);

console.log(`\n${ok ? "✅ ALL PASS" : "❌ FAILURES"}`);
process.exit(ok ? 0 : 1);
