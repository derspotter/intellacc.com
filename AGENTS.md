# AGENTS.md

This file guides AI coding agents working in this repository. It summarizes the
project shape, commands, and conventions.

## Project Overview
Intellacc is a prediction market + social platform with:
- Social feed (posts/comments)
- LMSR-based prediction markets
- End-to-end encrypted messaging via OpenMLS (WASM)
- User profiles with prediction accuracy tracking

## Architecture
Frontend (VanJS + Vite)          Backend (Express.js)         Prediction Engine (Rust)
port 5173                        port 3000                    port 3001
├─ openmls-wasm (E2EE)          ├─ Socket.io (realtime)      ├─ Axum web framework
├─ VanJS reactive stores        ├─ MLS message relay         ├─ LMSR market maker
└─ Hash-based routing           └─ PostgreSQL queries        └─ SQLx + PostgreSQL

Database: PostgreSQL (container: intellacc_db, user: intellacc_user, db: intellaccdb)

## Key Paths
- Frontend: frontend/
- Backend: backend/ (entry: backend/src/index.js)
- Prediction engine: prediction-engine/
- MLS WASM: openmls-wasm/
- DB migrations: backend/migrations/

## Development Commands (Docker-first)
Run commands inside containers unless noted.

Start stack:
  docker network create intellacc-network  # once
  docker compose up -d

Logs:
  docker logs -f intellacc_backend
  docker logs -f intellacc_frontend
  docker logs -f intellacc_prediction_engine

Database:
  docker exec -it intellacc_db psql -U intellacc_user -d intellaccdb

Tests:
  docker exec intellacc_backend npm test
  docker exec intellacc_frontend npm test
  npx playwright test tests/e2e/messaging-full.spec.js  # host (Playwright)

Rebuild Rust service:
  docker compose up -d --build prediction-engine

## Conventions & Guidelines
- Frontend: VanJS, minimal abstractions, hash-based routing (#home, #predictions).
- Backend: CommonJS, direct SQL for performance/clarity.
- Indentation: 2 spaces.
- Strings: prefer single quotes.
- Auth: JWT middleware; use userId (not username) for MLS identity.
- Schema changes: check backend/migrations/ before updating DB logic.

## E2E Test Users
user1@example.com / password123 (ID: 24)
user2@example.com / password123 (ID: 25)
