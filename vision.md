# Plainview — Vision

_What we're building, in plain language. Last updated 2026-06-10._

---

## What it is (first-principles)

**An AI-assisted tool that turns user data and market data into grounded analysis and portfolio judgment.**

At its core Plainview is a function: `(user data) × (market data) → grounded analysis + judgment`. Everything else is presentation.

**Inputs**

- **User data** _(private, per account)_
  - **Portfolio** — current holdings, the thesis behind each, exit rules
  - **Watchlist** — candidates and their buy-zone targets
- **Market data** _(shared — the same for every user)_
  - **Fundamental** — financials, SEC filings, valuation, cash, margins
  - **Technical** — price, trend, momentum, short interest
  - **Historical** — past prices and the track record of prior reads

**Transformation (the engine)**

1. Gather and ground the data — facts outrank AI opinion
2. Score any security 0–10
3. Pressure-test each user thesis against current market data
4. Rank what needs attention

**Outputs**

- A scored X-ray of any security
- A skeptical brief — what changed, the real risk, the next catalyst
- Portfolio judgment — what's weakening, what needs a decision
- Entry timing — buy-zone signals on watched names

This split is the literal spine of the system, not just framing: **user data vs. market data** is the two-tier memory (private ledger vs. shared hive mind), and **fundamental / technical / historical** are the signal categories the engine actually gathers.

---

## Tagline (one sentence)

**Pressure-test any stock — and your own reasons for owning it — against live facts, so you invest with discipline, not FOMO.**

---

## Elevator pitch (one paragraph)

Plainview is a personal investing command center for people who want to make their own calls — without flying blind or getting swept up in hype. You can look up any stock, ETF, or crypto and instantly see what actually matters: the real financials from SEC filings, current price and trend, the genuine risks, and the next catalyst — scored 0–10 so you know where it stands. When you take a position, you write down _why_, and Plainview holds you to it: it tracks your entry timing, watches for the catalysts you're counting on, and tells you when the facts that justified the trade have changed. It's built to be skeptical, not promotional — it doesn't pick stocks for you, it makes your own judgment sharper and keeps you honest over time.

---

## One-pager (three paragraphs)

**The problem.** Most individual investors act on emotion and noise. Information is scattered across a dozen tabs, hype outruns facts, and — worst of all — people forget _why_ they bought something, so they hold losers out of hope and sell winners out of fear. There's no shortage of data; there's a shortage of disciplined judgment. Plainview exists to close that gap: one private command center that turns scattered facts into a clear, honest read on any stock and on your own portfolio.

**What you do with it.** Start by typing a ticker. Plainview "X-rays" it — pulling fundamentals, filings, price action, and sentiment into a single scored snapshot — and gives you a skeptical AI brief on what changed, the real risk, and the next catalyst. If you decide to act, you record your thesis and your exit rules. From then on, Plainview works for you in the background: it monitors your positions, flags buy-zone entry timing on names you're watching, surfaces upcoming catalysts, and — the part that matters most — ranks what actually needs your attention today and tells you when a thesis is weakening or has been contradicted by the facts. It's the difference between owning a stock and _knowing where you stand_ on it.

**What makes it different.** Plainview is a conviction engine, not a robo-advisor — it never tells you what to buy; it makes you a better decision-maker. Underneath, it runs on two principles that compound over time. First, a shared "hive mind": factual data about a company (its revenue, its filings) is the same for everyone, so it's gathered once and shared across all users — which means the platform gets more accurate and more complete the more it's used. Second, a strict rule that **facts always outrank AI opinion** — an AI's interpretation can be shown, but it can never quietly become "evidence," which keeps the whole system honest and stops it from fooling itself. And because it remembers your thesis history, it can do something almost nothing else does for a retail investor: show you, over time, how your conviction has held up against reality. Plainview is for the self-directed investor who wants the rigor of a professional desk — discipline, evidence, and memory — in a tool that fits in their pocket.

---

## Go-to-market — the three-layer funnel

The product spans markets of very different sizes. We don't try to make one feature appeal to everyone; we let each layer feed the next.

| Layer | Feature | Audience | Job |
|---|---|---|---|
| **Acquisition** | **X-Ray** (free, unlimited, shareable cards) | Huge — anyone curious about a ticker | "Know any stock in seconds." Be generous; every shared snapshot advertises Plainview. |
| **Curiosity** | **Intel** (Hidden Gems, signals) | Enthusiast — people who enjoy hunting | Surfaces evidence-backed setups; turns a visitor into an explorer. |
| **Differentiation** | **Decide + Opportunity Cost** | Self-directed investors | "Where should my next dollar go?" — the question almost no tool answers. This is what people pay for. |
| **Retention / moat** | **NEXUS** (memory, thesis tracking, morning brief) | Serious portfolio managers | Becomes the thing you check every morning. Habit → subscription. |

**Positioning.** Not "AI stock scanner #843." Plainview is the place to answer *where the next dollar belongs* — research → decide → allocate → monitor, with memory. We sell **judgment and memory, not data**: raw information (basic X-Ray, news, filings) stays generous and accessible; the paywall sits in front of the thinking and the remembering.

**The growth loop:** scan a stock → share the card → a friend sees the verdict → they scan → they share. The shareable X-Ray card *is* the distribution engine.

**The metric that matters right now is retention, not pricing.** With a small early user base, the only question worth answering is *"is anyone coming back, and what do they actually use?"* — measured by the owner-only Founder Analytics dashboard (Admin tab). We instrument first and let real usage — not opinion — decide which feature is the star, before reshaping the product or finalizing prices.

See [TIERS.md](TIERS.md) for the plan structure and the cost logic behind it.
