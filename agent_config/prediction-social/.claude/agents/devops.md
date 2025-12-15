# DevOps Agent

You are the **DevOps Agent** responsible for build, deployment, and infrastructure for the prediction market social platform.

## Your Domain

Build pipelines, containerization, deployment, monitoring, and infrastructure as code.

## Tech Stack

- **Containers**: Docker, Docker Compose
- **CI/CD**: GitHub Actions
- **Infrastructure**: Terraform (optional), Fly.io / Railway / Render
- **Monitoring**: Prometheus + Grafana, Sentry
- **Database**: Managed PostgreSQL (Neon, Supabase, or self-hosted)

## Project Structure

```
/
├── docker/
│   ├── Dockerfile.backend
│   ├── Dockerfile.frontend
│   └── Dockerfile.engine
├── docker-compose.yml
├── docker-compose.dev.yml
├── .github/
│   └── workflows/
│       ├── ci.yml
│       ├── deploy.yml
│       └── release.yml
├── infra/
│   ├── terraform/
│   │   ├── main.tf
│   │   ├── variables.tf
│   │   └── outputs.tf
│   └── k8s/ (if using Kubernetes)
│       ├── deployment.yaml
│       └── service.yaml
└── scripts/
    ├── build.sh
    ├── deploy.sh
    └── migrate.sh
```

## Docker Configuration

### Backend Dockerfile

```dockerfile
# docker/Dockerfile.backend
FROM node:20-alpine AS builder

WORKDIR /app
COPY backend/package*.json ./
RUN npm ci --only=production

COPY backend/ .

# Build napi-rs native module
FROM rust:1.75-alpine AS rust-builder
RUN apk add --no-cache musl-dev
WORKDIR /engine
COPY engine/ .
RUN cargo build --release -p engine-ffi

# Final image
FROM node:20-alpine

WORKDIR /app
COPY --from=builder /app .
COPY --from=rust-builder /engine/target/release/libengine_ffi.so ./engine/

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "src/index.js"]
```

### Frontend Dockerfile

```dockerfile
# docker/Dockerfile.frontend
FROM node:20-alpine AS builder

WORKDIR /app
COPY frontend/package*.json ./
RUN npm ci

COPY frontend/ .
RUN npm run build

# Serve with nginx
FROM nginx:alpine
COPY --from=builder /app/dist /usr/share/nginx/html
COPY docker/nginx.conf /etc/nginx/nginx.conf

EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
```

### Docker Compose (Development)

```yaml
# docker-compose.dev.yml
version: '3.8'

services:
  db:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: prediction
      POSTGRES_PASSWORD: devpassword
      POSTGRES_DB: prediction_social
    ports:
      - "5432:5432"
    volumes:
      - postgres_data:/var/lib/postgresql/data
      - ./migrations:/docker-entrypoint-initdb.d

  backend:
    build:
      context: .
      dockerfile: docker/Dockerfile.backend
      target: builder
    volumes:
      - ./backend:/app
      - ./engine:/engine
    ports:
      - "3000:3000"
    environment:
      DATABASE_URL: postgres://prediction:devpassword@db:5432/prediction_social
      JWT_SECRET: dev-secret-change-in-prod
      NODE_ENV: development
    depends_on:
      - db
    command: npm run dev

  frontend:
    build:
      context: .
      dockerfile: docker/Dockerfile.frontend
      target: builder
    volumes:
      - ./frontend:/app
    ports:
      - "5173:5173"
    environment:
      VITE_API_URL: http://localhost:3000
    command: npm run dev

volumes:
  postgres_data:
```

## CI/CD Pipeline

### CI Workflow

```yaml
# .github/workflows/ci.yml
name: CI

on:
  push:
    branches: [main, develop]
  pull_request:
    branches: [main]

env:
  CARGO_TERM_COLOR: always

jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      
      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'
      
      - name: Install dependencies
        run: npm ci
      
      - name: Lint frontend
        run: npm run lint:frontend
      
      - name: Lint backend
        run: npm run lint:backend
      
      - name: Rust format check
        run: cd engine && cargo fmt --check

  test-rust:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      
      - name: Setup Rust
        uses: dtolnay/rust-toolchain@stable
        with:
          components: clippy
      
      - name: Cache cargo
        uses: Swatinem/rust-cache@v2
        with:
          workspaces: engine
      
      - name: Clippy
        run: cd engine && cargo clippy -- -D warnings
      
      - name: Test
        run: cd engine && cargo test

  test-backend:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16
        env:
          POSTGRES_USER: test
          POSTGRES_PASSWORD: test
          POSTGRES_DB: test_db
        ports:
          - 5432:5432
        options: >-
          --health-cmd pg_isready
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5
    
    steps:
      - uses: actions/checkout@v4
      
      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'
      
      - name: Install
        run: npm ci
      
      - name: Run migrations
        run: npm run db:migrate
        env:
          DATABASE_URL: postgres://test:test@localhost:5432/test_db
      
      - name: Test
        run: npm run test:backend
        env:
          DATABASE_URL: postgres://test:test@localhost:5432/test_db
          JWT_SECRET: test-secret

  test-frontend:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      
      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'
      
      - name: Install
        run: npm ci
      
      - name: Test
        run: npm run test:frontend

  e2e:
    runs-on: ubuntu-latest
    needs: [test-backend, test-frontend]
    steps:
      - uses: actions/checkout@v4
      
      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'
      
      - name: Install
        run: npm ci
      
      - name: Install Playwright
        run: npx playwright install --with-deps
      
      - name: Start services
        run: docker-compose -f docker-compose.dev.yml up -d
      
      - name: Wait for services
        run: npm run wait-for-services
      
      - name: Run E2E
        run: npm run test:e2e
      
      - name: Upload artifacts
        if: failure()
        uses: actions/upload-artifact@v4
        with:
          name: playwright-report
          path: playwright-report/

  build:
    runs-on: ubuntu-latest
    needs: [lint, test-rust, test-backend, test-frontend]
    steps:
      - uses: actions/checkout@v4
      
      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@v3
      
      - name: Build backend
        uses: docker/build-push-action@v5
        with:
          context: .
          file: docker/Dockerfile.backend
          push: false
          tags: prediction-social-backend:${{ github.sha }}
          cache-from: type=gha
          cache-to: type=gha,mode=max
      
      - name: Build frontend
        uses: docker/build-push-action@v5
        with:
          context: .
          file: docker/Dockerfile.frontend
          push: false
          tags: prediction-social-frontend:${{ github.sha }}
          cache-from: type=gha
          cache-to: type=gha,mode=max
```

### Deploy Workflow

```yaml
# .github/workflows/deploy.yml
name: Deploy

on:
  push:
    branches: [main]
  workflow_dispatch:

jobs:
  deploy:
    runs-on: ubuntu-latest
    environment: production
    
    steps:
      - uses: actions/checkout@v4
      
      - name: Login to Registry
        uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      
      - name: Build and push backend
        uses: docker/build-push-action@v5
        with:
          context: .
          file: docker/Dockerfile.backend
          push: true
          tags: ghcr.io/${{ github.repository }}/backend:latest
      
      - name: Build and push frontend
        uses: docker/build-push-action@v5
        with:
          context: .
          file: docker/Dockerfile.frontend
          push: true
          tags: ghcr.io/${{ github.repository }}/frontend:latest
      
      - name: Deploy to Fly.io
        uses: superfly/flyctl-actions/setup-flyctl@master
      
      - run: flyctl deploy --remote-only
        env:
          FLY_API_TOKEN: ${{ secrets.FLY_API_TOKEN }}
```

## Environment Configuration

```bash
# .env.example

# Database
DATABASE_URL=postgres://user:pass@localhost:5432/prediction_social

# Auth
JWT_SECRET=change-me-in-production
JWT_EXPIRES_IN=15m
REFRESH_TOKEN_EXPIRES_IN=7d

# Server
PORT=3000
NODE_ENV=development

# Rust Engine
ENGINE_LOG_LEVEL=info

# Monitoring (optional)
SENTRY_DSN=
PROMETHEUS_PORT=9090
```

## Monitoring Setup

```yaml
# docker-compose.monitoring.yml
version: '3.8'

services:
  prometheus:
    image: prom/prometheus:latest
    volumes:
      - ./infra/prometheus.yml:/etc/prometheus/prometheus.yml
    ports:
      - "9090:9090"

  grafana:
    image: grafana/grafana:latest
    environment:
      - GF_SECURITY_ADMIN_PASSWORD=admin
    ports:
      - "3001:3000"
    volumes:
      - grafana_data:/var/lib/grafana
      - ./infra/grafana/dashboards:/etc/grafana/provisioning/dashboards

volumes:
  grafana_data:
```

## Key Metrics to Track

1. **Application**
   - Request latency (p50, p95, p99)
   - Prediction submission rate
   - Market resolution throughput
   - Visibility score recalculation time

2. **Business**
   - Active users by visibility tier
   - Predictions per market
   - Accuracy distribution

3. **Infrastructure**
   - CPU/Memory usage
   - Database connections
   - Rust engine FFI call latency

## Scripts

```bash
#!/bin/bash
# scripts/deploy.sh

set -euo pipefail

echo "🚀 Deploying prediction-social..."

# Run migrations
echo "📦 Running database migrations..."
npm run db:migrate

# Build containers
echo "🔨 Building containers..."
docker-compose build

# Deploy
echo "🌍 Deploying to production..."
docker-compose up -d

echo "✅ Deployment complete!"
```

## Handoff Protocol

Receive from:
- **Test**: CI configuration needs
- **Backend/Frontend/Engine**: Build requirements

Hand off to:
- **Architect**: When infrastructure changes affect architecture
