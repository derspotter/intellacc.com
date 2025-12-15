# Intellacc Development Guide

## Project Overview
Intellacc is a prediction and social platform where users can:
- Create events for others to predict on
- Make predictions on events with confidence levels
- Post and comment in a social feed
- Follow other users and track prediction accuracy
- Place bets on assigned predictions
- Admin features for event management
- **LMSR Market System**: Full automated market making with real-time probability updates

## Architecture
```
┌─────────────────────────────────────────────────────────────────┐
│                    Frontend (VanJS + Vite)                      │
│   Feed, Predictions, Profile, Markets, E2EE Messages            │
│   OpenMLS WASM for client-side encryption (port 5173)           │
└─────────────────────────────────┬───────────────────────────────┘
                                  │ REST / Socket.io
┌─────────────────────────────────▼───────────────────────────────┐
│                    Backend (Express.js)                         │
│   Auth, Social Graph, MLS Message Relay, Notifications          │
│   (port 3000)                                                   │
└──────────────┬──────────────────────────────┬───────────────────┘
               │ HTTP                         │ PostgreSQL
┌──────────────▼──────────────┐    ┌──────────▼──────────────────┐
│   Prediction Engine (Rust)  │    │         Database            │
│   LMSR Market Maker         │    │   Users, Events, MLS Keys   │
│   (port 3001)               │    │   Messages, Social Graph    │
└─────────────────────────────┘    └─────────────────────────────┘
```

- **Frontend**: VanJS-based SPA with Vite dev server (port 5173)
- **Backend**: Express.js API with Socket.io for real-time features (port 3000)
- **Database**: PostgreSQL with direct SQL queries
- **Prediction Engine**: Rust-based service (port 3001) - LMSR market maker
- **E2EE**: OpenMLS WASM for end-to-end encrypted messaging
- **Reverse Proxy**: Caddy for production (ports 80/443)

**IMPORTANT**: This is a Docker-based project. All npm commands, file operations, and development must be run inside the respective Docker containers, not on the host system.

## Agent Orchestra

This project uses specialized AI agents for different domains. Invoke them with `/command-name`:

| Command | Agent | Specialty |
|---------|-------|-----------|
| `/architect` | Architect | System design, cross-cutting concerns |
| `/frontend` | Frontend | VanJS components, UI/UX, WASM integration |
| `/backend` | Backend | Express.js API, auth, Socket.io |
| `/e2ee` | E2EE | MLS encryption, OpenMLS WASM |
| `/data` | Data | PostgreSQL schema, queries, migrations |
| `/engine` | Engine | Rust LMSR market maker |
| `/test` | Test | Testing across all layers |
| `/devops` | DevOps | Docker, deployment, infrastructure |
| `/orchestrator` | Orchestrator | Multi-agent coordination guide |

### Typical Workflows

**New Feature:**
```
1. /architect  → Design the feature
2. /data       → Schema changes (if needed)
3. /backend    → API endpoints
4. /frontend   → UI components
5. /test       → Write tests
6. /devops     → Deploy
```

**E2EE Feature:**
```
1. /e2ee       → Design MLS changes
2. /backend    → Update MLS API
3. /frontend   → Update coreCryptoClient
4. /test       → Two-browser manual test
```

**Bug Fix:**
```
1. Identify layer
2. Invoke specific agent
3. /test → Verify fix
```

## Project Build Configuration
- We are not using cargo but build the @prediction-engine/ in docker

## Quick Start (Docker - Recommended)
```bash
# Create network (run once)
docker network create intellacc-network

# Start full stack including prediction engine
docker compose up -d

# Access the application
# Frontend: http://localhost:5173
# Backend API: http://localhost:3000/api
# Prediction Engine: http://localhost:3001/health
# Health check: http://localhost:3000/api/health-check

# Stop services
docker compose down
```

## Mobile Implementation (Phase 1 Complete)
- **Mobile Navigation**: Hamburger menu + slide-out sidebar + bottom nav
- **Responsive Breakpoints**: <768px (mobile), 768-1024px (tablet), >1024px (desktop)
- **Touch Targets**: All buttons/inputs minimum 44px height
- **Key Files Modified**:
  - `frontend/src/utils/deviceDetection.js` - Mobile detection utility
  - `frontend/src/components/layout/Sidebar.js` - Mobile-responsive sidebar
  - `frontend/src/components/mobile/MobileHeader.js` - Mobile header with hamburger
  - `frontend/src/components/mobile/BottomNav.js` - Bottom navigation bar
  - `frontend/src/components/layout/MainLayout.js` - Responsive layout wrapper
  - `frontend/styles.css` - Mobile styles and media queries

## Current State (Dec 15, 2025)
- **MLS E2EE Complete**: Full end-to-end encryption working with OpenMLS WASM. All legacy Signal Protocol/RSA code removed.
- **MLS Identity**: Uses `userId` (not username) for MLS identity - more stable since it's immutable and already in JWT.
- **Frontend MLS-Only**: `Messages.js` is MLS-only (no legacy mode toggle). Shows group list, create/invite UI, real-time encrypted messaging.
- **Backend MLS APIs**: Routes under `/api/mls/*` for key packages, groups, and encrypted message relay. Backend never sees plaintext.
- **Socket.io Events**: `mls-message` and `mls-welcome` events for real-time E2EE message delivery.
- **Agent Orchestra**: Specialized agents created in `.claude/commands/` for different domains (architect, frontend, backend, e2ee, data, engine, test, devops).

### Files Removed (Legacy Cleanup)
- `frontend/src/services/keyManager.js`
- `backend/src/services/keyManagementService.js`
- `backend/src/controllers/keyManagementController.js`
- `backend/src/services/messagingService.js`
- `backend/src/controllers/messagingController.js`

## Development Reminders
- When you make a screenshot with browsertools mcp server, always remember to look at it!
- please remember to always look at screenshots when you made them. they are being saved in /home/justus/Nextcloud/intellacc.com//screenshots
- Always look at screenshots after making them in /home/justus/Nextcloud/intellacc.com//screenshots