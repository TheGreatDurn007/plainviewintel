import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { seedCatalysts, seedPositions, seedRules, seedWatchlist } from "@/lib/seedData";

export async function POST() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const email = process.env.NEXT_PUBLIC_ALLOWED_EMAIL;

  if (!url || !serviceKey || !email) {
    return NextResponse.json({ error: "Missing Supabase seed configuration." }, { status: 500 });
  }

  const supabase = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false }
  });

  const { data: users, error: userError } = await supabase.auth.admin.listUsers();
  if (userError) return NextResponse.json({ error: userError.message }, { status: 500 });

  const user = users.users.find(row => row.email?.toLowerCase() === email.toLowerCase());
  if (!user) return NextResponse.json({ error: "Create/sign in to the Plainview account first, then seed data." }, { status: 404 });

  await Promise.all([
    supabase.from("positions").delete().eq("user_id", user.id),
    supabase.from("watchlist").delete().eq("user_id", user.id),
    supabase.from("catalysts").delete().eq("user_id", user.id),
    supabase.from("rules").delete().eq("user_id", user.id)
  ]);

  const positionRows = seedPositions.map(row => ({ ...row, user_id: user.id, asset_type: "stock" }));
  const watchRows = seedWatchlist.map(row => ({ asset_type: "stock", ...row, user_id: user.id }));
  const catalystRows = seedCatalysts.map(row => ({ ...row, user_id: user.id }));
  const ruleRows = seedRules.map((body, index) => ({ user_id: user.id, body, sort_order: index + 1 }));

  const inserts = await Promise.all([
    supabase.from("positions").insert(positionRows),
    supabase.from("watchlist").insert(watchRows),
    supabase.from("catalysts").insert(catalystRows),
    supabase.from("rules").insert(ruleRows)
  ]);

  const error = inserts.find(result => result.error)?.error;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({
    ok: true,
    positions: positionRows.length,
    watchlist: watchRows.length,
    catalysts: catalystRows.length,
    rules: ruleRows.length
  });
}
