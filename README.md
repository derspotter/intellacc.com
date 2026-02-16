# Intellacc

Intellacc is a prediction-market social network that combines a social feed, LMSR-based markets, and end-to-end encrypted messaging.

## Current Features

- Social feed with posts, comments, and media attachments
- Prediction markets powered by a Rust LMSR engine
- End-to-end encrypted messaging (DMs and groups) via OpenMLS (WASM)
- User profiles with accuracy tracking and leaderboards
- Realtime updates over Socket.IO

## Architecture

- Frontend: VanJS + Vite (port 5173)
- Backend: Express + Socket.IO, with Caddy as reverse proxy (port 3000, Caddy on 80/443)
- Prediction engine: Rust (Axum) service for LMSR markets (port 3001)
- Database: PostgreSQL (container: `intellacc_db`)

## Repository Layout

- `frontend/` VanJS client and styles
- `backend/` Express API, Socket.IO, DB migrations, uploads
- `prediction-engine/` Rust LMSR service
- `openmls-wasm/` OpenMLS WASM package
- `docs/` Product and technical docs
- `tests/` E2E and integration tests

## Getting Started (Docker)

1. Create the shared Docker network (one time).

   ```sh
   docker network create intellacc-network
   ```

2. Review environment files.

   ```sh
   # Backend + DB + Caddy
   backend/.env
   # Prediction engine
   prediction-engine/.env
   ```

3. Start your local development stack (safe, isolated from production containers).

   ```sh
   ./scripts/dev-stack.sh up
   ```

4. Open the app.

   Frontend: http://localhost:5175
   Backend API: http://localhost:3005
   Prediction engine: http://localhost:3006

Production runs separately on ports 5173/3000/3001.

## Useful Commands

- Local stack up: `./scripts/dev-stack.sh up`
- Local stack down: `./scripts/dev-stack.sh down`
- Local stack logs: `./scripts/dev-stack.sh logs`
- Local stack status: `./scripts/dev-stack.sh status`
- Production stack (from this repo): `docker compose up -d` (only if that's intentionally desired)

- Logs: `docker logs -f intellacc_backend`
- Logs: `docker logs -f intellacc_frontend`
- Logs: `docker logs -f intellacc_prediction_engine`
- DB shell: `docker exec -it intellacc_db psql -U intellacc_user -d intellaccdb`
- Backend tests: `docker exec intellacc_backend npm test`
- Frontend tests: `docker exec intellacc_frontend npm test`
- Rebuild Rust service: `docker compose up -d --build prediction-engine`

## Test Users

- `user1@example.com` / `password123`
- `user2@example.com` / `password123`

## Project Docs

- Unified backlog: `docs/unified-backlog.md`
- MLS status: `docs/mls-status.md`
