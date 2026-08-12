import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { isAdmin } from "@/lib/usage-log";

// One-time backfill: seed the usage ledger from data we already have, so analytics isn't blank for
// users who existed before we added tracking. Per account: firstSeen = account creation (Supabase Auth),
// lastActive = their last state-save (savedAt in state.json — a solid proxy for "last active"). Merges
// into any existing usage record without ever downgrading real, freshly-tracked data. Admin-only, idempotent.
export const dynamic = "force-dynamic";
const BUCKET = "plainview-state";

function admin() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
}

export async function POST() {
  if (!(await isAdmin())) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const db = admin();
  let users = 0, seeded = 0;
  try {
    const { data: list } = await db.auth.admin.listUsers({ page: 1, perPage: 1000 });
    for (const u of list?.users || []) {
      users++;
      const created = u.created_at || new Date().toISOString();
      let lastActive = created;
      try {
        const { data } = await db.storage.from(BUCKET).download(`${u.id}/state.json`);
        if (data) { const j = JSON.parse(await data.text()); if (j?.savedAt) lastActive = j.savedAt; }
      } catch { /* no saved state → account exists but never saved */ }

      const key = `_usage/u/${u.id}.json`;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let rec: any = { firstSeen: created, lastActive, activeDays: [] as string[], total: 0, features: {} };
      try {
        const { data } = await db.storage.from(BUCKET).download(key);
        if (data) rec = { ...rec, ...JSON.parse(await data.text()) }; // keep real tracked data
      } catch { /* none yet */ }

      rec.userId = u.id;
      rec.email = u.email || rec.email;
      if (new Date(created) < new Date(rec.firstSeen)) rec.firstSeen = created;       // earliest
      if (new Date(lastActive) > new Date(rec.lastActive)) rec.lastActive = lastActive; // latest
      rec.activeDays = Array.isArray(rec.activeDays) ? rec.activeDays : [];
      [created.slice(0, 10), lastActive.slice(0, 10)].forEach((d) => { if (!rec.activeDays.includes(d)) rec.activeDays.push(d); });

      const blob = new Blob([JSON.stringify(rec)], { type: "application/json" });
      await db.storage.from(BUCKET).upload(key, blob, { upsert: true, contentType: "application/json" });
      seeded++;
    }
    return NextResponse.json({ ok: true, users, seeded });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
