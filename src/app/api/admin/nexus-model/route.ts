// Owner-only NEXUS judgment-model toggle. Lets the founder flip NEXUS's reasoning between the free
// chain and Sonnet/Opus from the Admin tab — one click, no redeploy — and is an instant cost
// kill-switch. The setting lives in Supabase (see ai-tier.ts getJudgmentModel) so it takes effect
// within ~60s across all instances. GUARDED: only an owner email may read or change it.
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { isOwnerEmail } from "@/lib/tier";
import { getJudgmentSetting, setJudgmentModel, ALLOWED_JUDGMENT_MODELS } from "@/lib/ai-tier";

async function ownerEmail(): Promise<string | null> {
  try {
    const cookieStore = await cookies();
    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      { cookies: { getAll() { return cookieStore.getAll(); }, setAll() {} } }
    );
    const { data: { user } } = await supabase.auth.getUser();
    const email = user?.email ?? null;
    return isOwnerEmail(email) ? email : null;
  } catch { return null; }
}

export async function GET() {
  if (!(await ownerEmail())) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  return NextResponse.json({ model: await getJudgmentSetting(), options: ALLOWED_JUDGMENT_MODELS });
}

export async function POST(request: Request) {
  if (!(await ownerEmail())) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  let body: { model?: string };
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Invalid request" }, { status: 400 }); }
  const model = await setJudgmentModel(String(body?.model ?? "free"));
  return NextResponse.json({ ok: true, model });
}
