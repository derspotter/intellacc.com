# Repository Guidelines

## Project Structure & Module Organization
- `frontend/`: VanJS + Vite SPA (`src/`, `public/`, `test/`, `vite.config.js`); hash-based routing.
- `backend/`: Express API and Socket.IO (`src/`, `test/`, `migrations/`, `Caddyfile`).
- `prediction-engine/`: Rust LMSR market maker (`src/`, `Cargo.toml`, Dockerfiles).
- `backend/migrations/`: auto-run database migrations; shared SQL also exists in `migrations/`.
- `openmls-wasm/` and `frontend/openmls-pkg/`: OpenMLS WASM bindings.
- `tests/e2e/`, `docs/`, `scripts/`: Playwright specs, docs, and maintenance utilities.

## Architecture Snapshot
- Frontend: VanJS + Vite on port 5173 with hash-based routing and OpenMLS WASM bindings.
- Backend: Express + Socket.IO on port 3000 with JWT auth, MLS relay flows, and PostgreSQL access.
- Prediction Engine: Rust LMSR service on port 3001 with SQLx/PostgreSQL integration.
- Database: PostgreSQL container (`intellacc_db`), user `intellacc_user`, database `intellaccdb`.

## Build, Test, and Development Commands
- Docker-first workflow: run npm commands inside containers (see `CLAUDE.md`).
- Start stack: `docker network create intellacc-network` (once), then `docker compose up -d`.
- Logs: `docker logs -f intellacc_backend` / `intellacc_frontend` / `intellacc_prediction_engine`.
- Backend tests: `docker exec intellacc_backend npm test` or `docker exec intellacc_backend npx jest test/messaging_e2e.test.js`.
- Frontend tests: `docker exec intellacc_frontend npx vitest`.
- E2E: `./tests/e2e/reset-test-users.sh` then `npx playwright test tests/e2e/messaging-full.spec.js` (host).
- Rebuild Rust service: `docker compose up -d --build prediction-engine`.

## Coding Style & Naming Conventions
- JavaScript uses 2-space indentation, semicolons, and single quotes; match existing file style.
- Frontend components use `PascalCase` filenames (for example, `UserCard.js`).
- Utilities and services use `camelCase` filenames (for example, `messagingUtils.js`).
- SQL migrations use descriptive `snake_case` names, often date-prefixed (for example, `20250727_sync_numeric_ledger_precision.sql`).
- Rust changes should be formatted with `rustfmt` inside the prediction-engine container.

## Testing Guidelines
- Backend tests live in `backend/test` and use Jest (`*.test.js`).
- Frontend tests live in `frontend/test` and use Vitest (`*.test.js`).
- Playwright specs live in `tests/e2e` (`*.spec.js`); set `E2E_BASE_URL` or `E2E_USE_EXISTING_SERVER=true` when pointing at an existing dev server.

## Commit & Pull Request Guidelines
- Commit messages follow the `type: summary` convention seen in history (`feat:`, `fix:`, `refactor:`, `docs:`, `chore:`).
- PRs should include a short description, testing commands run, and screenshots/GIFs for UI changes.
- Call out migrations or config changes (for example, `backend/.env` or `prediction-engine/.env`) in the PR body.

## Security & Configuration Tips
- Keep secrets in `.env` files and never commit credentials.
- Prediction engine runtime flags are documented in `docs/configuration.md`.
- E2EE architecture and vault/key handling notes live in `security.md`.

## Safety Guardrails
- Do not run potentially destructive commands without explicit user approval.
- High-risk git commands include `git checkout -- ...`, `git restore`, `git reset --hard`, `git clean -fdx`, and `git revert` on user work.
- High-risk file operations include `rm -rf`, `rm -f`, overwrite `mv`/`cp`, `truncate`, and shell redirection such as `> file`.
- High-risk Docker/system commands include `docker system prune`, `docker volume rm`, and `docker image rm`.
- High-risk database actions include `DROP`, `TRUNCATE`, and destructive migrations.

## Ports & Services
- Frontend 5173, Backend 3000, Prediction Engine 3001, Postgres 5432, Caddy 80/443.

## E2E Test Users (Local Seed Data)
- `user1@example.com` / `password123` (ID: 24)
- `user2@example.com` / `password123` (ID: 25)
