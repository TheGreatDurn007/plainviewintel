import { NextResponse } from "next/server";
import { isAdmin } from "@/lib/usage-log";

// Founder-only system pulse — are the things Plainview depends on alive right now?
export const dynamic = "force-dynamic";

type Check = { name: string; ok: boolean; ms: number; detail: string };

async function timed(name: string, fn: () => Promise<{ ok: boolean; detail: string }>): Promise<Check> {
  const t = Date.now();
  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 4500);
    const r = await fn();
    clearTimeout(to);
    return { name, ok: r.ok, ms: Date.now() - t, detail: r.detail };
  } catch (e) {
    return { name, ok: false, ms: Date.now() - t, detail: e instanceof Error ? e.message : "error" };
  }
}

// SEC EDGAR requires a descriptive UA with a contact — same one the real filing routes use.
const UA = { "User-Agent": "Plainview investing tool plainview@dar-fishman.com" };

export async function GET() {
  if (!(await isAdmin())) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const checks = await Promise.all([
    timed("Anthropic", async () => ({ ok: !!process.env.ANTHROPIC_API_KEY, detail: process.env.ANTHROPIC_API_KEY ? "key present" : "no key" })),
    timed("Supabase", async () => ({ ok: !!process.env.NEXT_PUBLIC_SUPABASE_URL && !!process.env.SUPABASE_SERVICE_ROLE_KEY, detail: "config present" })),
    timed("Market data (Yahoo)", async () => {
      const r = await fetch("https://query1.finance.yahoo.com/v8/finance/chart/AAPL?range=1d&interval=1d", { headers: UA, cache: "no-store" });
      return { ok: r.ok, detail: r.ok ? "responding" : `HTTP ${r.status}` };
    }),
    timed("SEC EDGAR", async () => {
      const r = await fetch("https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=0000320193&type=8-K&count=1&output=atom", { headers: UA, cache: "no-store" });
      return { ok: r.ok, detail: r.ok ? "responding" : `HTTP ${r.status}` };
    }),
    timed("Crypto (CoinGecko)", async () => {
      const r = await fetch("https://api.coingecko.com/api/v3/ping", { headers: UA, cache: "no-store" });
      return { ok: r.ok, detail: r.ok ? "responding" : `HTTP ${r.status}` };
    }),
  ]);

  const allOk = checks.every((c) => c.ok);
  return NextResponse.json({ allOk, checks, asOf: Date.now() }, { headers: { "cache-control": "no-store" } });
}
