import { NextResponse } from "next/server";
import { getRequestUserId, recordActions, listActions, setActionWhy, deleteAction, type ActionInput } from "@/lib/nexus-memory";

// Action Log (behavioral ledger, P1). Per-user, requires a session (middleware already blocks anon).
// FAIL-OPEN everywhere: capture is a side-benefit of using the app, never something that can error a flow.
export const dynamic = "force-dynamic";

// GET → the recent action timeline for the Journal.
export async function GET() {
  const userId = await getRequestUserId().catch(() => null);
  if (!userId) return NextResponse.json({ actions: [] });
  return NextResponse.json({ actions: await listActions(userId, 40) });
}

// POST { actions:[...] } → record detected book changes (the client diffs the book and sends them).
export async function POST(req: Request) {
  const userId = await getRequestUserId().catch(() => null);
  if (!userId) return NextResponse.json({ wrote: 0 });
  let body: { actions?: ActionInput[] };
  try { body = await req.json(); } catch { return NextResponse.json({ wrote: 0 }); }
  return NextResponse.json(await recordActions(userId, body.actions ?? []));
}

// PATCH { id, why } → label a move's intent (the one-tap "why").
export async function PATCH(req: Request) {
  const userId = await getRequestUserId().catch(() => null);
  if (!userId) return NextResponse.json({ ok: false });
  let body: { id?: string; why?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ ok: false }); }
  if (!body.id || !body.why) return NextResponse.json({ ok: false });
  return NextResponse.json(await setActionWhy(userId, body.id, body.why));
}

// DELETE { id } → remove one of the user's own actions (mis-detection cleanup).
export async function DELETE(req: Request) {
  const userId = await getRequestUserId().catch(() => null);
  if (!userId) return NextResponse.json({ ok: false });
  let body: { id?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ ok: false }); }
  if (!body.id) return NextResponse.json({ ok: false });
  return NextResponse.json(await deleteAction(userId, body.id));
}
