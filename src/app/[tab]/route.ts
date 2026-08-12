import { readFile } from "node:fs/promises";
import path from "node:path";

// Per-tab URLs — /watchlist, /intel, /decide, /news, /dashboard, /sentiment, /journal, /settings, /admin
// all serve the command center; the app reads the path on load and opens the matching tab. Static routes
// (/x-ray, /login, /home, /api) take precedence over this dynamic segment. Login-required (middleware).
export const dynamic = "force-dynamic";

export async function GET() {
  const html = await readFile(path.join(process.cwd(), "src", "app", "plainview-command-center.html"), "utf8");
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}
