# Paged encrypted chat history

Both chat views previously loaded every encrypted record in a conversation and
decrypted the entire history on each relay hint. They now open the newest 50
records and offer **Load older messages** in pages of 50. Loading older history
preserves the scroll offset relative to the existing content.

## Storage and updates

- IndexedDB version 12 adds device/group/order and device/group/message-ID
  indexes. The upgrade backfills sortable timestamps and normalized message
  IDs without decrypting messages. Equal timestamps use the local primary key
  as a stable cursor tie breaker. Existing ciphertext arrays remain readable;
  new writes use typed arrays.
- A page reads at most 51 encrypted records (one lookahead) and decrypts at
  most 50, with up to four simultaneous crypto operations. Expired or corrupt
  rows count toward the page budget; an empty page can still offer older
  history. Expired records encountered during reads are deleted from storage.
- Committed inserts notify active views to read just that message. Edits and
  tombstones refresh only a loaded row; edits outside the loaded window appear
  when that page is opened. Relay synchronization and MLS ordering are unchanged.
  Repeated hints for the same selected conversation do not reload its history.
- Incoming application IDs are marked processed after their local writes
  succeed. Session checks prevent a lock during persistence from marking an
  unstored message as processed or publishing its plaintext after locking.
- Cross-tab notifications contain only device/group/message identifiers and
  mutation type. Each unlocked tab reads and decrypts its own device's record.
  Sender ownership checks on edit/delete remain in place.
- A view retains only its selected, explicitly loaded pages plus new messages.
  Locking, device changes, conversation changes and disposal clear that window.
  Key/device/session checks reject late decrypts; selection changes also stop
  further page decrypts after already-running crypto operations finish.
- Expiration timers remove visible plaintext when its TTL passes, even without
  a new socket hint. Ciphertext cleanup remains lazy on subsequent reads.
  Optimistic sends are reconciled with the persisted relay ID in both skins.

## Verification

The Chromium regression fixture uses real IndexedDB and AES-GCM, with mocked
relay/API calls. It rejects unbounded `encrypted_messages` index `getAll`
calls and counts actual decrypt operations. A 125-message v11 history opens
with exactly 50 decrypts; a new message adds one decrypt. All three pages
preserve equal-timestamp ordering and exclude another device and group.

Fourteen browser regressions cover migration, concurrent page clicks, targeted edits
and deletions, offscreen edits, expiration, corrupt records, sender checks,
lock/unlock/switch/unmount races, both chat skins, optimistic sends, commits
during paging, device changes, empty expired pages, identifier-only cross-tab
notifications, and recovery when an old tab blocks the database upgrade.
Consecutive sends are tested with history decrypts delayed. Receive-ordering
tests cover locking before persistence and during AES-GCM persistence. The
latter uses two real OpenMLS clients, persisted granular state, vault locking,
state restoration and successful redelivery, including the durable processed ID.
Both skin tests also pass with the production styles, including reselecting an
open conversation without another decrypt and preserving the full view scroll
anchor. The containerized production build passed with the existing bundle-size
and browser-data warnings.

Claude Code reviewed the batch using `claude-fable-5-1`, read-only tools and
the signed-in session with API keys unset. Its receive-marker race, optimistic
send delay, defensive migration-index guards and uninitialized-window findings
were addressed and the regressions rerun. Its IndexedDB rollback warning is
documented below. The crypto limit is per page, so already-running operations
from an aborted page may briefly overlap the next page. A global crypto limiter
and changing the existing initial scroll position are deferred.

These are bounded-work checks, not production latency measurements. Existing
histories still require a one-time IndexedDB index/backfill pass on upgrade.

## Rollout

Prepared in `/tmp/intellacc-chat-history-20260918` on
`codex/performance-chat-history`; not deployed. This is a frontend-only change.
Integrate with the current main branch before building and deploying, preserving
any intervening changes. No backend or PostgreSQL migration is required.

An older open tab can block IndexedDB's version upgrade. The new client reports
that the user must close other Intellacc tabs and reload. New clients close
their database connection and lock their vault on a later version change.
After the v12 upgrade, rolling back to an old bundle that explicitly opens v11
will produce an IndexedDB version error. A rollback build must retain the v12
database version and compatible schema; do not delete users' local history.
