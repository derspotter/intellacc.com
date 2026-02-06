# Frontend-Solid Bloomberg/Tmux Branch Backlog

Branch: `agent/gemini-frontend`
Scope: Frontend only (`frontend-solid/`)

## Work Assigned To Agents

- Claude (YOLO): Auth-driven socket lifecycle + store hydration + realtime wiring.
- Gemini (YOLO): Bloomberg/tmux UX polish: pane focus + keyboard nav + help overlay + ticker loop + theme cleanup.

## What’s Done (This Branch)

- Solid app now connects Socket.IO only when logged in, and disconnects/clears state on logout.
- Feed and market data hydrate automatically after login (no more “empty until refresh”).
- Socket wiring matches backend events: `new_post` updates the feed.
- Socket wiring matches backend events: `post_updated` updates existing posts.
- Socket wiring matches backend events: `marketUpdate` updates event `market_prob` and `cumulative_stake`.
- Socket wiring matches backend events: room joins on connect (`join-predictions`, `authenticate`, `join-mls`).
- `ThreePaneLayout` no longer registers global mouse listeners on every render; drag is pointer-based and cleans up correctly.
- Keyboard navigation: `1`/`2`/`3` focuses panes.
- Keyboard navigation: `?` toggles a shortcuts overlay.
- Keyboard navigation: active pane gets a focus border.
- Markets panel now uses `/api/events` (events as markets) and displays `market_prob` as % with live `marketUpdate` integration.
- Build verified: `npm -C frontend-solid run build` passes.

## Notes / Risks

- Chat sending is intentionally not wired yet (backend does not handle `chat:message`; MLS endpoints need proper integration).
- Dynamic import warnings from Vite about chunking are non-blocking.

## Next Frontend Steps

- Chat panel: remove remaining “fake send” UX and wire message send/refresh to MLS REST endpoints.
- Chat panel: use socket `mls-message` as a “new data available” signal to refresh the selected conversation.
- Chat panel: implement “new DM” flow (search users, create DM via `/api/mls/direct-messages/:targetUserId`, auto-select).
- Chat panel: add real send for group/DM messages via `/api/mls/messages/group` and `/api/mls/messages/welcome` where applicable (will require passing `x-device-id` from VaultService).
- Chat panel: add pending queue processing (`/api/mls/queue/pending` + `/api/mls/queue/ack`) and surface unread counts/badges.
- Markets: replace mock order book + BUY YES/NO with a real trade ticket calling existing REST endpoints.
- Markets: improve list to show closing date and outcome consistently.
- Markets: show live stake/price deltas on `marketUpdate` (flash green/red) and keep the selected market stable across refreshes.
- Feed: subscribe to `new_comment` and `post_updated` paths (likes/edits) and update in-place without full refresh.
- Feed: add composer (new post) and fast actions (like/unlike) with optimistic UI and rollback on error.
- App shell: handle socket auth failures cleanly (if socket connect errors due to token expiry, call `clearToken()` and show LoginModal).
- App shell: add a small status area for last notification (socket `notification`) and a notification list modal.
- UX polish: normalize ChatPanel styling to the `bb.*` theme (some hardcoded colors remain).
- UX polish: add a minimal “command palette” style overlay (optional) and focus-trap for modal.
- UX polish: ensure font loading for JetBrains Mono (add webfont or self-host) so the terminal aesthetic is consistent.
- QA: add a Playwright smoke script for `frontend-solid` (login, panes render, events load, focus shortcuts work).

## Tooling Fix (Local Shell)

- Removed `ANTHROPIC_API_KEY` exports from `~/.bashrc` because they caused Claude Code CLI to attempt API-key auth and fail.
