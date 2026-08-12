import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

// Lightweight session check for the public /x-ray page: returns { loggedIn } so the static page can
// render the logged-in header (unlocked tabs + Sign out) vs the logged-out one (faded tabs + Sign in).
// Public (under /api/auth/), no data exposed beyond a boolean.
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const cookieStore = await cookies();
    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      { cookies: { getAll() { return cookieStore.getAll(); }, setAll() {} } }
    );
    const { data: { user } } = await supabase.auth.getUser();
    return NextResponse.json({ loggedIn: !!user }, { headers: { "cache-control": "no-store" } });
  } catch {
    return NextResponse.json({ loggedIn: false }, { headers: { "cache-control": "no-store" } });
  }
}
