# Feature Roadmap

Updated: 2026-06-13. This is the forward plan; `unified-backlog.md` is the
status ledger of what already shipped. Completed plan documents live in
`docs/archive/`.

## Done 2026-06-12: Group chats (messaging)

Shipped: named groups with create/invite flow, merged conversation list,
member list + add-member in the chat header, real usernames on sender
labels; edit/delete/read-receipts/disappearing messages work in groups
unchanged. Covered by a three-user E2E spec including late-join history
privacy. Unblocked along the way: epoch keypair storage in the WASM
provider (cross-member commits were universally broken) and the
isNumericIdentity regex (group welcomes were always rejected).

Group polish shipped 2026-06-12: leave group (self-remove proposal,
auto-committed by a remaining member with relay-level race arbitration) and
the message-request UI (accept/decline invites from non-followed users).
Fixed along the way: relay rows no longer deleted while a group has pending
joiners (second-invitee message loss), welcomes record their epoch so
joiners are backfilled the commits they must process, and the commit-rollback
path no longer deadlocks the client by awaiting its own sync.

## Done 2026-06-12: Persuasive Alpha visibility

Shipped: "Persuasion Rewards" panel in the analytics dashboard (earned RP,
rewarded posts, attributed market moves, recent payouts) and a public
"moved a market" attribution badge on posts with linked markets
(GET /posts/:postId/signal-summary). Covered by backend route tests with
seeded episode/payout data. First-payout notification deferred until the
pipeline sees real traffic.

## Done 2026-06-12: Agent CLI

Shipped: zero-dependency JSON-first CLI (`cli/intellacc.js`) for headless
agents — markets (list/get/trade with idempotency keys), social (feed/post),
whoami/config-verify. Backend hardening on the pre-existing api_keys system:
one key per user, agent lockout from sensitive surfaces (MLS, credentials,
devices, key management, account lifecycle, admin), 120 req/min rate limit,
Idempotency-Key replay protection on trades/posts. Usage: docs/agent-cli.md.
E2EE messaging for agents deliberately deferred.

## Later (unordered)

- **Offline + background sync (PWA)**: offline app shell, queued actions,
  background sync. Currently push-only.
- **Social graph UX (remaining)**: follower/following list pages, repost
  surfacing. The discovery centerpiece shipped 2026-06-12: a 3D follow-network
  page (#network) with WebGL force graph (repurposed from the DT project),
  node size = followers, color = forecasting accuracy, click-to-follow.
- **Social groups/communities**: public topic/market groups with
  membership and moderation. Needs product design first.

- **Nightly E2E job**: scheduled run of the messaging spec with test-user
  cleanup; deferred in favor of feature work.

- **Visual-regression net (v1 shipped 2026-06-13)**: 7 van-skin Playwright
  screenshot baselines (`tests/e2e/visual-regression.spec.js`) — home logged-out,
  login, signup, onboarding picker, analytics, settings, notifications — local
  on-demand, as the safety net for CSS streamlining. Verified to catch the
  picker-garble class of regression. Deferred: dynamic views (feed/predictions/
  network) need a component-isolation harness to snapshot reliably; terminal-skin
  baselines; CI integration once baselines prove stable across the container env.

- **Discover predictor-ranking cost at scale** (`discoverController.topPredictorsFor`):
  `GET /discover/predictors` (and `/discover/feed`) runs two full aggregations
  over `predictions` grouped by user (in-topic + global padding) with no time
  bound, on every request. Fine at current data size; as `predictions` grows,
  bound by recency, cache per-user for a few minutes, or precompute per-topic
  accuracy. Added with topic onboarding 2026-06-13.

- **Topic classification source filtering**: discover/weekly queries join
  `event_topics` without filtering `source`, so any classification counts
  (`llm`/`embedding` in prod; transient `test` rows only in test DBs). If we
  ever want "LLM-classified events only" to count, add an explicit
  `source = 'llm'` filter. Currently intentional (any classification counts).

## Blocked on credentials/ops

- **Verification staging smoke** (`verification-production-checklist.md`):
  Tier 2/3 flows against Stripe test mode + SMS gateway staging config.
