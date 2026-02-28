# Strategy & Vision — Intellacc

Status: living document, last updated 2026-02-28.

## What Intellacc Is

A social platform for sharing and discussing links (news, X posts, Substack, YouTube) with three built-in truth incentives that don't exist anywhere else:

1. **Consistency** (individual truth) — AI evaluates argument quality via the claimGate + argumentExtractor pipeline: logical structure, empirical soundness, fallacy detection. Acts as a "kind tutor" giving constructive feedback.
2. **Persuasion** (social truth) — Persuasive Alpha: measures whether people actually update their predictions after reading your post. Captures genuine influence, not engagement farming.
3. **Prediction** (real truth) — Track record: when reality resolves, were you right? LMSR-backed markets with log scoring, time-weighted reputation, and calibration metrics.

**Combined, these create a multi-dimensional credibility score that no other platform offers.** X has likes (popularity). Polymarket has money (conviction). Reddit has karma (agreement). Intellacc surfaces people who are logical, persuasive, AND correct.

## Positioning

Intellacc is NOT "the new X." It's a **discussion layer on top of the internet's content** with truth-tracking built in.

- Users share links to content that lives elsewhere — the value isn't creating content, it's analyzing it and putting your credibility on the line
- Every claim gets auto-matched to a prediction market via AI
- Reputation is earned through accuracy and intellectual honesty, not follower count

### Competitive Landscape

| Platform | What they do | What they lack |
|----------|-------------|----------------|
| X/Twitter | Real-time discourse, network effect | No truth incentive, bot-riddled, engagement-farming |
| Polymarket | Real-money prediction markets | No social layer, no reputation scoring, no discussion |
| Kalshi | Regulated prediction markets | Same as Polymarket — settlement, not discourse |
| Kash ($2M pre-seed, Feb 2026) | Prediction markets embedded in X | Dependent on X, no standalone platform, no reputation scoring, no argument analysis |
| Reddit/HN | Link sharing + discussion | No truth mechanism, karma = agreement not accuracy |
| Substack Notes | Long-form discussion | No prediction layer, no credibility scoring |
| Community Notes (X) | Crowd-sourced fact-checking | Anonymous, binary, gameable, no prediction backing |

**Intellacc's moat:** The three truth pillars are self-reinforcing. Bad actors get low prediction scores. Grifters get exposed by AI critique. Engagement farmers don't gain Persuasive Alpha. The system naturally selects for quality over time — and track records can't be faked or bought.

## Feature Roadmap — New Ideas

### 1. Automatic Digests (Personal AI Briefings)

**Concept:** Users connect their external subscriptions (X, Substack, YouTube, RSS) and receive a personalized daily digest filtered by AI that knows their interests and prediction activity.

**Why it matters:**
- Strong retention mechanic — users open Intellacc every morning
- Natural onramp — "connect your X to get a smart briefing" is low friction
- Content seeding — even with few users, the feed has fresh material
- Differentiation — no other platform offers a cross-source AI-curated briefing weighted by prediction relevance

**Implementation approach:**
- Browser-based scraping for X (no API needed — proven approach, ~100 tweets in 18 seconds)
- RSS/Atom for Substack, blogs, news sites
- YouTube API or RSS for channel subscriptions
- AI summarization with topic clustering and relevance scoring
- Delivery via in-app feed, email digest, or push notification

**Priority:** High for retention. Build after core loop is solid.

### 2. Polymarket / Kalshi Integration (Bet Mirroring)

**Concept:** Users can optionally mirror their Intellacc prediction positions with real money on Polymarket or Kalshi. Intellacc handles the social/reputation layer; external platforms handle settlement.

**Why it matters:**
- Adds real-money stakes without Intellacc needing financial regulation
- Doesn't compete with Poly/Kalshi — complements them
- Potential revenue source via referral/affiliate fees
- Adds credibility signal: "this person has $500 on their prediction"

**Implementation approach:**
- Phase 1: Read-only price display from Polymarket/Kalshi APIs alongside Intellacc markets
- Phase 2: Deep-link to place bet on external platform (referral tracking)
- Phase 3: API integration for seamless bet mirroring (requires partnership)

**Priority:** Medium. Phase 1 is easy and adds immediate value.

### 3. Cross-Platform Feed Aggregation

**Concept:** Intellacc as the "unified reader" — see your X, Bluesky, Mastodon, Substack, and YouTube subscriptions in one feed, with prediction markets auto-attached to claims.

**Why it matters:**
- Solves the fragmentation problem without requiring migration
- "Import a tweet" → instantly becomes a prediction market question
- Natural user acquisition: "I use Intellacc to read everything, and discuss it with skin in the game"

**Builds on:**
- Federation layer (ATProto MVP already implemented, ActivityPub planned)
- Browser scraping infrastructure (X scraper proven)
- claimGate + argumentExtractor pipeline (already processes any text)

**Priority:** High for user acquisition. The "share any link" flow already works; extending to feed import is incremental.

### 4. Embeddable Prediction Markets

**Concept:** Let anyone embed an Intellacc prediction market widget on their blog, Substack, or website — like how Twitter grew through tweet embeds.

**Why it matters:**
- Viral distribution mechanism without requiring users to visit intellacc.com
- "According to Intellacc markets, there's a 34% chance..." becomes a credibility signal
- Drives sign-ups from engaged readers who want to bet
- Establishes Intellacc as the source of truth for claims

**Implementation:**
- `<iframe>` or `<script>` embed with market ID
- Shows current probability, bet count, top predictors
- "Bet on this" CTA links to Intellacc
- oEmbed support for automatic embedding in CMS platforms

**Priority:** Medium-high. Low engineering effort, high distribution value.

### 5. Portable Credibility Score

**Concept:** Users can embed their Intellacc prediction credibility score on external profiles (X bio, LinkedIn, personal site) — a verifiable track record badge.

**Why it matters:**
- Creates a new status signal that replaces blue checkmarks
- "Top 5% predictor on Intellacc" is meaningful in a way "10K followers" is not
- Drives sign-ups from people who want to prove they know what they're talking about

**Implementation:**
- Public profile page with verification (already have profiles)
- Embeddable badge/widget (SVG or image)
- API endpoint for score verification

**Priority:** Longer-term. Needs critical mass of users with meaningful track records first.

### 6. Browser Extension: "Share to Intellacc"

**Concept:** One-click browser extension that takes any webpage and creates an Intellacc post with auto-generated prediction market.

**Why it matters:**
- Reduces friction for content sharing to near zero
- Works on any content source without integration work
- Natural habit formation: see interesting article → click → discuss on Intellacc

**Priority:** Medium. Build after core UX is proven.

## Growth Strategy

### Phase 1: The Smart Reader (now → 3 months)
- Nail the link sharing + auto-market UX
- Seed content from current news (AI, politics, economics, tech)
- Invite 50-100 people manually from AI/finance/politics Twitter
- Focus on core loop: share → market → bet → discuss → critique feedback

### Phase 2: The Aggregator (3-6 months)
- Cross-platform feed aggregation (X, Substack, YouTube)
- Automatic digests / personalized briefings
- Polymarket/Kalshi price display alongside markets
- Embeddable prediction market widgets
- Public leaderboard: "Top predictors this month"

### Phase 3: The Reputation Network (6-12 months)
- Portable credibility scores
- Full federation (ATProto + ActivityPub bridging)
- Bet mirroring with external platforms
- API for journalists/researchers: "What does Intellacc think about X claim?"
- Browser extension

### The Growth Loop
```
Share link → Auto market created → People bet →
AI critiques arguments → Persuasive Alpha tracked →
Outcome resolves → Leaderboard updates →
"I'm top 5% on Intellacc" shared on X →
New users come to prove they're smarter → repeat
```

### Cold Start Mitigation
- LMSR market maker provides automatic liquidity (already built)
- Auto-resolve markets from APIs (stock prices, election results) for trustless resolution
- AI-seeded content from news feeds keeps the platform lively even with few users
- Start with 1-2 niche communities (AI/tech Twitter, finance/prediction market enthusiasts)

## Key Differentiator Summary

Everyone else is adding prediction markets as a feature on top of social (Kash) or adding social as a feature on top of prediction markets (Polymarket community).

**Intellacc is building a new information architecture where truth-seeking is the native incentive**, not engagement, not money, not agreement. The three pillars (consistency + persuasion + prediction) create a credibility system that takes time to build, can't be bought, and gets more valuable with every resolved market.

That's the moat.
