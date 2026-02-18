# Intellacc

Prediction markets + social feed + encrypted messaging in one app.

## What it is now
- Social posts/comments with attachments and profile timelines.
- LMSR prediction markets (Rust engine) with trading, outcomes, and balances.
- **Persuasive Alpha**: users submit prediction questions, validators review and approve them, and rewards are distributed automatically.
- End-to-end encrypted DMs and groups via OpenMLS (WASM).
- Trust features: device linking, safety numbers, and optional verification checks.
- Security and moderation: passkey PRF unlock, tiered verification, and AI flagging workflow.

## Stack
- **Frontend**: VanJS + Vite (`:5173`)
- **Backend**: Express + Socket.IO (`:3000`)
- **Prediction engine**: Rust/Axum (`:3001`)
- **Data**: PostgreSQL
- **Proxy**: Caddy (`80/443`)

## Quick start
1. `docker network create intellacc-network`
2. Set env files (`backend/.env`, `prediction-engine/.env`)
3. `docker compose up -d`
4. Open:
   - App: `http://localhost:5173`
   - API: `http://localhost:3000`
   - Engine: `http://localhost:3001`

## Useful commands
- `docker compose up -d` / `docker compose down` / `docker compose logs -f`
- `docker compose ps`
- `docker exec -it intellacc_db psql -U intellacc_user -d intellaccdb`
- `docker exec intellacc_backend npm test`
- `docker exec intellacc_frontend npm test`
- `docker compose up -d --build prediction-engine`

## Docs
- `docs/unified-backlog.md`
- `docs/mls-status.md`
- `docs/persuasive-alpha-v1-implementation-plan.md`
- `docs/verification-implementation-plan.md`

## Note
Test users in repo seed data: `user1@example.com` and `user2@example.com` with password `password123`.
