// ════════════════════════════════════════════════════════════════════════════════════════════
// Trust-classify unit test — verify the jurisdiction-aware admissibility gate (P0.2).
// Pure, no DB. Run:  npx tsx scripts/trust-classify-test.mjs
// ════════════════════════════════════════════════════════════════════════════════════════════
// Asserts the core abstraction that FDY.TO exposed: Tier-1 is the primary source for the security's
// OWN jurisdiction, not "SEC" — and AI/notes can NEVER be authoritative.
import { classifyTrust, detectJurisdiction, isAdmissibleAlone, isInadmissible } from "../src/lib/trust-classify.ts";

let ok = true;
const eq = (label, got, want) => {
  const pass = got === want;
  ok = ok && pass;
  console.log(`${pass ? "✅" : "❌"} ${label} — got "${got}"${pass ? "" : `, wanted "${want}"`}`);
};

console.log("── Trust-classify unit test ──\n");

// Jurisdiction detection
eq("AAPL → US",        detectJurisdiction("AAPL"), "US");
eq("FDY.TO → CA",      detectJurisdiction("FDY.TO"), "CA");
eq("KEEL.V → CA",      detectJurisdiction("KEEL.V"), "CA");
eq("SHOP.NE → CA",     detectJurisdiction("SHOP.NE"), "CA");
eq("RIO.L → intl",     detectJurisdiction("RIO.L"), "intl");
eq("BTC-USD → crypto", detectJurisdiction("BTC-USD"), "crypto");

console.log("");

// Tier-1: the right regulator for the right jurisdiction
eq("US + SEC EDGAR → authoritative",       classifyTrust("SEC EDGAR", "NVDA"), "authoritative");
eq("CA + SEDAR → authoritative",           classifyTrust("SEDAR+ filing", "FDY.TO"), "authoritative");
eq("crypto + CoinGecko → authoritative",   classifyTrust("CoinGecko", "BTC-USD"), "authoritative");
// Exchange price is Tier-1 for ANY jurisdiction, regardless of vendor string
eq("price signal (US) → authoritative",    classifyTrust("Yahoo Finance", "NVDA", "price"), "authoritative");
eq("price signal (CA) → authoritative",    classifyTrust("Yahoo Finance", "FDY.TO", "price"), "authoritative");

console.log("");

// The FDY.TO heart of the matter: a Canadian name has NO SEC filing, so its fundamentals are derived
// (need corroboration) — and an "SEC" string on a .TO name must NOT be over-trusted as authoritative.
eq("CA + 'SEC' string → NOT authoritative (derived)", classifyTrust("SEC EDGAR", "FDY.TO"), "derived");
eq("CA + Yahoo financials → derived",                 classifyTrust("Yahoo financials", "FDY.TO"), "derived");
eq("US + analyst consensus → derived",                classifyTrust("analyst consensus", "NVDA"), "derived");
eq("computed beta → derived",                         classifyTrust("Plainview computed beta", "NVDA"), "derived");

console.log("");

// Inadmissible: AI prose, prior-brief memory, the investor's own notes — never grade
eq("AI brief → ai_interpretation",        classifyTrust("Plainview AI brief", "NVDA"), "ai_interpretation");
eq("prior brief memory → ai_interpretation", classifyTrust("prior intel brief", "FDY.TO"), "ai_interpretation");
eq("investor note → ai_interpretation",   classifyTrust("investor's note", "AMC"), "ai_interpretation");

console.log("");

// The admissibility helpers
eq("authoritative is admissible-alone", isAdmissibleAlone("authoritative"), true);
eq("derived is NOT admissible-alone",   isAdmissibleAlone("derived"), false);
eq("ai_interpretation is inadmissible", isInadmissible("ai_interpretation"), true);
eq("derived is NOT inadmissible",       isInadmissible("derived"), false);

console.log(`\n${ok ? "✅ ALL PASS" : "❌ FAILURES — see above"}`);
process.exit(ok ? 0 : 1);
