# Feature Roadmap

Updated: 2026-06-12. This is the forward plan; `unified-backlog.md` is the
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

Remaining group polish (not blocking):
- Leave group (MLS self-remove proposal exists in WASM; needs commit flow + UI)
- Message-request UI for invites from non-followed users (staged-welcome
  inspection API exists)

## Now: Persuasive Alpha visibility

The reward pipeline is live but invisible (and has had zero real traffic).
Surface it so it gets used:

- "Your post moved this market" attribution on posts (data exists in
  `post_signal_episodes` / `post_signal_reward_payouts`).
- Pending/earned rewards in the analytics dashboard (extend
  `predictionAnalyticsController`).
- Optional: notification on first payout.

## Later (unordered)

- **Offline + background sync (PWA)**: offline app shell, queued actions,
  background sync. Currently push-only.
- **Social graph UX**: follower/following pages, user discovery,
  repost surfacing.
- **Social groups/communities**: public topic/market groups with
  membership and moderation. Needs product design first.
- **Agent CLI**: see `agent-cli-plan.md` (unexecuted plan).
- **Nightly E2E job**: scheduled run of the messaging spec with test-user
  cleanup; deferred in favor of feature work.

## Blocked on credentials/ops

- **Verification staging smoke** (`verification-production-checklist.md`):
  Tier 2/3 flows against Stripe test mode + SMS gateway staging config.
