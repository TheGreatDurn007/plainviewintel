import { readFile } from "node:fs/promises";
import path from "node:path";

// `/home` = the command center (the app / portfolio). Login-required (enforced in middleware).
// Mirrors the old root handler: reads the single-file UI at request time.
export const dynamic = "force-dynamic";

export async function GET() {
  const htmlPath = path.join(process.cwd(), "src", "app", "plainview-command-center.html");
  const html = await readFile(htmlPath, "utf8");

  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      // no-store so a deploy reaches every device immediately. The CDN s-maxage cache served STALE HTML (old
      // inline JS) for up to 24h after a deploy → the sign-out fix never reached desktop/mobile (the bug).
      "cache-control": "no-store",
    },
  });
}
