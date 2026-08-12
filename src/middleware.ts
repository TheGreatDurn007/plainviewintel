import { createServerClient } from "@supabase/ssr";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

export async function middleware(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet: { name: string; value: string; options?: Record<string, unknown> }[]) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          );
          supabaseResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            supabaseResponse.cookies.set(name, value, options as any)
          );
        },
      },
    }
  );

  // Refresh session — keeps tokens alive on active use
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { pathname } = request.nextUrl;
  const isApiRoute = pathname.startsWith("/api/");
  const isAuthApi = pathname.startsWith("/api/auth/"); // login/callback/signout must stay open
  // Public, anonymous-allowed APIs. X-Ray is the free public scan (no LLM) — it's rate-limited
  // and cached inside its own route, so exposing it can't burn tokens or be abused at scale.
  // /api/performance is plain Yahoo chart data (no LLM, no secrets, symbol-capped) — public so the
  // anonymous X-Ray page can draw the share-card mini chart for its snapshots.
  // /api/whop-webhook is called by Whop's servers (no user session) and verifies its own signature.
  // /api/admin/accuracy is hit by the daily Vercel cron (no user session) and self-gates on isAdmin OR
  // the CRON_SECRET bearer token — so it must pass the middleware to reach its own auth check.
  // /api/sec-filings is read-only public SEC EDGAR data (no LLM, no secrets) — public so the anonymous
  // X-Ray page (and Googlebot) can show each ticker's recent filings. The AI summary (/api/sec-explain)
  // stays gated, so anonymous visitors get the list but can't trigger a paid call.
  const isPublicApi = pathname.startsWith("/api/xray") || pathname.startsWith("/api/chart") || pathname.startsWith("/api/crypto") || pathname.startsWith("/api/market-movers") || pathname.startsWith("/api/performance") || pathname.startsWith("/api/sec-filings") || pathname.startsWith("/api/insider-track") || pathname.startsWith("/api/telemetry") || pathname.startsWith("/api/email-track") || pathname.startsWith("/api/resend-webhook") || pathname.startsWith("/api/unsubscribe") || pathname.startsWith("/api/whop-webhook") || pathname.startsWith("/api/admin/accuracy") || pathname.startsWith("/api/cron") || pathname.startsWith("/api/og");
  // Service-token bypass: the morning sweep (daily-brief cron) re-scores users' theses by calling
  // /api/thesis-check server-to-server with NO session cookie, proving authority with the CRON_SECRET in
  // the x-cron-secret header. Let such a request past the auth gate so it can reach the route, which
  // re-validates the secret and only then uses the named userId. A forged header without the exact secret
  // is still blocked here. Nothing changes for browser traffic (the cron header is never sent by a browser).
  const cronSecret = process.env.CRON_SECRET;
  const hasCronAuth = !!cronSecret && request.headers.get("x-cron-secret") === cronSecret;
  const isLoginPage = pathname === "/login";
  // Public pages anyone may view without a session: the X-Ray tool + login. Everything else (the
  // command center at `/` and the tab URLs) needs auth.
  const isPublicPage = isLoginPage || pathname === "/x-ray" || pathname.startsWith("/x-ray/");

  // Block unauthenticated API access (except auth endpoints). Protects the paid AI keys
  // (intel/analyze) from anonymous abuse and keeps all data routes behind a session.
  // Logged-in users are unaffected — the browser sends the session cookie automatically.
  if (!user && isApiRoute && !isAuthApi && !isPublicApi && !hasCronAuth) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }

  // Logged-out visitor hitting the root → the public X-Ray landing (the public front door).
  if (!user && pathname === "/") {
    const url = request.nextUrl.clone();
    url.pathname = "/x-ray";
    return NextResponse.redirect(url);
  }

  // Logged-out at any other app page → login.
  if (!user && !isApiRoute && !isPublicPage) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    return NextResponse.redirect(url);
  }

  // Logged-in on /login → the app root (Portfolio).
  if (user && isLoginPage) {
    const url = request.nextUrl.clone();
    url.pathname = "/";
    return NextResponse.redirect(url);
  }

  return supabaseResponse;
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml|manifest\\.json|sw\\.js|icon-192\\.png|icon-512\\.png|apple-touch-icon\\.png|icon-192\\.svg|icon-512\\.svg).*)",
  ],
};
