# SolidJS + Tmux/Bloomberg Migration Plan

This document outlines the operational plan to migrate Intellacc's frontend to SolidJS (`frontend-solid`) with a specific "Tmux meets Bloomberg Terminal" aesthetic.

## Design Philosophy
- **Aesthetic**: High-contrast, dark mode, monospace-first. Visually mimics a terminal multiplexer (tmux) combined with the data density of a financial terminal.
- **Layout**: Strictly 3 parallel panes (columns) on desktop:
    1.  **Feed Pane**: Social activity (Left).
    2.  **Market Pane**: Data & Predictions (Center).
    3.  **Messaging Pane**: E2EE Comms (Right).
- **Interaction**: Keyboard-centric navigation, sharp focus states, minimal "app-like" chrome.

## Core Strategy: Side-by-Side Development
We will build `frontend-solid` on port `5174` alongside the existing `frontend` (`5173`).

### 1. Infrastructure & Setup
- [ ] Initialize `frontend-solid` (Vite + SolidJS).
- [ ] **Tailwind Config**:
    - Colors: `#000000` bg, `#1e1e1e` pane borders, `#00ff00`/`#ff9800`/`#00e5ff` for data.
    - Fonts: `JetBrains Mono` for almost everything.
- [ ] **Vite Proxy**: Route `/api` and `/socket.io` to `localhost:3000`.
- [ ] **Docker**: Add `frontend-solid` service to `docker-compose.yml` (or a dedicated override).

### 2. The "Pane" System (Architecture)
The app will be a grid of `<Pane>` components.
```jsx
// Concept
<div class="grid grid-cols-3 h-screen bg-black gap-px border-black">
  <Pane title="[1] FEED" status="LIVE"> <Feed /> </Pane>
  <Pane title="[2] MARKETS" status="ETH: $3200"> <Markets /> </Pane>
  <Pane title="[3] COMMS" status="ENCRYPTED"> <Messaging /> </Pane>
</div>
```
- **Pane Component**: Renders a standard tmux-like header (status bar), content area with custom scrollbar, and keyboard shortcuts context.

### 3. Implementation Phases

#### Phase 1: Skeleton & Styling
- **Goal**: Rendering the 3-pane layout with mock data in the "Tmux" style.
- **Tasks**:
    - Implement `Pane.jsx` with header/status bar.
    - Set up the 3-column grid.
    - Apply global CSS (reset, custom scrollbars, monospace fonts).

#### Phase 2: Feed Pane (Left)
- **Goal**: Read-only social feed.
- **Tasks**:
    - `feedStore.js` (Solid).
    - `PostItem` component (minimalist, text-heavy).
    - Connect to `socket.io` for real-time post updates.

#### Phase 3: Market Pane (Center)
- **Goal**: Real-time market data visualization.
- **Tasks**:
    - `marketStore.js`.
    - `MarketTicker` (scrolling top bar).
    - `OrderBook` / `ProbabilityChart` visualizers (using HTML/Canvas, no heavy chart libs if possible).

#### Phase 4: Messaging Pane (Right) - E2EE
- **Goal**: Secure chat.
- **Tasks**:
    - Port `openmls-wasm` and `coreCryptoClient.js` logic.
    - `ChatWindow` component (CLI-like message bubbles).
    - `InputPrompt` component (blinking cursor style).

#### Phase 5: Auth & Interactive Features
- **Goal**: Full functionality.
- **Tasks**:
    - Login/Register screens (Terminal style prompts).
    - Post creation / Trade execution / Message sending.
    - Keyboard shortcuts (`Ctrl+b` style?) for navigation.

### 4. Technical Stack
- **Framework**: SolidJS (Signals/Store).
- **Styling**: Tailwind CSS + `clsx`.
- **State**: `solid-js/store`.
- **Build**: Vite + `vite-plugin-wasm`.

## Next Steps
1. Create the `frontend-solid` project structure.
2. Implement the `tailwind.config.js` with the specific palette.
3. Build the static `Pane` layout to verify the aesthetic.
