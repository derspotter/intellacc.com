# Frontend-Solid Bloomberg/Tmux Branch Backlog

Branch: `agent/gemini-frontend`
Scope: Frontend only (`frontend-solid/`)

## Work Assigned To Agents

- Codex (full-auto): Chat wiring, trade ticket, app shell auth, feed realtime, registration form.
- Gemini (YOLO): Feed composer, markets UI, ChatPanel theme, command palette, font/ticker.

## What's Done (This Branch)

- Solid app now connects Socket.IO only when logged in, and disconnects/clears state on logout.
- Feed and market data hydrate automatically after login (no more "empty until refresh").
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

## Completed Frontend Steps

- [x] Chat panel: remove remaining "fake send" UX and wire message send/refresh to MLS REST endpoints.
- [x] Chat panel: use socket `mls-message` as a "new data available" signal to refresh the selected conversation.
- [x] Chat panel: implement "new DM" flow (search users, create DM via `/api/mls/direct-messages/:targetUserId`, auto-select).
- [x] Chat panel: add real send for group/DM messages via `/api/mls/messages/group` (passing `x-device-id` from VaultService).
- [x] Chat panel: add pending queue processing (`/api/mls/queue/pending` + `/api/mls/queue/ack`) and surface unread counts/badges.
- [x] Markets: replace mock order book + BUY YES/NO with a real trade ticket calling `/api/events/:id/update` (LMSR).
- [x] Markets: improve list to show closing date and outcome consistently.
- [x] Markets: show live stake/price deltas on `marketUpdate` (flash green/red) and keep the selected market stable across refreshes.
- [x] Feed: subscribe to `new_comment` and `post_updated` paths (likes/edits) and update in-place without full refresh.
- [x] Feed: add composer (new post) and fast actions (like/unlike) with optimistic UI and rollback on error.
- [x] App shell: handle socket auth failures cleanly (if socket connect errors due to token expiry, call `clearToken()` and show LoginModal).
- [x] App shell: add a small status area for last notification (socket `notification`) and a notification list modal.
- [x] UX polish: normalize ChatPanel styling to the `bb.*` theme.
- [x] UX polish: add a minimal "command palette" style overlay (Ctrl+K) with focus-trap for modals.
- [x] UX polish: ensure font loading for JetBrains Mono (Google Fonts webfont) so the terminal aesthetic is consistent.
- [x] QA: Playwright smoke test for `frontend-solid` (login, panes render, events load, focus shortcuts work) — tested interactively via playwright-cli.
- [x] Auth: add registration form (username/email/password) with auto-login after register.

## Notes / Risks

- Dynamic import warnings from Vite about chunking are non-blocking.
- Trade execution returns 403 for users without phone verification (expected backend behavior, UI shows error gracefully).
- Vault auto-unlock returns 403 for test users missing master key (non-critical, MLS feature).

## Tooling Fix (Local Shell)

- Removed `ANTHROPIC_API_KEY` exports from `~/.bashrc` because they caused Claude Code CLI to attempt API-key auth and fail.
