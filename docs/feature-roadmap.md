# Feature Roadmap

Updated: 2026-06-12. This is the forward plan; `unified-backlog.md` is the
status ledger of what already shipped. Completed plan documents live in
`docs/archive/`.

## Now: Group chats (messaging)

The MLS backend already supports multi-member groups end to end
(`mls_groups`, group creation, key-package fanout, relay recipients); only
1:1 DMs are exposed in the Solid UI. All 2026-06-12 messaging UX features
(edit/delete, read receipts, disappearing messages) are in-group control
messages and work in groups without changes.

Implementation slices:

1. **Create group + invite flow (client/UI)**
   - "New group" form in MessagesPage: name + member user ids.
   - `coreCryptoClient.createGroup(name)` exists; extend the flow to fetch
     each member's key packages, add members, and send welcomes (the
     building blocks exist for DMs in `startDirectMessage`; generalize).
   - Conversation list shows groups (`getUserGroups` API exists) alongside
     DMs with member count.
2. **Group conversation view**
   - Sender display for multiple participants (usernames, not just
     `User <id>`; needs a member-list endpoint or resolution via existing
     user lookup).
   - Member list panel; show join state (invited vs joined via welcome ack).
3. **Membership management**
   - Add member to existing group (MLS add + welcome; relay roster updates
     via the welcome-ack path only — direct roster mutation endpoints are
     intentionally disabled).
   - Leave group (MLS self-remove commit + UI).
4. **Welcome handling for groups**
   - The follow-gated auto-accept applies per sender; group invites from
     non-followed users land as message requests — surface them in the UI
     (the staged-welcome inspection API exists).
5. **E2E coverage**
   - Extend `tests/e2e/solid-messaging.spec.js` (or add
     `solid-group-messaging.spec.js`): three users, create group, both
     members receive + reply, edit/delete/receipts in group context.

## Next: Persuasive Alpha visibility

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
