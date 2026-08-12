# Repo Contract — Plainview

## What This App Does

Personal investing intelligence tool. Owner tracks portfolio + watchlist, gets SEC filing alerts, AI thesis checks, hidden gem radar, and intel briefs. Single user — owner only.

## Stack

```
Frontend:     Single HTML file (plainview-command-center.html) — all JS/CSS inline
Backend:      Next.js 15 API routes (src/app/api/*)
AI:           Anthropic Claude (via @anthropic-ai/sdk)
Database:     Supabase (auth + storage)
Data:         EDGAR SEC API, Yahoo Finance prices, news APIs
Deployment:   Vercel (manual deploy)
Domain:       plainviewintel.com
```

## Source of Truth

```
UI + all client logic:   src/app/plainview-command-center.html
SEC + market data:       src/lib/market-context.ts
API routes:              src/app/api/
State storage:           Supabase Storage bucket: plainview-state
```

## Definition of Done

A task is complete when:
1. The named problem is addressed
2. The file changes are listed
3. `vercel deploy --prod` succeeded (Aliased to plainviewintel.com)
4. No secrets or private data were added to git

## Non-Goals

- Not a multi-user SaaS
- Not a trading execution platform (view only)
- Not connected to brokerage APIs
- AI never executes trades or moves money
- No charging users (AI_QUOTA_ENABLED stays DORMANT)
