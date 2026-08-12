import { NextResponse } from "next/server";
import { fetchMarketContext } from "@/lib/daily-brief";
import { buildEditorial, buildPersonalInsert } from "@/lib/daily-editorial";
import { isAdmin } from "@/lib/usage-log";
import { getRequestUserId } from "@/lib/nexus-memory";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET(req: Request) {
  if (!(await isAdmin().catch(() => false))) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const userId = await getRequestUserId().catch(() => null);
  if (!userId) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const url = new URL(req.url);
  const format = url.searchParams.get("format");

  const market = await fetchMarketContext();
  if (!market) return NextResponse.json({ error: "No market data — markets may be closed" }, { status: 503 });

  const email = await buildEditorial(market);
  if (!email) return NextResponse.json({ error: "Editorial generation failed" }, { status: 500 });

  // Build personal insert for the signed-in user
  const dayMoves: Record<string, number> = {};
  for (const s of market.sectors) dayMoves[s.name] = s.day;
  let insert = "";
  try { insert = await buildPersonalInsert(userId, dayMoves); } catch { /* no insert */ }

  const html = email.html.replace("%%PERSONAL%%", insert);
  const text = email.text.replace("%%PERSONAL%%", insert ? "\nYOUR NAMES TODAY\n(see details in Plainview)\n" : "");

  if (format === "text") return new Response(text, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
  if (format === "json") return NextResponse.json({ subject: email.subject, html, text });
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}
