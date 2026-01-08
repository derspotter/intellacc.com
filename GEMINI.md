# GEMINI.md

This file provides guidance to the Gemini CLI agent when working with the Intellacc codebase.

## Project Overview
Intellacc is a sophisticated prediction market and social platform featuring:
- **Prediction Markets**: Powered by a Rust-based LMSR engine for accurate market scoring.
- **E2EE Messaging**: Secure communication using OpenMLS (WASM) for end-to-end encryption.
- **Social Integration**: Feed, posts, and comments integrated with prediction accuracy.
- **Mobile-First**: Designed as a PWA with VanJS for high performance and low overhead.

## Architecture
- **Frontend**: VanJS + Vite (minimalist reactive framework).
- **Backend**: Node.js/Express.js (REST API + Socket.io relay).
- **Prediction Engine**: Rust/Axum (high-performance LMSR calculations).
- **Database**: PostgreSQL (relational storage for all entities).
- **E2EE Layer**: OpenMLS compiled to WASM, running in the browser and relayed via the backend.

## Technical Stack & Ports
- **Frontend**: Port 5173
- **Backend**: Port 3000
- **Prediction Engine**: Port 3001
- **Database**: Port 5432
- **Infrastructure**: Docker Compose for full-stack orchestration.

## Key Commands

### Docker Operations
- `docker compose up -d` - Start the full stack.
- `docker compose logs -f [service]` - View logs for `backend`, `frontend`, or `prediction-engine`.
- `docker exec -it intellacc_backend npm test` - Run backend tests.
- `docker exec -it intellacc_frontend npm test` - Run frontend tests.

### Development & Testing
- **E2E Tests**: `npx playwright test` (from host).
- **Database**: `docker exec -it intellacc_db psql -U intellacc_user -d intellaccdb`.
- **Rust Rebuild**: `docker compose up -d --build prediction-engine`.

## Core Guidelines
- **Minimalism**: Adhere to the VanJS philosophy—prefer simple HTML/JS over complex abstractions.
- **Direct SQL**: Use raw SQL queries in the backend for performance and clarity.
- **Immutable Identity**: Use `userId` from JWT for MLS and all internal references.
- **Schema Safety**: Always check `backend/migrations/` before modifying database logic.

## Current Focus Areas
- **E2EE Stability**: Strengthening OpenMLS integration and persistence.
- **Authentication**: Implementing WebAuthn/Passkeys (see `authn-plan.md`).
- **Performance**: Optimizing LMSR calculations and social feed loading.
