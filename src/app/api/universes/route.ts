import { NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { DEFAULT_UNIVERSES, readSavedUniverses, writeSavedUniverses, sanitizeUniverses } from "@/lib/radar-universes";

// Read the radar's curated universes (everyone), and let the OWNER edit them in-app — no SQL, no
// redeploy. Writes go to Supabase Storage; the radar's loadUniverses() reads the same doc.

function env(n: string): string { const v = process.env[n]; if (!v) throw new Error(`Missing ${n}`); return v; }

async function currentEmail(): Promise<string | null> {
  try {
    const cookieStore = await cookies();
    const supabase = createServerClient(env("NEXT_PUBLIC_SUPABASE_URL"), env("NEXT_PUBLIC_SUPABASE_ANON_KEY"), {
      cookies: { getAll() { return cookieStore.getAll(); }, setAll() { /* read-only */ } },
    });
    const { data: { user } } = await supabase.auth.getUser();
    return user?.email?.toLowerCase() || null;
  } catch { return null; }
}

function isOwner(email: string | null): boolean {
  const allowed = (process.env.NEXT_PUBLIC_ALLOWED_EMAIL || "").toLowerCase();
  return !!(email && allowed && email === allowed);
}

export async function GET() {
  const email = await currentEmail();
  const saved = await readSavedUniverses();
  return NextResponse.json({ universes: saved && saved.length ? saved : DEFAULT_UNIVERSES, isDefault: !(saved && saved.length), canEdit: isOwner(email) });
}

export async function POST(request: Request) {
  const email = await currentEmail();
  if (!isOwner(email)) return NextResponse.json({ error: "Not authorized" }, { status: 403 });
  let body: { universes?: unknown };
  try { body = await request.json(); } catch { body = {}; }
  const clean = sanitizeUniverses(body.universes);
  if (!clean.length) return NextResponse.json({ error: "At least one valid universe (slug, label, ≥1 ticker) is required." }, { status: 400 });
  await writeSavedUniverses(clean);
  return NextResponse.json({ ok: true, universes: clean });
}
