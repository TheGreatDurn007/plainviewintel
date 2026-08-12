/**
 * Plainview screenshot tool — authenticates via Supabase magic link,
 * navigates to any page/tab, and saves a screenshot.
 *
 * Usage: node scripts/screenshot.mjs [tab] [view]
 *   tab:  portfolio | watchlist | xray | intel | decide | news | dashboard
 *   view: quick | detailed  (portfolio/watchlist only)
 *
 * Examples:
 *   node scripts/screenshot.mjs portfolio quick
 *   node scripts/screenshot.mjs watchlist
 */

import { createClient } from '@supabase/supabase-js';
import { chromium } from 'playwright';
import { writeFileSync } from 'fs';
import path from 'path';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const USER_EMAIL = process.env.SCREENSHOT_EMAIL || 'dar_fishman@hotmail.com';
const SITE_URL = 'https://plainviewintel.com';

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars.');
  process.exit(1);
}

const [,, tabArg = 'portfolio', viewArg = 'quick'] = process.argv;

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false }
});

console.log('Generating magic link for', USER_EMAIL, '...');
// No redirectTo — Supabase defaults to site URL, puts tokens in hash fragment
const { data, error } = await supabase.auth.admin.generateLink({
  type: 'magiclink',
  email: USER_EMAIL,
});

if (error || !data?.properties?.action_link) {
  console.error('Failed to generate magic link:', error);
  process.exit(1);
}

const verifyUrl = data.properties.action_link;
console.log('Verify URL domain:', new URL(verifyUrl).hostname);
console.log('Launching browser...');

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();

// Follow the Supabase verify URL; it redirects to SITE_URL with #access_token=... in the hash
// We need to wait for the full redirect chain to land on plainviewintel.com
await page.goto(verifyUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

// Wait for redirect to land on the app
try {
  await page.waitForURL('https://plainviewintel.com/**', { timeout: 15000 });
} catch {
  console.log('waitForURL timed out, current URL:', page.url());
}

const landingUrl = page.url();
console.log('Landed on:', landingUrl);

// Give the client-side Supabase JS time to process the hash fragment and set auth cookies
await page.waitForTimeout(3000);

const urlAfterHash = page.url();
console.log('URL after hash processing:', urlAfterHash);

// If we're still on a login/auth page, the session was set in cookies — navigate to app root
if (!urlAfterHash.includes('/login') && !urlAfterHash.includes('/auth')) {
  console.log('Already on app, continuing...');
} else {
  console.log('On login/auth page — navigating to app root...');
  await page.goto(SITE_URL, { waitUntil: 'networkidle', timeout: 30000 });
}

// Let the app fully load and fetch portfolio data
await page.waitForTimeout(4000);
console.log('Final URL:', page.url());

// Take a debug screenshot first to check auth state
const debugFile = path.join('D:\\Screenshots', `plainview_debug_${Date.now()}.png`);
await page.screenshot({ path: debugFile, fullPage: false });
console.log('Debug screenshot saved:', debugFile);

// Check if we're authenticated (app renders portfolio, not login screen)
const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 200));
console.log('Page text preview:', bodyText.replace(/\n/g, ' ').slice(0, 150));

// Click the correct tab
const tabMap = {
  portfolio: 'PORTFOLIO', watchlist: 'WATCHLIST', xray: 'X-RAY',
  intel: 'INTEL', decide: 'DECIDE', news: 'NEWS',
  dashboard: 'DASHBOARD', sentiment: 'SENTIMENT'
};
const tabLabel = tabMap[tabArg.toLowerCase()] || 'PORTFOLIO';
const tabBtn = page.locator(`.tab-btn, button, [role="tab"]`).filter({ hasText: tabLabel }).first();
if (await tabBtn.count()) {
  await tabBtn.click();
  await page.waitForTimeout(1500);
  console.log('Clicked tab:', tabLabel);
}

// Toggle view if requested
if (viewArg === 'quick') {
  const viewBtn = page.locator('#pf-view-btn, #wl-view-btn').first();
  if (await viewBtn.count()) {
    const txt = await viewBtn.textContent();
    if (txt && txt.toLowerCase().includes('quick')) {
      await viewBtn.click();
      await page.waitForTimeout(1000);
      console.log('Toggled to Quick View');
    }
  }
}

const outFile = path.join('D:\\Screenshots', `plainview_${tabArg}_${viewArg}_${Date.now()}.png`);
await page.screenshot({ path: outFile, fullPage: false });
console.log('Screenshot saved:', outFile);

await browser.close();
