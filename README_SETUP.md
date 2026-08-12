# Plainview Web Upgrade

This is the migration target for the local HTML app.

The goal is:

- Same dashboard on desktop and phone
- Login with email/password
- Positions, watchlist, rules, catalysts, settings, and Intel briefs synced through Supabase
- Anthropic API calls protected on the server
- X-Ray data fetched from server routes instead of directly from the browser

## Step 1: Create Supabase

1. Go to https://supabase.com
2. Create a new project named `plainview`
3. Open SQL Editor
4. Paste and run `supabase/schema.sql`
5. Go to Project Settings -> API
6. Copy:
   - Project URL
   - anon public key
   - service role key

## Step 2: Create Anthropic Key

1. Go to https://console.anthropic.com
2. Create an API key
3. Save it as `ANTHROPIC_API_KEY`

Do not put this key in browser JavaScript or the old HTML file.

## Step 3: Local Environment

Copy `.env.example` to `.env.local` and fill in:

```bash
NEXT_PUBLIC_SUPABASE_URL=...
NEXT_PUBLIC_SUPABASE_ANON_KEY=...
SUPABASE_SERVICE_ROLE_KEY=...
ANTHROPIC_API_KEY=...
```

Optional market/news keys can be added later.

## Step 4: Run Locally

```bash
npm install
npm run dev
```

Then open:

```text
http://localhost:3000
```

## Step 5: Deploy to Vercel

1. Push this folder to GitHub
2. Import the project in Vercel
3. Add the same environment variables in Vercel Project Settings
4. Deploy

Once deployed, you can open the same URL on desktop and mobile.

## Why X-Ray Moves Server-Side

The current HTML app asks Yahoo/FMP/Alpha directly from the browser. Those services often block browser calls, rate-limit aggressively, or require secret keys. In the web app, `/api/xray/[symbol]` fetches the data from the server, so the browser only receives clean Plainview-ready JSON.

## Why Anthropic Moves Server-Side

The Anthropic key must stay secret. The frontend calls `/api/intel`, and the server route calls Anthropic with the protected key.
