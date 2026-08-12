// Owner-only AI-quota toggle. Lets the founder turn the per-user daily AI cap on/off — and set the
// daily limit — from the Admin tab with one click, no redeploy. The setting lives in Supabase
// (see ai-quota.ts getQuotaConfig) and propagates within ~60s. The owner is ALWAYS exempt regardless
// of this toggle; it only governs everyone else. GUARDED: only an admin email may read or change it.
import { NextResponse } from "next/server";
import { isAdmin } from "@/lib/usage-log";
import { getQuotaConfig, setQuotaConfig } from "@/lib/ai-quota";

export const dynamic = "force-dynamic";

export async function GET() {
  if (!(await isAdmin())) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  return NextResponse.json({ ok: true, config: await getQuotaConfig() });
}

export async function POST(request: Request) {
  if (!(await isAdmin())) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  let body: { enabled?: boolean; limit?: number };
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Invalid request" }, { status: 400 }); }
  const config = await setQuotaConfig(!!body?.enabled, body?.limit);
  return NextResponse.json({ ok: true, config });
}
