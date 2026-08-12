# THE LEDGER — Plainview's Weekly Email (spec v2)

> Name: **The Ledger** (ties to the conviction-ledger moat; avoids the in-app **Journal** page). Masthead: `PLAINVIEW · THE LEDGER`. v2 absorbs the "$5M-investor" review: end in ACTION, frame as INTELLIGENCE, carry a SURPRISE, watch the USER, and let NEXUS take a STANCE.

---

## 1. The job
**The Ledger is NEXUS's weekly intelligence report — not a newsletter.** The frame is *"your analyst has spent all week watching your portfolio, and this is what it concluded."* It digests the firehose (big portfolio + big watchlist + intel + volume + narrative + sectors + opportunities) into **perspective and a decision**: where you stand, what actually mattered, what it means *about you*, and what to do Monday. It reduces overwhelm and ends in action — it is not a recap.

The test for every line: *does this change what the reader does or believes Monday morning?* If not, cut it.

## 2. The product model (the coherent story this slots into)
NEXUS is an **always-on analyst** continuously building understanding of the user's portfolio, decisions, and conviction over time. It communicates on three cadences:
- **The Morning Brief** = the *daily interrupt*, pre-market (~9:00 ET) — speaks only when something deserves attention. (LIVE.)
- **The Evening Brief** = the *daily recap*, post-close (4:30 ET, or push to ~6:30 ET for a true-evening read) — the portfolio review. (LIVE.)
- **The Ledger** = the *weekly report*, **Sunday evening (~6–7 pm ET)** — NEXUS's considered assessment + Monday's orders, landing the night before the user acts. (Spec'd; builds after history accrues.)
- **The Command Center (app)** = the *interactive layer* — where you investigate when NEXUS says something matters.
The app stops being "a pile of tools" and becomes an intelligence system with three voices. The Ledger is the weekly voice.

## 3. Why it's defensible
Stocktwits/Bloomberg/Seeking Alpha watch the **market** and send everyone the same thing. The Ledger watches **you** — your book, your conviction, your decisions, your patterns — and reports back. The two un-clonable sections (§4.4 "What I learned about you" and §4.5 "If I owned your book") are impossible for anyone without your decision history. The moat isn't the writing; it's that NEXUS has been watching *your* operation all week.

## 4. Structure — v2 (intelligence → stance → action). 5 content modules; ends on the *do*.
Order is deliberate: it climbs from *assessment* to *NEXUS's stance* to *Monday's orders*.

1. **The Assessment** *(intelligence, not recap — folds "where you stand" + "the week read" + a compact book line)* — the synthesis: where the reader stands this week and **what actually mattered**, connecting the market's move → their sleeves/volume/narrative → the one thing that counts. Includes a tight one-line book scoreboard (move vs market; biggest pop/drop). *Source:* briefSignals + market context + conviction deltas, fed to the grounded narrative.
2. **What changed your conviction** *(the signal)* — week-over-week thesis moves (strengthened / weakened / **newly** contradicted; avg conviction Δ). Credibility-gated (insufficient ≠ contradicted). *Source:* `nexus_thesis_evaluations`.
3. **The surprise** *(the delight — ONE per week)* — something they didn't know they wanted: *"You were right — your RKLB conviction rose and the market still hasn't noticed."* / *"Waiting on PLTR saved you ~$2,900 in average cost."* / *"Your best idea wasn't your biggest winner — BB's conviction rose while the price sat."* *Source:* conviction-vs-price divergence, opportunity-cost engine, avoided-mistake detection (action ledger + price).
4. **What I learned about you** *(the deepest moat — behavioral self-knowledge)* — one true observation about the *investor*, not the market: *"You've grown more patient — three of your last four buys started inside a buy zone."* / *"You tend to average up."* / *"You ignore bearish evidence until after earnings."* *Source:* `nexus_actions` + action grades + buy-zone journal, over time. (Needs history — see §7.)
5. **If I owned your book** *(the climax — NEXUS takes a stance, 3 sentences)* — *"If I owned this book I wouldn't touch TSLA. I'd spend the week on AMC — that's where the uncertainty lives. Everything else can wait."* This is THE reason people open it. *Source:* the ranked attention + conviction + material events, composed into a position.
6. **Monday's Playbook** *(the close — 3 action bullets, nothing more)* — `• Hold TSLA — nothing changed.` `• Read the AMC dilution filing.` `• RKLB is entering your buy zone.` Each bullet links into the app to act.
7. **CTA + footer** — "Investigate in Plainview →" (UTM `utm_campaign=ledger`); Preferences · Unsubscribe (`%%UNSUB%%`); funnel-tracked.

> Folded out (data still used, no standalone module): standalone pops-&-drops, the sector heat-map, and the "what you did/ignored" recap now live *inside* the Assessment, the Surprise, and "What I learned about you." Tighter = stronger.

## 5. The voice — confident CIO with Plainview's edge
NOT full Daniel Plainview theatrics (they get performative read weekly for years). NOT a bland analyst. The register: a **plainspoken, decisive hedge-fund CIO** — Marks/Druckenmiller/Munger calm — whose confidence comes from **clarity, not intensity**. Keeps Plainview's *soul* (decisive, allergic to noise, won't flatter) but delivers it level and dry. *Ruthlessly clear, not ruthlessly aggressive.* Always grounded — the figure-audit (§6) rules every sentence; the voice never invents.
- *Quiet week:* "A quiet week — your book held, your theses held. Nothing here needs your hands. That's the job most weeks."
- *Stance:* "If I owned this, I'd leave it alone but for one thing: AMC. That's where the week's real risk sits."
- *Behavioral:* "You're getting more patient. Three of your last four buys started inside a zone — keep doing that."

## 6. Doctrine
1. **End in action.** Every Ledger closes on Monday's Playbook. Analysis that doesn't change a decision is cut.
2. **Intelligence, not journalism.** Lead with *what to care about*, not *what happened*.
3. **Watch the user, not just the market.** The behavioral/self-knowledge sections are the moat — protect them.
4. **One surprise per week.** The forwardable delight.
5. **Grounded voice.** AI-written (free-first chain), narrates real signals only; figure-audited before send (`verify-figures.ts`); untraceable figure → dropped or deterministic-template fallback. Credible > clever. [[reference_nexus_evidence_hierarchy]] [[project_nexus_accuracy]]
6. **Ruthless length.** Challenge every module: *"deleted — would they miss it?"* If not, kill it. The arc is 5 modules, not 8.
7. **It's a report, not a newsletter.** "Your analyst has finished," never "here's your newsletter."

## 7. Data sources (mostly built; two need history)
| Module | Source |
|---|---|
| Assessment, book line | `briefSignals` (sweep) + `loadUserBook` + `fetchMarketContext` |
| Conviction | `nexus_thesis_evaluations` wk/wk · credibility gate |
| **Surprise** | conviction-vs-price divergence · opportunity-cost engine · avoided-mistake (action ledger + price) |
| **What I learned about you** | `nexus_actions` + action grades + buy-zone journal **over time** |
| If I owned your book | ranked attention + conviction + material events |
| Monday's Playbook | the above, reduced to ≤3 acts |
| Narrative voice | free-first chain (Cerebras→Groq→Gemini→Claude), grounded + figure-audited |

Cost ~**$0** (one grounded narrative call/recipient; rest deterministic). Reuse `sendEmail`, suppression, unsubscribe, UTM funnel.

## 8. Build notes
- `src/lib/weekly.ts` → `buildLedger(userId, market?)` mirroring `buildBrief`; shares styling, `%%UNSUB%%`, `tag()`.
- `composeLedger(signals)` — feeds curated, **already-gathered** facts to the free-first LLM with the CIO-voice + grounding prompt (temp 0); **figure-audits the output**; deterministic-template fallback on audit fail.
- `src/app/api/admin/ledger/route.ts` (owner test `?to=`, dry-run) + a weekly cron — **Sunday ~22:00 UTC** (≈6 pm EDT / 5 pm EST), `0 22 * * 0`. This is a 3rd cron alongside AM+PM: fine on Vercel **Pro**; on **Hobby** (2-cron cap) fold the Ledger into the Sunday evening slot (skip the daily PM that night, or run Ledger-instead-of-PM on Sundays). DST drifts the ET hour ~1h — nudge in November like the daily crons.
- **Gating:** the daily-brief test gate is now in CODE (`LIVE_TO_ALL`/`TEST_ONLY`) — the Ledger reuses the same pattern.
- **History dependency:** §4.3 (surprise) and §4.4 (what I learned about you) need ~2–3 weeks of `nexus_actions` + conviction history to be real. Build the engine now; these two sections light up as history accrues (others work day one). Ship after the daily brief's accuracy fixes prove out.

## 9. KPI
**email → login → time-in-app**, and **forwards** (a great report gets forwarded). The deeper KPI: *did Monday's Playbook change what the reader did?* and *did "what I learned about you" make them feel seen?* — being seen is the retention.

## 10. What The Ledger is NOT
❌ A market-recap newsletter. ❌ Same-for-everyone. ❌ Daily. ❌ A list of everything that happened. ❌ Backwards-only (it ends forward, in action). ❌ AI free-styling.

**The bet:** NEXUS spends the week watching *your* operation, then reports — with a stance and an order list. "Your analyst has finished." No one watching only the market can write that.
