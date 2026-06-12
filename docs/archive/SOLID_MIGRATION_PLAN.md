# SolidJS + Tmux/Bloomberg Migration Plan

This document outlines the operational plan to migrate Intellacc's frontend to SolidJS (`frontend-solid`) with a specific "Tmux meets Bloomberg Terminal" aesthetic.

**Status: COMPLETE** — All 5 phases implemented on branch `agent/gemini-frontend`.

## Design Philosophy
- **Aesthetic**: High-contrast, dark mode, monospace-first. Visually mimics a terminal multiplexer (tmux) combined with the data density of a financial terminal.
- **Layout**: Strictly 3 parallel panes (columns) on desktop:
    1.  **Feed Pane**: Social activity (Left).
    2.  **Market Pane**: Data & Predictions (Center).
    3.  **Messaging Pane**: E2EE Comms (Right).
- **Interaction**: Keyboard-centric navigation, sharp focus states, minimal "app-like" chrome.

## Core Strategy: Side-by-Side Development
We built `frontend-solid` on port `5174` alongside the existing `frontend` (`5173`).

### 1. Infrastructure & Setup
- [x] Initialize `frontend-solid` (Vite + SolidJS).
- [x] **Tailwind Config**: Colors (`bb-bg`, `bb-panel`, `bb-accent`, `bb-border`, `bb-muted`, `market-up`, `market-down`), Fonts (JetBrains Mono).
- [x] **Vite Proxy**: Route `/api` and `/socket.io` to `backend:3000`.
- [x] **Docker**: `frontend-solid/docker-compose.yml` with dedicated container on port 5174.

### 2. The "Pane" System (Architecture)
Implemented as `ThreePaneLayout` with resizable dividers (pointer-based drag).
```jsx
<ThreePaneLayout
  activePane={activePane()}
  left={<FeedPanel />}
  center={<MarketPanel />}
  right={<ChatPanel />}
/>
```
- **Panel Component**: Renders tmux-like header with title, content area with custom scrollbar, keyboard focus border.

### 3. Implementation Phases

#### Phase 1: Skeleton & Styling — COMPLETE
- [x] `Panel.jsx` with header/status bar.
- [x] `ThreePaneLayout.jsx` with 3-column resizable grid.
- [x] Global CSS (reset, custom scrollbars, monospace fonts, JetBrains Mono webfont).

#### Phase 2: Feed Pane (Left) — COMPLETE
- [x] `feedStore.js` with createPost, likePost, unlikePost, addComment.
- [x] `PostItem` component with like/unlike buttons and optimistic UI.
- [x] `PostComposer` component for new posts (Enter to submit).
- [x] Socket.IO: `new_post`, `post_updated`, `new_comment` realtime updates.

#### Phase 3: Market Pane (Center) — COMPLETE
- [x] `marketStore.js` with prev_market_prob tracking for flash direction.
- [x] `MarketTicker` with flash green/red animations on price changes.
- [x] `MarketList` with ID, event name, probability, close date, outcome badges.
- [x] `MarketDetail` with real `TradeTicket` (BUY YES/NO, stake input, estimated cost, PLACE TRADE via LMSR API).

#### Phase 4: Messaging Pane (Right) - E2EE — COMPLETE
- [x] `openmls-wasm` and `coreCryptoClient.js` integrated via Vite WASM plugin.
- [x] `ChatPanel` with conversation list, message display, real send via `/api/mls/messages/group`.
- [x] New DM flow: debounced user search, create DM, auto-select conversation.
- [x] Pending queue processing delegated to `coreCryptoClient.syncMessages()`.
- [x] Unread count badges per conversation.
- [x] Vault unlock prompt for E2EE key management.
- [x] MLS services ported from master: `api.js`, `coreCryptoClient.js`, `vaultService.js`, `deviceIdStore.js`, `tokenService.js`, `idleLock.js` (all framework-agnostic).
- [x] SolidJS `messagingStore.js` — full port of VanJS reactive store using `createStore`/`createMemo`/`createRoot`/`batch`.
- [x] Sender name resolution: numeric `senderId` mapped to display username via `getSenderName()` helper.
- [x] Bidirectional E2EE verified: messages encrypt/decrypt correctly in both directions.

#### Phase 5: Auth & Interactive Features — COMPLETE
- [x] Login screen: staged email → password flow with terminal aesthetic.
- [x] Registration screen: username/email/password with auto-login after register.
- [x] Post creation with optimistic UI and rollback on error.
- [x] Trade execution via LMSR (`/api/events/:id/update`).
- [x] Message sending with `x-device-id` header from VaultService.
- [x] Keyboard shortcuts: `1`/`2`/`3` (pane focus), `?` (help), `Ctrl+K` (command palette), `ESC` (close/unfocus).
- [x] Command palette with action search and focus-trap.
- [x] Notification status area + notification history modal.
- [x] Socket auth failure handling (clearToken on 401).

### 4. Technical Stack
- **Framework**: SolidJS (Signals/Store).
- **Styling**: Tailwind CSS + `clsx` + `tailwind-merge`.
- **State**: `solid-js/store` + custom signal-based stores.
- **Build**: Vite + `vite-plugin-solid` + `vite-plugin-wasm` + `vite-plugin-top-level-await`.
- **Realtime**: Socket.IO client with pub/sub for MLS events.
- **E2EE**: OpenMLS WASM with vault-based key management.

### 5. Responsive Layout — COMPLETE
- [x] Mobile (`< 768px`): Single pane with bottom tab bar for pane switching.
- [x] Tablet (`768–1024px`): Two-pane layout.
- [x] Desktop (`>= 1024px`): Three resizable panes with drag dividers.

## Next Steps
All migration phases and responsive layout are complete. Potential future work:
1. Deeper MLS group management (add/remove members, group settings).
2. Prediction history charts and user accuracy tracking in Market pane.
3. Replace the old VanJS frontend (`frontend/` on port 5173) with this SolidJS version.
