import { readFile } from "node:fs/promises";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";

// `/x-ray`:
//   • ?embed=1            → always the standalone page (this is what the in-app iframe loads — no recursion)
//   • logged-in, no embed → the command center, which opens X-Ray as an INSTANT in-app tab (no reload)
//   • logged-out          → the public standalone sleek page
// Does NOT import next/headers — keeps the route cacheable at the edge for logged-out / Googlebot.

async function isLoggedIn(req: Request): Promise<boolean> {
  try {
    const raw = req.headers.get("cookie") || "";
    if (!raw.includes("sb-")) return false;
    const parts = raw.split(";").map(c => c.trim());
    const authParts = parts
      .filter(c => /sb-.*-auth-token/.test(c))
      .sort()
      .map(c => c.split("=").slice(1).join("="));
    if (!authParts.length) return false;
    const decoded = decodeURIComponent(authParts.join(""));
    let token: string | null = null;
    try {
      const parsed = JSON.parse(decoded.startsWith("base64-") ? Buffer.from(decoded.slice(7), "base64").toString() : decoded);
      token = parsed?.access_token || null;
    } catch { return false; }
    if (!token) return false;
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      { auth: { persistSession: false } }
    );
    const { data: { user } } = await supabase.auth.getUser(token);
    return !!user;
  } catch { return false; }
}

const CT = "text/html; charset=utf-8";
const cache = (loggedIn: boolean) => loggedIn ? "no-store" : "public, s-maxage=3600, stale-while-revalidate=86400";

export async function GET(req: Request) {
  const embed = new URL(req.url).searchParams.get("embed") === "1";
  const loggedIn = await isLoggedIn(req);

  // Logged-in users browsing to /x-ray get the command center (instant in-app X-Ray tab).
  if (loggedIn && !embed) {
    const cc = await readFile(path.join(process.cwd(), "src", "app", "plainview-command-center.html"), "utf8");
    return new Response(cc, { headers: { "content-type": CT, "cache-control": "no-store" } });
  }

  // Embed (the iframe) or logged-out → the standalone sleek page.
  let html = await readFile(path.join(process.cwd(), "src", "app", "x-ray.html"), "utf8");
  if (loggedIn) html = html.replace("window.__pvAuth=false", "window.__pvAuth=true");
  return new Response(html, { headers: { "content-type": CT, "cache-control": cache(loggedIn) } });
}
