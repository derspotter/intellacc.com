# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Intellacc is a prediction and social platform with:
- Social feed with posts/comments
- Prediction markets using LMSR (Logarithmic Market Scoring Rule)
- End-to-end encrypted messaging via OpenMLS WASM
- User profiles with prediction accuracy tracking

## Architecture

```
Frontend (SolidJS + Vite)        Backend (Express.js)         Prediction Engine (Rust)
port 4174                        port 3000                    port 3001
├─ openmls-wasm (E2EE)          ├─ Socket.io (realtime)      ├─ Axum web framework
├─ Solid reactive stores        ├─ MLS message relay         ├─ LMSR market maker
└─ Hash-based routing           └─ PostgreSQL queries        └─ SQLx + PostgreSQL
```

The legacy VanJS frontend (`frontend/`) was removed from mainline after the
2026-06-11 Solid cutover; it is preserved at the `fallback/vanjs-final` tag
and the `archive/vanjs` branch.

**Database**: PostgreSQL (container: `intellacc_db`, user: `intellacc_user`, db: `intellaccdb`)

## Development Commands

**IMPORTANT**: This is Docker-based. Run all commands inside containers.

```bash
# Start full stack
docker network create intellacc-network  # once
docker compose up -d

# View logs
docker logs -f intellacc_backend
docker logs -f intellacc_frontend_solid
docker logs -f intellacc_prediction_engine

# Database access
docker exec -it intellacc_db psql -U intellacc_user -d intellaccdb

# Run backend tests (inside container)
docker exec intellacc_backend npm test

# Run single backend test
docker exec intellacc_backend npx jest test/messaging_e2e.test.js

# E2E tests (from host, uses Playwright)
./tests/e2e/reset-test-users.sh
npx playwright test tests/e2e/messaging-v2-smoke.spec.js

# Solid cutover gate (build + smoke checks)
RUN_PLAYWRIGHT=1 ./scripts/solid-cutover-gate.sh

# Rebuild after Rust changes
docker compose up -d --build prediction-engine
```

## Key Technical Details

### Frontend (`frontend-solid/`)
- **Framework**: SolidJS + Vite, container `intellacc_frontend_solid` (serves a production `vite preview` build on port 4174)
- **State**: Stores in `src/store/` (messaging, vault, user)
- **Routing**: Hash-based (`#home`, `#predictions`, `#profile`, `#messages`, `#analytics`)
- **E2EE Client**: `shared/mls/coreCryptoClient.js` - OpenMLS WASM wrapper shared via the `@shared` Vite alias (exposed as `window.coreCryptoClient` for E2E)
- **Vault**: `src/services/mls/vaultService.js` - encrypted keystore for MLS credentials
- **Dev server**: `docker compose -p solid-local -f docker-compose.solid-local.yml up -d` (source-mounted Vite dev on host port 4174; ALWAYS use `-p solid-local` so it does not replace the production container)

### Backend (`backend/`)
- **Entry**: `src/index.js`
- **Routes**: `src/routes/api.js` (main), `src/routes/mls.js` (E2EE)
- **MLS Service**: `src/services/mlsService.js` - key packages, group management, message relay
- **Auth**: JWT-based, middleware in `src/middleware/auth.js`
- **Socket Events**: `mls-message`, `mls-welcome` for realtime E2EE

### Prediction Engine (`prediction-engine/`)
- **Core**: `src/lmsr_core.rs` - LMSR math with f64 + i128 ledger units (LEDGER_SCALE = 1_000_000)
- **API**: `src/lmsr_api.rs` - Axum REST endpoints
- **DB**: `src/database.rs` - SQLx queries
- Built in Docker only (not cargo on host)

### Database Migrations
- Location: `backend/migrations/`
- Auto-run on backend container start
- Key tables: `users`, `posts`, `events`, `predictions`, `mls_key_packages`, `mls_groups`, `mls_relay_queue`

## E2E Test Users
```
user1@example.com / password123 (ID: 24)
user2@example.com / password123 (ID: 25)
```

## MLS Identity
Uses `userId` (not username) for MLS identity - immutable and already in JWT.

## Ports
- Frontend (Solid): 4174
- Backend: 3000
- Prediction Engine: 3001
- Database: 5432
- Caddy (prod): 80/443

## Consulting External AI (Gemini/Codex)

When asking Gemini or Codex for feedback on implementation or architecture decisions:
1. **Always reference the actual files** that would be changed
2. **Include relevant code snippets** or file paths from this codebase
3. **Provide context** about existing patterns in the codebase

Example prompt structure:
```
We're implementing [feature] in this codebase.

RELEVANT FILES:
- frontend-solid/src/services/auth.js - current auth flow
- frontend-solid/src/components/vault/DeviceLinkModal.jsx - device verification UI
- backend/src/controllers/deviceController.js - device verification backend

CURRENT IMPLEMENTATION:
[describe or quote relevant code]

PROPOSED CHANGE:
[describe the change]

QUESTIONS:
[specific questions]
```

This helps the AI give more relevant, actionable feedback specific to our codebase.
