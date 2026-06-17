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
## Done 2026-06-14: Social graph UX (all 3 parts)

Shipped the full social-graph UX, decomposed into 3 independent sub-projects:
- **Part 1 — #network exploration controls**: max-nodes, hide-isolates,
  largest-cluster-only, search-to-focus, reset, live stats; client-side via
  `lib/graphFilters.js` (`graphFilters.test.mjs`, `network-controls.spec.js`).
- **Part 2 — actionable follower/following lists**: the profile Network card's
  rows now show accuracy + follower metadata and a viewer-relative
  Follow/Unfollow button (`getFollowers`/`getFollowing` enriched with
  `followers`, `accuracy_percent`, `is_following`; new `NetworkUserRow`;
  `followers_enriched.test.js`, `followers-rows.spec.js`).
- **Part 3 — repost surfacing**: feed posts expose `repost_count` +
  `reposted_by_user`; PostItem shows the count and an optimistic, viewer-aware
  Repost/Reposted button (no more confirm()/alert()). `repost_surfacing.test.js`
  + harness baseline covering Repost / Reposted / Repost(N).

The discovery centerpiece shipped 2026-06-12: a 3D follow-network page
(#network) with WebGL force graph (repurposed from the DT project), node size =
followers, color = forecasting accuracy, click-to-follow.

Follow-ups deferred: un-repost (toggle off), Twitter-style "X reposted" header
(vs the current quote card), dedicated #followers/#following routes.

## Done 2026-06-16: Feed Mix (configurable feed ranking)

Shipped: a per-user home-feed ranking mixer. Four lock-able van-skin vertical
sliders (accuracy / followers / likes / views) in Settings, always summing to
100 (`lib/feedRanking.js` `redistribute` — proportional rebalance + largest-
remainder rounding). The home feed (`HomePage`) reorders client-side via
`rankPosts` (log1p + min–max normalize + weighted score) from saved weights;
opt-in (no saved weights ⇒ chronological). Backend: `user_feed_weights` table +
`GET/PUT /users/me/feed-weights`; feed payload gained `author_accuracy`,
`author_followers`, `view_count`. Specs/plan in `docs/superpowers/{specs,plans}/
2026-06-16-feed-mix*`. Built subagent-driven; a final review caught that `#home`
is `HomePage` (not `SearchPage`) so the ranking was rewired before merge.
Deferred: rank-appended-page-only (avoid the "Load more" re-sort), discover-feed
weighting, persisting lock states.
## Done 2026-06-17: Community Groups — core (sub-project A)

Shipped the foundation of community groups: a **group** is a user-created narrow
theme (name + description) under one of the 10 parent topics, public, distinct
from MLS chat groups. Tier≥2 (phone/payment-verified) users create them (creator
= owner + first member); anyone browses (sortable list + topic-filter tabs at
`#groups`) and joins/leaves; the group page (`#group/:slug`) shows the header +
a Feed/Chat/Markets tab scaffold (Feed empty placeholder; Chat/Markets disabled).
New `community_groups`/`community_group_members` tables, `communityGroupsController`
(`/api/groups*`, soft-delete by owner/admin), a new read-only `optionalAuth`
middleware, van-skin pages + create form (403-gated + soft dup warning). Specs/plan
in `docs/superpowers/{specs,plans}/2026-06-17-community-groups*`. Built
subagent-driven; final review APPROVED (no critical/important issues).

**All sub-projects shipped 2026-06-17** (each spec→plan→subagent-build→CI-green,
final whole-feature review APPROVED):
- **B — group feed:** `posts.community_group_id`; members post into a group; the
  Feed tab reuses `PostItem`/`CreatePostForm`.
- **C — public group chat:** `community_group_messages`; REST send + Socket.io
  room `group-chat:<id>` broadcast (plaintext, not MLS); realtime Chat tab.
- **D — pinned markets:** `community_group_markets`; owner pins/unpins events via
  search; Markets tab lists them linking to `#predictions/:id`.
- **E — moderation:** report a group (→ `moderation_reports` type 'group', new
  relaxing migration), owner/admin remove a group post + kick members, Members
  tab. Group page is now Feed / Chat / Markets / Members.

Deferred (follow-ups): editing a group, ownership transfer, hard dup-blocking,
rate limits beyond tier-2; admin (not just owner) seeing the remove/kick controls
in the UI (backend already authorizes admins); soft-hide (`posts.is_hidden`)
instead of hard-delete for removed group posts; report individual posts/messages
(v1 reports the whole group); message scrollback/pagination in chat.

- **Nightly E2E job**: scheduled run of the messaging spec with test-user
  cleanup; deferred in favor of feature work.

- **Component-isolation visual harness (v1 shipped 2026-06-14)**: dev-only
  `#__harness` route renders PostItem with fixed fixtures; baseline in
  `tests/e2e/visual-harness.spec.js`. Closes the feed-component coverage gap the
  7 page-level baselines couldn't (deterministic, no masking). Stripped from prod
  via `import.meta.env.DEV` (verified by grepping the prod `dist/`). Follow-up:
  extend to store-driven components (MarketPanel, RPBalance) with a data-mock
  layer if the gap still hurts.

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
