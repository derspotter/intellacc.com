# SolidJS + Bloomberg Theme Implementation Plan

This plan outlines the migration of the Intellacc frontend from VanJS to SolidJS, implementing a high-performance "Bloomberg Terminal" aesthetic.

## 1. Project Setup

We will create a new directory `frontend-solid` to build in parallel with the existing frontend.

### 1.1 Initialization
```bash
# Create project
npm create vite@latest frontend-solid -- --template solid
cd frontend-solid
npm install

# Install Core Dependencies
npm install @solidjs/router solid-transition-group clsx tailwind-merge
npm install socket.io-client @simplewebauthn/browser
npm install -D tailwindcss postcss autoprefixer
npm install -D vite-plugin-wasm vite-plugin-top-level-await
```

### 1.2 Tailwind Configuration (`tailwind.config.js`)
Implements the Bloomberg terminal aesthetic: dark high-contrast mode with specific data colors.

```javascript
/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./src/**/*.{js,jsx,ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        // Bloomberg Core
        bb: {
          bg: '#000000',
          panel: '#111111',
          border: '#333333',
          text: '#E0E0E0',
          muted: '#888888',
          accent: '#FF9800', // Amber for highlights
        },
        // Data Colors
        market: {
          up: '#00FF41',    // Terminal Green
          down: '#FF3D00',  // Terminal Red/Orange
          neutral: '#00E5FF', // Cyan
        }
      },
      fontFamily: {
        mono: ['"JetBrains Mono"', 'monospace'], // For data/numbers
        sans: ['Inter', 'sans-serif'],          // For UI text
      },
      fontSize: {
        'xxs': '0.65rem',
      },
      boxShadow: {
        'glow-green': '0 0 5px rgba(0, 255, 65, 0.5)',
        'glow-red': '0 0 5px rgba(255, 61, 0, 0.5)',
      }
    },
  },
  plugins: [],
}
```

### 1.3 Vite Configuration (`vite.config.js`)
Must support WASM for OpenMLS.

```javascript
import { defineConfig } from 'vite';
import solidPlugin from 'vite-plugin-solid';
import wasm from 'vite-plugin-wasm';
import topLevelAwait from 'vite-plugin-top-level-await';
import path from 'path';

export default defineConfig({
  plugins: [
    solidPlugin(),
    wasm(),
    topLevelAwait()
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@openmls': path.resolve(__dirname, '../openmls-wasm/pkg')
    }
  },
  server: {
    port: 5174, // Run parallel to existing frontend (5173)
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true
      },
      '/socket.io': {
        target: 'http://localhost:3000',
        ws: true
      }
    }
  }
});
```

## 2. Core Architecture

### 2.1 State Management Pattern
We will use Solid's `createStore` for complex state (like messaging) and `createSignal` for atomic UI state.

**Directory Structure:**
```
src/
  store/
    index.js          # Root store (auth, etc)
    messaging.js      # Port of messagingStore.js
    market.js         # Real-time market data
  services/
    socket.js         # Socket.io integration
    api.js            # REST API wrapper
    mls/              # OpenMLS integration
```

### 2.2 Socket Integration (`src/services/socket.js`)
Wrap the existing socket logic in a Solid store to make it reactive.

```javascript
import { createStore } from "solid-js/store";
import io from "socket.io-client";

const [state, setState] = createStore({
  connected: false,
  messages: [],
  lastMarketUpdate: null
});

let socket;

export const useSocket = () => {
  const connect = (token) => {
    socket = io(window.location.origin, {
      path: '/socket.io',
      auth: { token }
    });

    socket.on('connect', () => setState('connected', true));
    socket.on('disconnect', () => setState('connected', false));
    
    socket.on('marketUpdate', (data) => {
      setState('lastMarketUpdate', data);
      // Dispatch to market store
    });
  };

  return { state, connect, socket };
};
```

## 3. Component Library (Bloomberg Theme)

### 3.1 Base Panel (`src/components/ui/Panel.jsx`)
The fundamental building block. Fixed corners, high contrast borders.

```jsx
import { mergeProps } from "solid-js";
import { clsx } from "clsx";

export const Panel = (props) => {
  const merged = mergeProps({ class: "" }, props);
  
  return (
    <div class={clsx(
      "bg-bb-panel border border-bb-border relative flex flex-col overflow-hidden",
      merged.class
    )}>
      {/* Header Bar */}
      {props.title && (
        <div class="bg-bb-border/50 px-2 py-1 text-xs font-mono text-bb-accent uppercase border-b border-bb-border flex justify-between items-center select-none">
          <span>{props.title}</span>
          {props.headerActions}
        </div>
      )}
      <div class="flex-1 overflow-auto custom-scrollbar p-1">
        {props.children}
      </div>
    </div>
  );
};
```

### 3.2 Data Grid (`src/components/ui/DataGrid.jsx`)
For market data tables.

```jsx
import { For } from "solid-js";

export const DataGrid = (props) => {
  return (
    <table class="w-full text-xs font-mono">
      <thead class="text-bb-muted sticky top-0 bg-bb-panel z-10">
        <tr>
          <For each={props.columns}>
            {(col) => <th class="text-left px-2 py-1 border-b border-bb-border">{col.header}</th>}
          </For>
        </tr>
      </thead>
      <tbody>
        <For each={props.data}>
          {(row) => (
            <tr class="hover:bg-white/5 cursor-pointer">
              <For each={props.columns}>
                {(col) => (
                  <td class={clsx("px-2 py-1 border-b border-bb-border/30", col.class)}>
                    {col.render ? col.render(row) : row[col.key]}
                  </td>
                )}
              </For>
            </tr>
          )}
        </For>
      </tbody>
    </table>
  );
};
```

## 4. Key Features

### 4.1 Layout Shell (`src/App.jsx`)
A dense, 3-column layout typical of financial terminals.

```jsx
import { Panel } from "./components/ui/Panel";
import { Sidebar } from "./components/Sidebar";
import { MarketFeed } from "./components/MarketFeed";
import { ChatPanel } from "./components/ChatPanel";

function App() {
  return (
    <div class="h-screen w-screen bg-bb-bg text-bb-text font-sans overflow-hidden flex flex-col">
      {/* Top Bar */}
      <header class="h-8 border-b border-bb-border flex items-center px-2 bg-bb-panel">
        <span class="text-bb-accent font-mono font-bold">INTELLACC // TERMINAL</span>
      </header>
      
      {/* Main Grid */}
      <div class="flex-1 grid grid-cols-12 gap-px bg-bb-border">
        {/* Left: Navigation & Watchlist (2 cols) */}
        <div class="col-span-2 bg-bb-bg">
          <Sidebar />
        </div>
        
        {/* Center: Main Content / Market (6 cols) */}
        <div class="col-span-6 bg-bb-bg flex flex-col gap-px">
          <Panel title="Market Overview" class="h-1/2">
             {/* Chart/Graph Area */}
          </Panel>
          <Panel title="Order Book / Depth" class="h-1/2">
             {/* Tables */}
          </Panel>
        </div>
        
        {/* Right: Social & Chat (4 cols) */}
        <div class="col-span-4 bg-bb-bg flex flex-col gap-px">
           <ChatPanel />
        </div>
      </div>
    </div>
  );
}
```

## 5. Migration Strategy

### Phase 1: Skeleton & Auth (Days 1-2)
1.  Initialize `frontend-solid`.
2.  Implement `authStore` and Login page.
3.  Port `api.js` and `webauthn.js` services.
4.  Get a basic authenticated session running.

### Phase 2: Core Messaging (Days 3-5)
1.  Port `messagingStore.js` to Solid `createStore`. This is the biggest task.
    - *Note:* Solid's `reconcile` utility is perfect for merging deep updates from the backend, similar to the existing `upsertConversations` logic.
2.  Implement `ChatPanel` and `MessageList` components.
3.  Hook up `socket.js` to feed the store.

### Phase 3: Market Data (Days 6-8)
1.  Create `marketStore.js`.
2.  Implement `MarketFeed` and `PredictionCard` components.
3.  Integrate real-time `marketUpdate` events.

### Phase 4: OpenMLS Integration (Days 9-11)
1.  Port `mls/` services.
2.  Ensure WASM loads correctly in the Solid environment.
3.  Connect E2EE logic to the `ChatPanel`.

### Phase 5: Polish & Replace (Day 12+)
1.  Fine-tune the CSS (glow effects, strict spacing).
2.  Remove old `frontend` folder or archive it.
3.  Swap ports in `docker-compose.yml` to serve the new frontend on 5173.

## 6. Implementation Notes

- **Reactivity**: SolidJS signals are functions (`count()`), not values (`count.val`). This requires careful porting of `van.state` logic.
- **Async**: Use `<Suspense>` and `createResource` for data fetching (User profile, initial conversation list).
- **Performance**: The `DataGrid` should use `<Index>` instead of `<For>` for high-frequency market updates to avoid recreating rows when only cell data changes.
