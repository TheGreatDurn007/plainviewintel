import { readFile } from "node:fs/promises";
import path from "node:path";

export const dynamic = "force-dynamic";

// Root `/` = Portfolio (the command center). Login-required — middleware sends logged-out
// visitors to the public `/x-ray` landing. The app reads the path on load to open the right tab.
export async function GET() {
  const htmlPath = path.join(
    process.cwd(),
    "src",
    "app",
    "plainview-command-center.html",
  );
  const html = await readFile(htmlPath, "utf8");

  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      // no-store so deploys reach every device immediately (the stale-CDN-HTML bug: old inline JS served for
      // up to 24h after a deploy, e.g. the sign-out fix not reaching desktop/mobile). Matches /[tab] + /x-ray.
      "cache-control": "no-store",
    },
  });
}
