# Intellacc Terminal — SolidJS Frontend

Bloomberg-meets-tmux terminal UI for the Intellacc prediction and social platform. Built with SolidJS on branch `agent/gemini-frontend`.

## Architecture

Three-pane layout (desktop) with responsive breakpoints:

| Pane | Content | Key Files |
|------|---------|-----------|
| Left | Social feed (posts, comments, likes) | `FeedPanel.jsx`, `feedStore.js` |
| Center | Market data & predictions (LMSR trading) | `MarketPanel.jsx`, `marketStore.js` |
| Right | E2EE messaging via OpenMLS WASM | `ChatPanel.jsx`, `messagingStore.js` |

**Responsive**: Single pane + bottom tabs on mobile (`< 768px`), two panes on tablet, three resizable panes on desktop.

## Development

Runs in Docker — do **not** run locally.

```bash
# Start (from repo root)
docker compose up -d

# View logs
docker logs -f intellacc_frontend_solid

# Restart to pick up changes (Vite HMR handles most, restart for config changes)
docker restart intellacc_frontend_solid

# Verify build
npm -C frontend-solid run build
```

**Port**: `5174` (proxies `/api` and `/socket.io` to backend on port `3000`)

## Key Services

| Service | Description |
|---------|-------------|
| `api.js` | HTTP client for all backend endpoints |
| `socket.js` | Socket.IO client for realtime events |
| `coreCryptoClient.js` | OpenMLS WASM wrapper for E2EE |
| `vaultService.js` | Encrypted keystore for MLS credentials |
| `tokenService.js` | JWT token management |
| `deviceIdStore.js` | Persistent device ID for vault trust |
| `idleLock.js` | Auto-lock vault on idle |

## Stores

| Store | Description |
|-------|-------------|
| `feedStore.js` | Posts, comments, likes with Socket.IO updates |
| `marketStore.js` | Market data, probabilities, flash animations |
| `messagingStore.js` | Conversations, MLS groups, messages (SolidJS `createStore`) |
| `vaultStore.js` | Vault lock state |

## Test Users

```
user1@example.com / password123
user2@example.com / password123
```

## Tech Stack

- **Framework**: SolidJS (Signals/Store)
- **Styling**: Tailwind CSS + JetBrains Mono
- **Build**: Vite + `vite-plugin-solid` + `vite-plugin-wasm`
- **E2EE**: OpenMLS WASM with split-key vault
- **Realtime**: Socket.IO
