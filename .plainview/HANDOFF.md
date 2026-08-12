# Handoff Log — Plainview

Most recent session at the top. Agent reads this to resume without re-deriving context.

---

## 2026-06-09 - Session Handoff

Task: Yahoo key statistics enrichment + shares outstanding accuracy + crumb auth
Current state: All deployed and live at plainviewintel.com — cache version v14

Completed:
- Yahoo crumb auth: getYahooCrumb() fetches Yahoo session cookie + crumb, cached in module memory 1h
- fetchYahooFundamentals: now authenticated — unlocks full quoteSummary data for all tickers
- New X-Ray fields added (display + scoring): ROE, ROA, freeCashflow, insiderOwnership, institutionalOwnership, beta, forwardPE, pegRatio
- US stocks enrichment: after SEC EDGAR fetch succeeds, Yahoo key stats merged in (roe/roa/beta/insider/institutional/forwardPE/pegRatio)
- Shares outstanding fix: Math.max across v7.sharesOutstanding + sec.sharesOutstanding + marketCap/price — AMC now shows 754,171,721 (was 539M)
- Scoring: ROE bonus (+0.5 if >15%, +1.0 if >30%), freeCashflow fallback for opCashflow
- Cache version: v14 (v8→v14 this session — bumped to clear stale entries as fixes landed)
- Canadian/OTC stocks (FDY.TO etc): unaffected — same code path, now also gets richer Yahoo data

Verified working:
- AMC: 754,171,721 shares, Insider 0.9%, Institutional 42%, Beta 2.31, PEG 12.22x
- TSLA: ROE 4.9%, ROA 2.2%, Insider 11.1%, Forward P/E 163x, Beta 1.80
- FDY.TO: ROE -32.6%, ROA -20.3%, Insider 21.6%, Beta 1.84 — Canadian path intact

Changed files:
- src/app/api/xray/[symbol]/route.ts

Open questions:
- Form 4 classifyForm4Codes() still falls back to generic text for mixed/ambiguous transactions (INFQ case)

Next steps (pending):
- Improve classifyForm4Codes() for cleaner mixed Form 4 summaries
- Review Architectonic's workframe + other private repos when access is granted

---

## 2026-06-08 - Session Handoff

Task: Mobile UX polish + SEC popup fixes + GitHub setup
Current state: All deployed and live at plainviewintel.com

Completed:
- fetchFilingSnippet: real SEC text in 8-K/10-K/10-Q/424B/S-3 popups
- 10-K/10-Q added to SEC alert detection (7-day recency gate)
- SEC alert memory TTL bumped 1h → 6h
- Hidden Gem Radar: evidence-first ranking with Evidence Momentum Score
- Form 4 P purchases + 8-K Item 1.01 promote tickers to Research Candidate
- Daily Intelligence Brief replaced with Hidden Gem Feed (filter tabs, 3 cards/page)
- Radar "Heating Up" rows: removed SEC text wall, replaced with amber dot + hover popup
- Watchlist SEC dot popup fixed (was broken on mobile tap)
- Mobile: STATUS badge + exchange tag hidden to save space
- Mobile: Exit/Take-Profit now collapsible details element
- Mobile: INTEL/EDIT/DEL hidden until card tap (opacity:0 → opacity:1)
- Mobile: SEC dot = 56px touch target, 30px proximity check in touchstart handler
- Mobile: SEC popup no longer flickers (400ms guard against synthetic click on touch devices)
- Mobile: INTEL/EDIT/DEL overlay on portfolio card (position:absolute over price column)
- Mobile: Watchlist action buttons at bottom-right corner
- Desktop: card-actions z-index:2 fix (was buried under card-top-val stacking context)
- Prices as of: white-space:nowrap so it stays one line on mobile
- Refresh Radar button removed; Refresh Intel now triggers radar too
- Project pushed to GitHub: TheGreatDurn007/plainview-web (private)
- buildAlertText: 424B/S-3/13D/13G now use real snippet instead of hardcoded generic text

Changed files:
- src/app/plainview-command-center.html
- src/lib/market-context.ts
- src/app/api/sec-alerts/route.ts
- src/app/api/radar/route.ts
