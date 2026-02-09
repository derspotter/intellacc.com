# Federation Layer Roadmap (ActivityPub + AT Protocol)

This document is a practical plan for making Intellacc interoperable with:

- Mastodon / Fediverse via ActivityPub (native federation)
- Bluesky via AT Protocol (native long-term), with an optional bridge path via Bridgy Fed

The goal is to keep Intellacc as the source of truth while adding a translation + delivery layer
that exports/imports social graph + posts.

## Definitions (Avoiding Ambiguity)

- "Syndication": cross-posting to a user's existing external account (easy, not true federation).
- "Native ActivityPub": Intellacc itself is an ActivityPub server. Fediverse users can follow
  `@alice@intellacc.com` and receive posts without Alice having an account elsewhere.
- "Native ATProto": Intellacc operates (or tightly integrates with) a PDS so that Intellacc users
  are first-class AT identities (DID + repo) and their posts show up in Bluesky clients.

## Non-Goals (At Least Initially)

- Federated E2EE DMs: ActivityPub DMs are not E2EE; ATProto DMs are separate and evolving. Intellacc
  MLS messaging remains internal-only.
- Federating prediction-market transactions (buy/sell, shares, etc) as machine-readable actions in
  other networks. Instead: publish canonical links + rich previews.

## Architectural Principles

- Keep core tables (`users`, `posts`, etc) unchanged as much as possible.
- Use an "outbox queue" (DB-backed) so federation delivery is async, retriable, and observable.
- Make all federation handlers idempotent.
- Treat all remote input as hostile (signature verification, SSRF protections, size limits).
- Keep protocol-specific code behind adapters:
  - `activitypub/*`
  - `atproto/*`

## Data Model Additions (DB Migrations)

Add a dedicated schema prefix (recommended) or tables with a clear prefix. Example tables:

- `federation_identities`
  - local `user_id`
  - `ap_actor_uri`, `ap_key_id`, key material reference
  - `at_did`, `at_handle`, PDS base URL
- `ap_remote_actors`
  - `actor_uri` (PK), inbox/sharedInbox, publicKey, fetched_at, etag, last_seen
- `ap_followers`
  - local `user_id`, remote `actor_uri`, state (pending/accepted/blocked), created_at
- `ap_object_map`
  - local `post_id`, `ap_object_uri`, `ap_activity_uri`
- `federation_delivery_queue`
  - protocol (ap/at), payload JSON, target URL, attempt_count, next_attempt_at, last_error
- `federation_inbox_dedupe`
  - protocol, remote activity/object ID, received_at (for replay/idempotency)

## Phase 0: Public Canonical URLs + Rich Previews (Shared Foundation)

Both ecosystems benefit from stable public URLs and good unfurls.

1. Public read endpoints/pages:
   - User profile page: `GET /u/:username`
   - Post page: `GET /p/:id`
   - Market/event page: `GET /events/:id` (or equivalent)
2. Add OpenGraph tags for those pages:
   - Title, description, image
   - For market/event: current probability + close time in description
3. Ensure these pages are safe to serve without auth:
   - Do not expose private metadata or internal IDs beyond what is intended public.

Deliverable: external posts can link to Intellacc and get rich cards on Mastodon/Bluesky.

## Phase 1: ActivityPub MVP (Native Fediverse Interop)

### 1A. Discovery and Identity

Implement root-level (NOT `/api`) endpoints in `backend/src/index.js`:

- `GET /.well-known/webfinger`
  - supports `resource=acct:username@intellacc.com`
  - returns JRD `application/jrd+json` with `rel=self` pointing at actor JSON

- `GET /ap/users/:username`
  - returns ActivityStreams actor JSON (`application/activity+json`)
  - includes `id`, `inbox`, `outbox`, `followers`, `preferredUsername`, and `publicKey`

### 1B. Inbox (Receiving Follows)

- `POST /ap/users/:username/inbox`
  - verify HTTP signatures
  - handle `Follow` -> store follower and send `Accept`
  - store inbound IDs in `federation_inbox_dedupe` to make retries idempotent

### 1C. Outbox (Serving and Delivering Posts)

- `GET /ap/users/:username/outbox`
  - ordered collection of activities (`Create` with embedded `Note`)
  - only federate public top-level posts initially (skip comments until Phase 2)

On local post creation (`backend/src/controllers/postController.js`):

- Convert the post to ActivityPub `Note`
- Wrap in a `Create` activity
- Enqueue deliveries to follower inboxes in `federation_delivery_queue`
- Background worker sends signed POSTs and retries with backoff

### 1D. Key Management

Options:

1. Per-user keys (best user isolation, more ops)
2. Per-server key (simpler, less isolation)

For MVP: per-server key is acceptable; migrate to per-user later if needed.

### 1E. Security Hardening Checklist (MVP)

- Signature verification on inbox for all mutating activities
- SSRF defenses when fetching remote actor JSON:
  - allow only http/https
  - block private IP ranges
  - timeouts + max response size
- Rate limit inbox endpoints by IP + actor
- Strict JSON parsing limits
- Log all deliveries and inbound activities with correlation IDs

Deliverable: Mastodon users can follow Intellacc users and see their posts.

## Phase 2: ActivityPub "Social Parity" (Replies, Mentions, Reactions)

1. Remote replies -> import as local comments:
   - map `inReplyTo` to a local post/comment via `ap_object_map`
2. Mentions:
   - parse `@user@domain` and resolve via WebFinger for outbound mention addressing (optional)
3. Likes/boosts:
   - optionally map Announce/Like to local counters (non-critical)

Deliverable: meaningful two-way conversation between Mastodon and Intellacc.

## Phase 3: Bluesky Reach (Bridge Path, Fast)

If we ship ActivityPub first, Bridgy Fed can bridge Intellacc users into Bluesky without us running
any AT infrastructure.

Implementation:

- Add "Enable Bluesky via Bridgy" UI.
- From the user's ActivityPub actor, send a `Follow` to the Bridgy Fed bot account.
- Auto-accept follow-backs.

Constraints to communicate:

- Only public posts bridge.
- Bridging may delay or throttle.
- Not all interactions map 1:1.

Deliverable: Bluesky users can follow Intellacc users (bridged identity) and see posts.

## Phase 4: ATProto (Native, Long-Term)

### 4A. Stage 1 (Optional): ATProto Client Posting

If we want immediate native-looking posts on Bluesky while we build a PDS:

- "Connect Bluesky account" (OAuth/app-password/session)
- On local post creation, write `app.bsky.feed.post` with an external embed pointing back to
  the canonical Intellacc URL.

This is syndication, but it is low-cost and buys time.

### 4B. Stage 2: Operate a PDS for Intellacc Users (Native ATProto)

Do not implement a PDS from scratch. Instead:

1. Run the official/open PDS in Docker (new compose service).
2. For each Intellacc user who opts in:
   - provision DID + handle
   - create/host their repo on the PDS
3. Mirror Intellacc posts into the user's AT repo:
   - write standard `app.bsky.feed.post` records
   - use embeds that link to Intellacc for market-specific UI

Critical engineering constraints:

- Repo writes must be idempotent (store record URI/CID mapping in DB).
- Backfill for existing posts should be batched and rate limited.
- Auth should follow ATProto OAuth profile (DPoP) where possible; avoid long-lived tokens.

### 4C. Stage 3: Incoming ATProto Interactions (Optional)

If we want two-way interop on ATProto:

- ingest replies, likes, and follows from AT stream (requires more integration with relays/AppView)
- map them into local comments/likes/follows

Deliverable: Intellacc users exist as first-class AT identities, not just bridged or cross-posted.

## Testing Plan (Must-Haves)

- Unit tests: ActivityPub JSON generation for Actor/Note/Create; signature sign/verify; id mapping.
- Integration tests (docker):
  - fake ActivityPub inbox server to assert deliveries and signature headers
  - inbound Follow -> Accept flow
  - retry/backoff behavior
- E2E smoke:
  - follow Intellacc user from a test Mastodon instance (manual or scripted)

## Deployment/Operations

- Federation endpoints require stable HTTPS + correct hostnames.
- Use a separate worker process (same container initially) for delivery queue.
- Add metrics:
  - delivery success rate, retry count, remote failure codes, queue depth
- Add moderation hooks:
  - allow blocking remote actors/instances

## Recommended Execution Order

1. Phase 0 (public URLs + OG)
2. Phase 1 (ActivityPub MVP)
3. Phase 3 (Bridgy enable flow)
4. Phase 2 (replies/mentions)
5. Phase 4 (native ATProto/PDS)

## References (Docs to Re-check Before Implementing)

- ActivityPub spec (W3C): https://www.w3.org/TR/activitypub/
- Mastodon WebFinger: https://docs.joinmastodon.org/spec/webfinger/
- Bridgy Fed docs: https://fed.brid.gy/docs
- ATProto DID: https://atproto.com/specs/did
- ATProto handles: https://atproto.com/specs/handle
- ATProto OAuth: https://atproto.com/specs/oauth
- ATProto repository format: https://atproto.com/specs/repository

