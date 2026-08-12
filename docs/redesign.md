# Plainview — Platform Redesign Plan

_"Make the car match the engine." One sleek design language across every surface. Staged, not rushed — the working app stays live throughout. Last updated 2026-06-11._

> Companion to [vision.md](../vision.md) (what it is) + [ARCHITECTURE.md](../ARCHITECTURE.md) (how it runs). This = how it should **look and navigate**.

---

## 1. The reference surface

**`/x-ray` is the template.** It's done, on-brand, and shipped. Every other surface gets rebuilt to match its look and feel. When in doubt, open `/x-ray` and copy the pattern.

## 2. Design system (locked)

**Type**
- **Syne** — wordmark, tabs, headings, body. (`--sans`)
- **Space Mono** — all numbers, labels, mono accents. (`--mono`)
- Loaded via Google Fonts.

**Color tokens** (dark, neon-green): `--bg #0a0b0d`, `--surface #14161a`, `--surface2 #1a1d23`, `--border #262a31`, `--text #e8eaed`, `--text2 #9aa0a8`, `--text3 #5f656d`, `--green #1fdf64`, `--blue #3b9eff`, `--red #ff5c5c`, `--amber #e0a500`.
- Status coloring: good → green, bad → red, caution → amber, neutral → text.

**Surface patterns** (from `/x-ray`): faint grid + green top-glow background; rounded cards (`surface` bg, 1px border, 14–16px radius); metric tiles (`surface`, label in mono-uppercase-text3, value in mono colored by status); section headers (mono, uppercase, letterspaced, hairline rule); the green CTA bar.

**The header (locked)** — one shared component on every page:
- Left: hexagon "P" + `PLAINVIEW` (Syne 800) / `COMMAND CENTER` (Space Mono).
- Right (logged-in): **Total Value + `● live · time`** (the one headline number + price-freshness proof), a refresh icon (spins while fetching), a hide-amounts eye icon, and a **Sign out** button.
- Right (logged-out): a **Sign in** button.
- Below: the **tab row** (Syne, uppercase). Active tab = green text + underline.
- **Logged-out** sees all tabs but the locked ones are **faded (~45%)**; clicking a locked tab → `/login`. Only `/x-ray` is usable logged-out.
- **Principle:** the global header carries identity + nav + ONE headline number. Everything else (P&L, goal, best position, per-position data) lives on the surface, not the chrome.

## 3. Routing map

| URL | Surface | Access |
|---|---|---|
| `/` | Portfolio | login |
| `/watchlist` `/intel` `/decide` `/news` `/dashboard` `/sentiment` `/journal` `/settings` | each tab | login |
| `/x-ray` | the public X-Ray tool | **public** |
| `/login` | login | public |

- Each command-center tab is its own URL; the app reads the path on load → opens that tab, and updates the URL (pushState) when you switch tabs. Back button works.
- The nav's **X-RAY** item links to `/x-ray` (the public page), not an in-app tab.
- Logged-out: `/` and the tab URLs → `/login`; `/x-ray` shows the public tool.

## 4. Surface-by-surface order

1. ✅ **X-Ray** — done (the template).
2. **Header + per-tab routing** — bring the shared header + fonts into the command center; wire the tab URLs. (Next.)
3. **Portfolio** (the new root) — keep the features the user likes (thesis, INTEL brief, exit/take-profit, bear case, thesis-vs-facts), but **clean up the layout** into the sleek card language. Less clutter, same power.
4. **Dashboard** — the cockpit already exists; reskin to match.
5. **Watchlist** → **Intel** → **Decide** → **News** → **Sentiment** → **Journal** → **Settings**.

## 5. Principles (how we don't break things)

- **One surface at a time.** The app stays fully live; we never take it down to redesign.
- **Keep the features, clean the layout.** Especially Portfolio — the user likes what's there; the job is to *de-clutter and re-skin*, not remove function.
- **Global chrome minimal; data on the surface.**
- **Stay in the current vanilla stack** (proven by `/x-ray`); defer any framework migration.
- **Batch deploys.** Fewer, bigger ships — not one per tweak (we learned this the hard way; it paused the site).
- **Verify each surface** before moving on.

## 6. Status

- Design system: ✅ locked.
- Header: ✅ locked, ✅ live on `/x-ray`.
- Per-tab routing: ⬜ next.
- Surfaces redesigned: X-Ray ✅ · everything else ⬜.
