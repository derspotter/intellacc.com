# Intellacc Agent Quickstart (Docker-first)

Everything runs in Docker. Do not run npm or services on the host.

## Topology
- Frontend (Vite + VanJS): port 5173 (container `intellacc_frontend`)
- Backend (Express + Socket.IO): port 3000 (container `intellacc_backend`)
- PostgreSQL: port 5432 (container `intellacc_db`)
- Prediction Engine (Rust LMSR): port 3001 (container `intellacc_prediction_engine`)
- Caddy (reverse proxy): ports 80/443 (container `intellacc_caddy`)

## Network
Create once (if not already present):
```bash
docker network create intellacc-network
```

## Start/Stop (full stack)
```bash
# from repo root
docker compose up -d
# stop
docker compose down
```

To use the development overrides for the prediction engine:
```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d
```

## Service URLs
- Frontend: http://localhost:5173
- Backend API: http://localhost:3000/api
- Backend health: http://localhost:3000/api/health-check
- Prediction Engine: http://localhost:3001/health

## Logs
```bash
docker compose logs -f backend
docker compose logs -f frontend
docker compose logs -f prediction-engine
docker compose logs -f db
docker compose logs -f caddy
```

## Exec into containers
```bash
# backend shell
docker exec -it intellacc_backend sh
# frontend shell
docker exec -it intellacc_frontend sh
# db psql
docker exec -it intellacc_db psql "$DATABASE_URL"
```

## Development
- Source is bind-mounted; edits on host reflect in containers.
- Backend command waits for DB, runs migrations, then starts dev:
  - See `command` in backend compose.

Run scripts/tests inside containers:
```bash
# backend tests (Jest)
docker exec -it intellacc_backend npm test
# run single test
docker exec -it intellacc_backend npm test -- path/to/test
# scripts (populate DB)
docker exec -it intellacc_backend node scripts/populate_database.js
```

## Environment
Required backend env (place in `backend/.env` and export for compose):
- `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`, `POSTGRES_PORT`
- `DATABASE_URL` (e.g., postgres://user:pass@db:5432/dbname)
- `NODE_ENV`, `NODE_PORT` (e.g., 3000)
- `CADDY_EMAIL` for Caddy

## Compose structure
- Root includes service stacks:
  - [`docker-compose.yml`](docker-compose.yml)
  - Backend: [`backend/docker-compose.yml`](backend/docker-compose.yml)
  - Frontend: [`frontend/docker-compose.yml`](frontend/docker-compose.yml)
  - Prediction Engine: [`prediction-engine/docker-compose.yml`](prediction-engine/docker-compose.yml)
- Dev overrides: [`docker-compose.dev.yml`](docker-compose.dev.yml)
- Cron job stack: [`docker-compose-cron.yml`](docker-compose-cron.yml)

## Notable code files
- Backend entry: [`backend/src/index.js`](backend/src/index.js)
- API routes: [`backend/src/routes/api.js`](backend/src/routes/api.js)
- Controllers: [`backend/src/controllers`](backend/src/controllers)
- Migrations: [`migrations/`](migrations)
- Scripts: [`scripts/populate_database.js`](scripts/populate_database.js)

## Prediction Engine
- Built and run in Docker only (no host cargo).
- Dev override mounts `prediction-engine/src` read-only and sets `RUST_LOG`.

## Caddy
- Config: [`backend/Caddyfile`](backend/Caddyfile) mounted into the Caddy container.

## Notes
- All npm commands are run via `docker exec` inside the appropriate container.
- Use the shared `intellacc-network` so services can resolve each other by name.
