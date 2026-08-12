# AGENTS — Plainview Command Center

Read this file first. Every session, every agent.

## Project Identity

```
Project name:     Plainview Command Center
Version:          V3
Owner:            dar-fishman (TheGreatDurn007 on GitHub)
Live URL:         https://plainviewintel.com
Stack:            Next.js 15 / React 19 / TypeScript / Supabase / Anthropic Claude
Deployment:       Vercel (manual: `vercel deploy --prod`)
Primary file:     src/app/plainview-command-center.html (single HTML file, all JS/CSS inline)
```

## Read Order

1. `AGENTS.md` (this file)
2. `REPO_CONTRACT.md`
3. `DECISIONS.md`
4. `HANDOFF.md`

## Critical Rules — Never Break These

- Do NOT touch auth, Supabase user isolation, signup/login, deployment config unless explicitly required
- Do NOT fabricate scores, invent data, or hard-code AI answers
- `AI_QUOTA_ENABLED` must stay DORMANT — owner is not charging users
- `NEXT_PUBLIC_ALLOWED_EMAIL` is the owner gate — single user app
- Never commit `.env.local` or any secrets to git
- Always deploy with `vercel deploy --prod` from the plainview-web directory

## Agent Permissions

May change freely:
- `src/app/plainview-command-center.html` (UI, JS, CSS)
- `src/app/api/*` route handlers
- `src/lib/market-context.ts`
- Documentation files

Must ask before changing:
- Auth or Supabase user isolation
- Environment variable names
- Database schema or migrations
- `NEXT_PUBLIC_ALLOWED_EMAIL` gate logic
- Billing or quota logic
- Vercel project config

## Key Architecture Facts

- Single HTML file app — all JS/CSS is inline in `plainview-command-center.html`
- Supabase Storage bucket `plainview-state` holds ticker memory + radar cache
- Ticker memory: `_ticker_memory/{TICKER}.json` (~2-5KB each)
- Radar cache: `_radar/daily-v5.json` (12h TTL)
- SEC alerts memory TTL: 6 hours
- `secAlertsByTicker` — client-side JS object, populated by `/api/sec-alerts` + radar injection
- Mobile: `@media(max-width:600px)` — touch-first, `.card-touched` toggle pattern
- Deploy command: `cd plainview-web && vercel deploy --prod`
