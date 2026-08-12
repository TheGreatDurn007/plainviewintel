# Design doc — New-user homepage (the front door)

_Status: PHASE 1 SHIPPED (2026-06-10). Companion to [vision.md](../vision.md) + [ARCHITECTURE.md](../ARCHITECTURE.md)._

> **Phase 1 build log (shipped):** public homepage at `/home` (`src/app/homepage.html` served by `src/app/home/route.ts`). Lookup + picks route to `/?ticker=XYZ`; a fail-soft deep-link in the command center (`initPlainview`) drills into X-Ray. Picks are clearly-labeled SAMPLE data.
> **Final sitemap (the swap, shipped 2026-06-10):**
> | URL | What | Access |
> |---|---|---|
> | `/` | the pitch / public front door (`homepage.html`) | public |
> | `/home` | the command center / portfolio (`plainview-command-center.html`) | login required |
> | `/login` | login | public |
>
> Implemented via: root route serves `homepage.html`; `/home` route serves the command center; `src/middleware.ts` makes `/` public, gates `/home`, and redirects signed-in users from `/` or `/login` → `/home`; homepage Analyze → `/home?ticker=`; login `router.push("/home")`; PWA `start_url` → `/home` (manifest `?v=3`). Data/API stay 401 for anonymous.
> **Known limit:** a logged-out visitor clicking Analyze is sent to `/login` (the X-Ray drill completes once signed in). Public X-Ray for anonymous users is a separate, flagged decision.

---

## v2 — `/x-ray` public front door (decided 2026-06-10)

The sleek landing page becomes the **public X-Ray tool**. The aesthetic is the keeper; we re-point what it does.

**Flow (single page):** landing state (search box + sample showcase) → user searches a ticker → picks/watching/candidates **collapse** → the **real X-Ray scan renders in place** → ends with a **"stress-test your thesis on [TICKER] →"** CTA (sign in). Same page, search-to-result like Google/ChatGPT.

**Routing:** `/x-ray` = this page (public). `/` routes visitors → `/x-ray`, logged-in → `/home`. `/home` = command center. `/login` = login.

**X-Ray goes public:** `/api/xray` allowed for anonymous users, protected by **rate-limiting + the existing 24h cache**. Safe because X-Ray uses **no LLM** — cheap and abuse-resistant at scale. Lightweight path: only the X-Ray call, NOT a full command-center boot.

**Design — "car matches the engine":** the X-Ray result card is rebuilt in the NEW sleek aesthetic (dark grid, neon-green, mono numbers) to match the landing — not the old dense command-center card.

**Free/paid line:** X-Ray = free + public (the hook). Thesis stress-test = sign-in / paid (the soul). The CTA is the funnel between them.

Picks/watching/candidates stay labeled SAMPLE until the morning-scan engine (Phase 2). The X-Ray result itself is REAL.

---

## 1. Why this exists

The product loop is **look up → know where you stand → get told when it changes.** The homepage owns the **"look up"** entry point, and it must be useful to someone with **zero portfolio**. Today a new/logged-out user lands on the full command center ("a showcase of the engine") and bounces. This page is the _car, not the engine_: one obvious thing to do, alive on day one.

## 2. Who it's for

- **Primary:** logged-out / brand-new users (no account, no holdings).
- **Secondary:** returning users as a calm landing before they dive into the command center.

## 3. The 5-second test

In five seconds a stranger must understand: _"I type a ticker and this thing tells me what's going on with it — and it already has ideas for me today."_ If the page doesn't make that obvious, it has failed, regardless of how nice it looks.

## 4. Layout (LOCKED — ambient version)

Approved mockup: dark cockpit frame, faint grid + green top-glow (matches the login page). Top-weighted glow so content stays the star.

1. **Logo bar** — PLAINVIEW / COMMAND CENTER (left), minimal **Sign in** (right). New users are not gated.
2. **Headline** — "Know any stock in seconds." + sub: "Type a ticker — we pressure-test it against live facts, filings, and sentiment."
3. **Lookup field (the hero)** — large, green-bordered, ticker input + **Analyze →**. This is the one obvious action.
4. **Trending chips** — 3–4 tickers for instant gratification.
5. **🎯 Today's top picks (3)** — cards: ticker · overnight move % · a one-line _why_. (The "why" lines stay — a pick with no reason is just a screener.)
6. **👁 Watching (5)** — compact rows: ticker · reason · price/move.
7. **🔍 Candidates (10)** — chip cloud (early-stage names).
8. **Footer** — "Got holdings? Sign in to track your portfolio, theses, and catalysts."

Decided (changeable, but settled for v1): headline wording above · the three buckets (picks/watching/candidates) · keep the "why" lines · minimal top-right sign-in.

## 5. Data contract

| Element | Reads | Layer | Source |
|---|---|---|---|
| Lookup field → result | on submit, routes into X-Ray | n/a (navigation) | existing `GET /api/xray/[symbol]` |
| Picks / Watching / Candidates | a daily shared `market_picks` table | auto-collected primary → analyzed/processed (shared, no user_id) | the morning-scan job (to build) |

**`market_picks` table (sketch — shared hive mind, no user_id):**
`scan_date · bucket ('pick'|'watch'|'candidate') · ticker · name · reason · move_pct · price · rank · source · created_at`

**Honesty rule:** until the morning-scan job fills this table, the homepage shows **clearly-labeled SAMPLE picks** — never fake numbers presented as real. (Aligns with the price/no-stale-fallback doctrine.)

## 6. Actors & flow (verbalized)

- **User** › types ticker, _Analyze_ › `GET /api/xray/[symbol]` › X-Ray card. (Logged-out users get the public read; recording a thesis requires sign-in.)
- **Scheduled job** (cron, _separate doc/feature_) › morning scan › writes `market_picks` › homepage reads it on load.

## 7. States

- **Logged-out:** full homepage as above.
- **Logged-in:** _open decision_ — (a) same homepage as a landing, or (b) skip straight to the command center/dashboard. Lean (a) with a "Go to my dashboard" nudge.
- **No scan yet / empty table:** show labeled sample picks; lookup field still fully works.

## 8. OPEN DECISION — routing & auth (needs sign-off before build)

The single-file command center is served at `/` by `src/app/route.ts`. Options for where the homepage lives:

- **A. New landing at `/`, command center moves to `/app`.** Cleanest mental model; touches routing + the auth redirect. _Higher care (must not break login/persistence)._
- **B. Homepage is a standalone lightweight page (e.g. `/home` or `/start`), command center stays at `/`.** Zero risk to existing auth; weaker as a true front door.
- **C. Conditional `/`: serve homepage when logged-out, command center when logged-in.** Best UX; the most auth-sensitive.

**Recommendation:** B first (ship the homepage safely, zero auth risk, link to it), then graduate to C once verified. Do **not** touch auth/prices/persistence without explicit go-ahead.

## 9. Scope guardrails (non-goals)

- No portfolio required to use the page.
- No fake data shown as real.
- Mobile-first; one screen, no scroll-heavy stacking.
- No new framework (stays in the current stack per [the redesign decision](../vision.md)).
- The morning-scan engine is a **separate** feature/doc — this doc is the _display_ only.

## 10. Build plan (after sign-off)

1. **Phase 1 — static homepage** at the chosen route, ambient design, lookup wired to X-Ray, picks shown as labeled samples. _Shippable, verifiable on mobile._
2. **Phase 2 — morning-scan job** (own design doc) writes `market_picks`.
3. **Phase 3 — wire picks live**, drop the "sample" label.

## 11. Questions for sign-off

1. Routing option — **A, B, or C** (recommend B → C)?
2. Logged-in behavior — homepage-as-landing, or straight to dashboard?
3. Anything in the LOCKED layout (§4) to change before Phase 1?
