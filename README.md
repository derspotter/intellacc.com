# Intellacc

Prediction-market social platform with encrypted messaging and community-driven market creation.

## What you get
- **Social feed**: posts, comments, attachments, profiles, and leaderboards.
- **Markets**: Rust LMSR prediction engine with events, outcomes, and trading.
- **Persuasive Alpha**: users submit prediction questions, validators review and approve, and rewards are auto-distributed by rule.
- **E2EE Messaging**: one-to-one and group chats with OpenMLS (WASM), plus safety-number and device trust flows.
- **Security**: passkey + PRF unlock support, device linking, and tiered verification.
- **Moderation**: AI-assisted content flagging and admin report/review paths.

## Stack
- Frontend: `frontend` (VanJS + Vite) on `:5173`
- Backend: `backend` (Express + Socket.IO) on `:3000`
- Prediction engine: `prediction-engine` (Rust/Axum) on `:3001`
- Database: PostgreSQL
- Reverse proxy: Caddy on `80/443`

## Quick start
1. `docker network create intellacc-network`
2. Configure env files: `backend/.env`, `prediction-engine/.env`
3. `docker compose up -d`
4. Open:
   - App: `http://localhost:5173`
   - API: `http://localhost:3000`
   - Engine: `http://localhost:3001`

## Useful commands
- `docker compose up -d`
- `docker compose down`
- `docker compose logs -f`
- `docker compose ps`
- `docker exec intellacc_backend npm test`
- `docker exec intellacc_frontend npm test`
- `docker exec -it intellacc_db psql -U intellacc_user -d intellaccdb`

## Docs
- `docs/unified-backlog.md`
- `docs/persuasive-alpha-v1-implementation-plan.md`
- `docs/mls-status.md`
- `docs/verification-implementation-plan.md`

## Test users
- `user1@example.com` / `password123`
- `user2@example.com` / `password123`
