// NEXUS grader endpoint — resolves the signed-in user's open predictions into outcomes. Deterministic,
// $0 (no AI), idempotent (skips already-graded), fail-open. Safe to call once per session / on view.
import { NextResponse } from "next/server";
import { getRequestUserId } from "@/lib/nexus-memory";
import { gradeOpenPredictions } from "@/lib/nexus-grader";

export const dynamic = "force-dynamic";

export async function POST() {
  const userId = await getRequestUserId();
  if (!userId) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  const result = await gradeOpenPredictions(userId);
  return NextResponse.json({ ok: true, ...result });
}
