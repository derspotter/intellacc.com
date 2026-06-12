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
