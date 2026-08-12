# NEXUS-THESIS — The Thesis Evaluation Constitution

_The formal definition of what a thesis is and what makes one good. This is the law the facts-vs-thesis engine obeys. If a verdict can't be traced to these rules, it's a bug. Companion to `NEXUS.md` (the judgment-layer vision). Last updated 2026-06-13 (v4 — X-Ray-as-lens + the Conviction Ledger / dual outcome-vs-reasoning judgment)._

---

## 0. Why this exists

The facts-vs-thesis check is Plainview's core credibility surface — the moat is *thesis evaluation*, not a stock scanner. The old engine fed headlines to an LLM and asked "do these support the thesis?" → it quoted headlines and stamped a near-random `+/−`, gave different answers on re-run, and let three headlines outvote one hard fact. That's a slot machine.

**The root cause was never "LLM vs no-LLM" or "facts vs judgment." It was the absence of a formal definition of a good thesis.** Until that definition exists, every verdict is arbitrary. This document is that definition.

### The three non-negotiables
Every verdict must be:
1. **Explainable** — a user can click any thesis and see *exactly* why it scored what it did.
2. **Repeatable** — same inputs → same scores, always. (Users forgive "I disagree with NEXUS." They never forgive "NEXUS gave me a different answer today.")
3. **Identical for every user** — the verdict is a function of the facts + the thesis, never of who's asking or how confidently they wrote it.

### The endgame (this doc is one of four pillars)
```
NEXUS = Evidence Graph + Thesis Constitution + Conviction Ledger + Critical Unknowns
```
- **Evidence Graph** — already exists (`nexus_signal_observations` + `renderEvidenceGraph`).
- **Thesis Constitution** — this document.
- **Conviction Ledger** — the Journal (`nexus_thesis_evaluations`), the longitudinal record.
- **Critical Unknowns** — §5, the decisive-information layer.

This version is not the final form. It is the first version that is a credible investing engine instead of an AI opinion generator.

### What NEXUS actually is
**An argument-analysis engine applied to investing.** Most platforms analyze *companies*; NEXUS analyzes the *argument*: **"Does your reasoning deserve conviction — and is it improving or decaying over time?"** The five scores, the Critical Unknown, and the Competing Explanation are all instruments for measuring an argument's quality, not a company's. The moat is **conviction intelligence**, not indicators/news/watchlists. (And X-Ray / Intel / Hidden Gems are not disposable acquisition funnels — they are the **evidence sensor layer** that feeds this engine. The argument engine is only as good as the facts it can score; never starve the sensors.)

---

## 1. What a thesis IS

A thesis is a **structured argument**, not a sentence. The engine decomposes every thesis into:

```
Thesis = ⟨ Claim, Magnitude, Horizon, Evidence[], Logic ⟩
```

| Component | Definition | Example (AMC) |
|---|---|---|
| **Claim** | The specific outcome asserted | "AMC reaches $9" |
| **Magnitude** | Size of the implied move | $9 ≈ 4× current price |
| **Horizon** | By when | 12 months |
| **Evidence** | The facts cited as support | "Attendance improving" |
| **Logic** | The causal chain evidence→claim | attendance↑ → EBITDA↑ → valuation↑ → price↑ |

**The central architectural principle — separate truth from validity:** the *truth* of the evidence is evaluated independently from the *validity* of the reasoning that connects it to the claim. A true fact joined to the claim by a broken chain is a weak thesis, and the scorecard must say so. (This is the formal-argumentation move, and it is the single thing that dissolves the BB problem: a *true* Nvidia partnership joined to a $13-14 target by a *broken* chain = high Evidence, low Logic/Magnitude.)

---

## 2. The Five Scores

Each score is **0–10, independently explainable, and shows its inputs on demand.** They are **never averaged** into one number (§4).

### 2.0 Five internally, three on the surface (the anti-cockpit rule)
The engine computes **five** scores for rigor + determinism. The **default user view shows three pillars** — the compression a retail investor actually reasons in:

| Pillar (shown) | = internal scores | Question |
|---|---|---|
| **Evidence** | Evidence | Are the facts true? |
| **Reasoning** | Logic + Magnitude | Does it follow, and is the *size* justified? |
| **Risk** | Contradiction + Confidence | What opposes it, and how sure are we? |

Three pillars + the one-line verdict + the Critical Unknown = the surface. Click any pillar → the underlying scores and their inputs (progressive disclosure). **Do not surface all five by default — that's a cockpit.**

### 2.1 Evidence Score — "How much of the thesis is verifiable?" — DETERMINISTIC
Measures the **truth and strength** of the supporting facts, ignoring whether they justify the claim.
- Extract the thesis's factual claims (LLM extraction — reliable, low-judgment).
- For each claim, find the best supporting source in the fact set and weight it by **source tier** (the hierarchy is constitutional: SEC > earnings > insider buys > guidance > press > price action > analysts):

| Tier | Source | Weight |
|---|---|---|
| T1 | SEC/SEDAR filing, audited financials | 1.00 |
| T2 | Earnings release (reported figures) | 0.85 |
| T3 | Insider transactions (Form 4 — buys/sells) | 0.70 |
| T4 | Company guidance / PR / IR | 0.55 |
| T5 | Reputable wire / financial press (Reuters, Bloomberg, WSJ, GlobeNewswire, Newswire) | 0.55 |
| T6 | Hard market data (price, volume, short interest) | 0.45 (for what it directly measures) |
| T7 | Analyst opinion / price target | **0.20** (weakest real signal — context only, near the floor) |
| T8 | Aggregator / blog / forum / rumor | 0.05 |

- **Evidence Score = weighted claim coverage** = (Σ best-tier-weight over claims with backing) ÷ (claim count), scaled to 0–10. A claim with **no** source contributes 0.
- Deterministic: the LLM only extracts and matches claims to sources; the weighting and the score are code.

### 2.2 Logic Score — "Does the conclusion follow from the evidence?" — JUDGMENT (rubric-constrained)
Measures the **validity of the causal chain**, *assuming the evidence is true*.
- The engine reconstructs the chain and scores it against a fixed rubric (each link 0/1/2): **completeness** (links stated/inferable, no leaps), **causal validity** (X actually drives Y), **direction** (evidence points the way the thesis needs), **sufficiency** (the links together reach the claim).
- The smart tier (Sonnet/Opus) applies the rubric; the output includes the **reconstructed chain with the weak/missing link marked**.
- Canonical failure it must catch: *"Company won a $5M contract; market cap is $20B; therefore the stock doubles."* Evidence true, Logic ≈ 2/10.

### 2.3 Magnitude Score — "Even if you're right, does the evidence justify THIS target?" — JUDGMENT + BANDS
The most important and the hardest. Measures whether the implied move is **proportional to the catalyst's materiality.**

> **Magnitude is HISTORICAL PLAUSIBILITY, not a reality detector.** It answers *"has a move this size, on a catalyst this material, happened before?"* — never *"will it happen."* NVDA-2023, PLTR-2024, MSTR, BTC all looked absurd on magnitude and happened anyway. Therefore a **low Magnitude score NEVER kills a thesis** — it flags it *"aggressive / high-variance"* and shows the precedent. Magnitude caps the *upside-confidence*, it does not stamp *false*.

- Compute implied move = (target − price) ÷ price; **annualize by horizon.**
- Classify catalyst materiality from the *verified* evidence: **Transformational** (changes the business/TAM) · **Significant** (meaningful to rev/earnings) · **Incremental** (minor) · **Negligible/none**.
- Score from a fixed **band table** (consistent, not falsely precise):

| Materiality ＼ annualized implied move | <25% | 25–60% | 60–150% | >150% |
|---|---|---|---|---|
| Transformational | 9 | 8 | 6 | 4 |
| Significant | 8 | 6 | 4 | 2 |
| Incremental | 6 | 4 | 2 | 1 |
| Negligible | 3 | 2 | 1 | 0 |

- **Analyst consensus enters ONLY here, as context** — a sanity reference, never truth. **Stale consensus (price already above it = analysts lagging) is down-weighted and never counts as downside.** (§7.)
- **Evolution path:** replace the static table with an **empirical calibration** — base rates of how often catalysts of materiality X drove moves of size Y, by sector/regime. Then Magnitude becomes a learned plausibility model, not a hand-set table. (Future; the table is the v1 stand-in.)

### 2.4 Contradiction Score — "How much quality evidence OPPOSES it?" — DETERMINISTIC-leaning
Measures genuine disconfirming evidence — **not headline-counting.**
- Scan the facts for hard opposition: insider selling, declining revenue, margin compression, dilution / raises against the thesis, negative guidance, debt distress, or the wrong business (ticker collision).
- Weight by the same source-tier table.
- **Contradiction Score = 10 − (weighted opposing evidence)** → 10 = no quality opposition, 0 = strong opposition.
- **"Missing"/unverified is NOT contradiction.** **Price action alone is NOT contradiction** (a dip is not a disconfirming fact). These guards (`reconcileStatus`) are constitutional.

### 2.5 Confidence Score — "How much uncertainty remains?" — SEMI-DETERMINISTIC
Measures fragility of the whole evaluation.
- Lower when: thin/incomplete data, a **single binary event** dominates (Phase-3 readout, FDA/court/vote), **long horizon**, one-source reliance, high volatility.
- Higher when: broad corroborated evidence, near-term, multiple independent confirmations.
- Rule-based composite over those drivers.

---

## 3. Time Horizon is a modifier, not a sixth score
Horizon folds into **Magnitude** (annualize the implied move — $9 AMC is plausible-ish over 3 years, absurd over 3 months) and **Confidence** (longer horizon → more unknowns → lower).

---

## 4. The verdict EMERGES from the profile — never an average
The five scores are the primary output (a **scorecard**). A 9-Evidence / 2-Magnitude thesis is **not** "5.5/10" — it is *"right idea, wrong price,"* the useful truth. Averaging re-buries the signal we just separated.

A **deterministic pattern-match on the profile** generates the one-line verdict:

| Profile | Verdict |
|---|---|
| Evidence high · Logic high · Magnitude high · Contradiction high | **Supported** — facts, logic, and price line up |
| Evidence high · Logic high · **Magnitude low** | **Right idea, aggressive price** — real catalyst, target is a stretch by historical precedent |
| **Evidence low** | **Unsupported** — rests on a claim no source confirms |
| **Contradiction low** (strong opposition) | **Contradicted** — hard evidence works against it |
| Scores ok · **Confidence low** | **Plausible but binary** — one event decides it |
| Mostly empty | **Insufficient** — not enough to judge |

Note: **Magnitude never produces "Unsupported"** — only "aggressive." Only low *Evidence* or strong *Contradiction* can do that. Because the verdict is a function of the scores, it is identical for every user with the same inputs.

---

## 5. Critical Unknown — "What would change my mind?"
The most valuable output is not *"is the thesis good?"* but **the single piece of not-yet-known information that would most move the scorecard.** (Intelligence-analysis: the linchpin / key-assumptions check; value-of-information. The decisive question is what would *flip* the conclusion, not what merely supports it.) Most platforms only surface confirming evidence; this is the layer that doesn't.

**Definition (rigorous, not a vibe):** the Critical Unknown = `argmax` over the thesis's premises/links of **(impact-on-verdict × current-uncertainty)**. Candidates are high-impact links (Logic) that are unverified (Evidence) or low-confidence (Confidence); a dominant binary event (Confidence) usually *is* the Critical Unknown.

**It is always stated WITH its consequence** (value-of-information made concrete):
- *"The load-bearing unknown is whether Q2 attendance converts to EBITDA. If it does → Logic 6→8, Supported. If not → the chain breaks, Unsupported."*
- *"This thesis is ~entirely dependent on the FDA decision (binary). Confidence stays capped until it resolves, regardless of the other scores."*

**Why it's first-class:**
- Tells the user exactly what to **watch** — actionable, not academic.
- Feeds the **catalyst monitor**: NEXUS knows which event to track; when it resolves, the thesis auto-re-evaluates.
- Feeds the **Journal**: the evolution story becomes *"the critical unknown resolved on <date> → conviction +X."*
- Hardest part of the moat to copy — genuine analysis, not classification.

### 5.1 Competing Explanation — "Is there a *better* story for the same facts?"
A real argument is judged against **competing hypotheses**, not just supporting evidence. The decisive question is not *"is my explanation possible?"* but *"is there a better explanation of the same facts?"* (Analysis of Competing Hypotheses.)

**Discipline (this is where the slot machine sneaks back in — guard it):** a Competing Explanation is NOT a free-form AI bear case. It must:
1. Explain the **same observed evidence** with a **different cause** — introduce **no new unverified claims**.
2. Be scored by **which interpretation the *rest* of the evidence favors** — parsimony + corroboration, not vibes.

*AMC: "attendance up" → your cause: structural recovery (EBITDA↑). Competing cause: a single blockbuster window (no structural change). Same fact, two causes. The engine then asks the other evidence — breadth across months/films (structural) vs concentration (one-off)?*

**The unification (why 5 and 5.1 are one mechanism):** the **Critical Unknown is usually the single fact that would discriminate between the thesis and its best Competing Explanation.** *"Q2 attendance breadth distinguishes a structural recovery from a one-film spike"* is the alternative and the critical unknown, fused. Find the competing story → name the fact that settles it. This is the Phase-4 capstone — the layer that makes NEXUS feel genuinely intelligent.

---

## 6. Explainability (the credibility unlock)
Every score is clickable to its inputs:
- **Evidence 8/10** → the claims, each with its source + tier; the unbacked ones called out.
- **Logic 4/10** → the reconstructed chain with the weak/missing link marked.
- **Magnitude 3/10** → implied move, materiality class, the band cell + the historical-plausibility caveat.
- **Contradiction 6/10** → the specific opposing facts + their tiers.
- **Confidence 4/10** → the uncertainty drivers.

"Why did NEXUS score this 6.5?" must have an obvious, repeatable answer.

---

## 7. Constitutional rule: analysts are context, never truth
Analyst targets/opinions are **T7 — among the weakest signals in the system**. They inform **Magnitude context only** and nothing else. **A thesis never fails because analysts disagree** — Tesla, NVDA, PLTR, and BTC would all have screened "unsupported" before their moves. Stale consensus (price already above it) is down-weighted further and **never** treated as downside.

---

## 7.5 X-Ray is a lens + a risk input — never the verdict
X-Ray scores the **business** (backward-looking: profitability, balance sheet & runway, revenue scale & growth). NEXUS scores the **argument** (forward-looking). They are different questions and must stay separate — a 9.0-X-Ray company can be a fraud about to collapse (X-Ray stays 9.0 on the last filing while NEXUS's Contradiction spikes and the Critical Unknown becomes "are the earnings real?"). So the X-Ray *score* plugs into the argument engine at **exactly three places, and nowhere else**:
1. **Context lens** — the band selects *how* NEXUS evaluates (like the mining/biotech/crypto lenses): `1–2` likely broken · `2–4` weak · **`4–6` turnaround / deep-value** (a low score + a Tier-1 insider buy is a *situation type*, not a dead company) · `6–8` solid · `8–10` high-quality-but-watch-the-crack.
2. **Contradiction input** — a weak business is real evidence *against* a growth thesis (a strong one removes a contradiction).
3. **Magnitude materiality reference** — a stronger balance sheet can absorb a larger re-rating.

It must **NEVER** touch **Evidence** or **Logic** (the truth of the facts / the validity of the reasoning), and it is **never a verdict**. The insider buy is Tier-1 *Evidence* on its own — separate from the score. X-Ray is a tool *for* the argument, never the judge of it.

## 8. The Conviction Ledger — the Learning layer (the real moat)
- Every evaluation stores the **full five-score scorecard + the Critical Unknown** into the thesis ledger (`nexus_thesis_evaluations`, per-user, append-on-change). `strength_score` is *derived from* the scorecard, not a standalone label.
- The **Journal** renders each score's **evolution over time** per thesis: *"Evidence held, but Magnitude degraded as the stock ran into its target,"* *"Contradiction rising — insider selling appeared,"* *"the critical unknown resolved → conviction +."*
- The thesis checker is the **measurement instrument**; the Journal is the **longitudinal record**. The checker stops being a classifier and becomes the engine that feeds conviction evolution. *(The Journal is already further toward the future than the checker was — this aligns them.)*

### 8.1 Outcome-right ≠ Reasoning-right (the dual judgment — the hardest part to copy)
When a thesis resolves, the ledger grades **two separate things**, never one:
- **Outcome** — did it work? (price hit target / catalyst occurred). Already gradeable via `nexus_predictions` / `nexus_outcomes`.
- **Reasoning** — was the argument *sound*, independent of the result? Did the Critical Unknown resolve the way the thesis assumed; did the verified evidence actually drive it; or did it win/lose for a reason the reasoning never named?

Four quadrants, and the system must distinguish them:
| | Outcome right | Outcome wrong |
|---|---|---|
| **Reasoning right** | Skill — reinforce the process | Variance / black swan — *don't punish the process* |
| **Reasoning wrong** | Luck — *don't reward the process* | Failure — fix the process |

A results-only tracker ("did the price hit the target") teaches users to chase outcomes and rewards luck. Grading the **reasoning separately from the outcome** — the evidence≠logic separation extended *after the fact* — is the genuinely hard-to-copy hive mind: **NEXUS remembers which *arguments* were sound, not just which *trades* won.** The Ledger contract therefore records, per evaluation: the thesis, the scorecard, the Critical Unknown, the predicted outcome — and on resolution, both `outcome_correct` and `reasoning_correct`. This is defined BEFORE Logic/Magnitude so every layer, as it ships, writes into a record that can already learn.

---

## 9. Build order
Sequenced so the highest-value, most-deterministic pieces ship first; Magnitude (least mature) and the Alternative layer (most advanced) come last.
1. **Phase 1 — Evidence + Contradiction + Critical-Unknown-*lite*.** Decompose the thesis; the two deterministic scores; a lite Critical Unknown = the highest-impact *unverified load-bearing* claim (derivable from Evidence + Contradiction before Logic exists). Surface = three pillars + verdict + the one critical unknown. Minimal, explainable, free, no cockpit. (Confidence can ride along — it's cheap — but Critical Unknown is the value, so it's in Phase 1, not deferred.)
2. **Phase 2 — Logic** on the smart tier (the reconstructed chain + rubric). This is where Sonnet shines.
3. **Phase 3 — Magnitude**, treated as **experimental** for a while — plausibility bands only, never a kill switch. Mature later into the empirical calibration (§2.3).
4. **Phase 4 — Competing Explanation + full Critical Unknown (the discriminator).** The capstone where NEXUS starts to feel genuinely intelligent.
5. Throughout: wire the **scorecard into the Journal ledger** + the evolution view (conviction over time is the moat).

---

## 10. Non-negotiables (the constitution, in one screen)
- Explainable · Repeatable · Identical-per-user.
- **Evidence truth ≠ Logic validity** — separate scores, always.
- AI output is never evidence (see `reference_nexus_evidence_hierarchy`).
- **Analysts are context, never truth** (T7, near the floor).
- **Magnitude is historical plausibility, never a kill switch** — only Evidence/Contradiction can mark a thesis false.
- **No averaging** — the profile is the verdict.
- "Missing" ≠ "contradicted"; **price action ≠ contradiction.**
- **Five scores internally, three pillars on the surface** — rigor underneath, no cockpit on top.
- The most valuable output is the **Critical Unknown**, not the verdict.
- A **Competing Explanation must explain the SAME evidence** (no free-form AI bear cases); the Critical Unknown is the fact that discriminates between the two.
- NEXUS is an **argument-analysis engine** — it judges the *reasoning*, not the company. X-Ray/Intel/gatherSignals are the **evidence sensor layer** that feeds it; never starve them.
- **X-Ray is a lens + risk input, never the verdict** — it touches Contradiction/Confidence/Magnitude-materiality, NEVER Evidence or Logic.
- **Outcome-right ≠ Reasoning-right** — the Ledger grades the *process* separately from the *result*; never reward luck or punish variance.
- Three of five scores are deterministic + free; only **Logic + Magnitude** spend the paid brain — the constitution and the cost model are the same shape.
