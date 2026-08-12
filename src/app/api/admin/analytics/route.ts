import { NextResponse } from "next/server";
import { isAdmin, buildAnalytics } from "@/lib/usage-log";

// Founder-only analytics. Double-gated: middleware requires a session, and this route requires the
// session email to be the founder's. Anyone else gets 404 (don't even confirm the route exists).
export const dynamic = "force-dynamic";

export async function GET() {
  if (!(await isAdmin())) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  try {
    const data = await buildAnalytics();
    return NextResponse.json(data, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return NextResponse.json({ error: "Failed to build analytics", detail: String(e) }, { status: 500 });
  }
}
