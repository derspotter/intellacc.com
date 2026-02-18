# Intellacc

Intellacc is a prediction-market social network with encrypted social messaging, community-driven signal scoring, and prediction-market trading infrastructure.

## Current Features

- Social feed with posts, comments, media attachments, and profile timelines.
- Prediction markets powered by a Rust LMSR engine, with order books, event updates, and wallet-based balances.
- **Persuasive Alpha / market-question validation flow**:
  - Users can submit their own prediction questions.
  - Community validators review submissions.
  - Automatic approval/reward logic based on configurable quorum/bond rules.
  - Creator and validator payouts are handled automatically for approved questions.
- User reputation and scoring with monthly assignment + decay logic.
- End-to-end encrypted messaging (DMs and groups) via OpenMLS (WASM), including staged welcome, safety-number UX, and contact verification flows.
- Device linking and verification for trust across devices.
- Passkey-based authentication with WebAuthn PRF unlock path.
- Tiered verification framework (email, phone, payment provider-gated tiers), currently in production-ready hardening phase.
- AI moderation pipeline (Pangram-backed analysis) with flagged-content surfaces and review workflows.
- Realtime updates and presence via Socket.IO.
- Moderation/reporting, account settings/security controls, and admin workflows for approvals.

## What's New (Recent)

- **Persuasive Alpha questions** now support community-sourced events: users can submit prediction questions, validators can approve/reject, and rewards are automatically distributed through the admin-run reward process.
- **Onboarding + approvals** now has an admin approval flow for new registrations with queue limits, cooldown handling, and one-time approval links.
- **Messaging trust updates** now include staged-welcome handling, safety-number presentation, and device-link verification flows for cleaner multi-device trust.
- **Security hardening** now includes production-focused verification provider checks (email baseline, optional phone/payment gates) and stricter auth/middleware paths.
- **AI moderation** is now tied into moderation workflows with backend endpoints and UI badges/flags for suspect content.

## Default Runtime Assumptions

- Frontend runs at `http://localhost:5173` in local containerized development.
- Backend API runs at `http://localhost:3000`.
- Prediction engine runs at `http://localhost:3001`.
- Caddy can terminate public traffic on ports `80/443` in production setups.
- Registration gating behavior is driven by environment configuration and service flags (default repo behavior may still allow existing users and login flows to remain unchanged).

## Architecture

- Frontend: VanJS + Vite (port 5173)
- Backend API: Express + Socket.IO (port 3000)
- Prediction engine: Rust (Axum) LMSR service (port 3001)
- Database: PostgreSQL (`intellacc_db`)
- Reverse proxy: Caddy (80/443)

## Repository Layout

- `frontend/` VanJS client, service layer, styles, tests
- `backend/` Express API, Socket.IO, services, DB migrations, tests
- `prediction-engine/` Rust LMSR service
- `openmls-wasm/` and `frontend/openmls-pkg/` OpenMLS WASM bindings
- `docs/` Product and technical docs
- `tests/` E2E and integration tests

## Getting Started (Docker)

1. Create the shared Docker network (one time).

   ```sh
   docker network create intellacc-network
   ```

2. Review environment files.

   ```sh
   # Backend + DB + proxy
   backend/.env
   # Prediction engine
   prediction-engine/.env
   ```

3. Start your local development stack (safe, isolated from production containers).

   ```sh
   docker compose up -d
   ```

4. Open the app.

   - Frontend: `http://localhost:5173`
   - Backend API: `http://localhost:3000`
   - Prediction engine: `http://localhost:3001`

Production may run the same services behind Caddy on public ports.

## Useful Commands

- Local stack up: `docker compose up -d`
- Local stack down: `docker compose down`
- Local stack logs: `docker compose logs -f`
- Local stack status: `docker compose ps`
- Production stack (from this repo): `docker compose up -d` (only if intentionally desired)

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
- Persuasive Alpha plan: `docs/persuasive-alpha-v1-implementation-plan.md`
