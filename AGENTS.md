# Repository Guidelines

## Project Structure & Module Organization
- `frontend/` (VanJS + Vite): UI assets in `public/`, source in `src/`.
- `backend/` (Node.js + Express + Socket.IO): app entry `src/index.js`, DB helper `src/db.js`, HTTP routes in `src/routes/`, SQL in `migrations/`.
- `prediction-engine/` (Rust + Axum): service code in `src/`, Docker and stress-test scripts included.
- Utility scripts in `scripts/` (Playwright-based console capture, data population). Tests live in `backend/test/` and `frontend/test/`.

## Build, Test, and Development Commands (Docker)
- One-time: `docker network create intellacc-network` (external network used by all services).
- Backend: `cd backend && docker compose up --build -d` (starts Postgres, backend, Caddy). Logs: `docker compose logs -f backend`.
- Frontend: `cd frontend && docker compose up --build -d` (Vite dev server in container on `5173`). Logs: `docker compose logs -f frontend`.
- Prediction Engine (Rust): `cd prediction-engine && docker compose up --build -d` (exposes `3001`).
- Tests (backend): `cd backend && docker compose exec backend npm test`.
- Tests (frontend): `cd frontend && docker compose exec frontend npx vitest`.
- Optional tooling: from repo root, `npm run console` streams browser console for `http://localhost:5173` (requires Playwright on host).

## Coding Style & Naming Conventions
- JavaScript: 2-space indent, semicolons; CommonJS in backend, ESM in frontend. Filenames: `lowerCamelCase.js` for modules, `PascalCase.js` for components.
- Rust: idiomatic modules; run `rustfmt` locally. Keep functions small and focused.
- No ESLint/Prettier configured; match surrounding code. Keep functions <100 lines; avoid one-letter vars.

## Testing Guidelines
- Backend: Jest tests in `backend/test/*.test.js`; run with `cd backend && npm test`.
- Frontend: Vitest with JSDOM; run `cd frontend && npx vitest`. Name tests `*.test.js` mirroring source paths.
- Include at least one test per route/feature touched. For real-time features, prefer unit tests plus minimal integration stubs.

## Commit & Pull Request Guidelines
- Commits: imperative, present tense, concise summary (e.g., "Implement LMSR stress testing"). Group related changes.
- PRs: clear description, linked issues, steps to reproduce, screenshots for UI changes, and notes on DB migrations. Confirm local runs: `backend npm test`, `frontend vitest`, and Docker startup if relevant.

## Security & Configuration Tips
- Env files: `backend/.env` (e.g., `POSTGRES_*`, `DATABASE_URL`, `NODE_PORT`, `JWT_SECRET`, optional `FRONTEND_URL`), and `prediction-engine/.env`. Do not commit secrets.
- Socket.IO CORS origins derive from `FRONTEND_URL`; set to the deployed frontend origin.

## Dev Mode (Hot Reload)
- Prediction engine hot reload: use the override `docker-compose.dev.yml`.
  - Stop release engine: `docker compose stop prediction-engine`.
  - Start dev engine: `docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d prediction-engine-dev`.
  - Tail logs: `docker compose -f docker-compose.yml -f docker-compose.dev.yml logs -f prediction-engine-dev`.
  - The dev service mounts `prediction-engine/` and runs `cargo watch -x 'run'` with cached volumes. It joins `intellacc-network` with alias `prediction-engine`, so backend calls keep working.
  - Revert: `docker compose -f docker-compose.yml -f docker-compose.dev.yml down prediction-engine-dev && docker compose up -d prediction-engine`.

## Agent-Specific Instructions
- Keep changes minimal and scoped. Do not reformat unrelated files. Update docs when altering routes, events, or env vars.
