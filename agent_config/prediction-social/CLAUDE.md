# Prediction Market Social Platform

## Project Overview

A social media platform where user visibility is determined by prediction accuracy. Users make predictions, and their success rate influences their reach and prominence in feeds.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         Frontend (VanJS)                        │
│   Components: Feed, Predictions, Profile, Markets, Leaderboard  │
└─────────────────────────────────┬───────────────────────────────┘
                                  │ REST/WebSocket
┌─────────────────────────────────▼───────────────────────────────┐
│                      Backend (Node.js)                          │
│   Routes, Auth, Social Graph, Content Delivery, API Gateway     │
└──────────────┬──────────────────────────────┬───────────────────┘
               │ FFI/IPC                      │ PostgreSQL
┌──────────────▼──────────────┐    ┌──────────▼──────────────────┐
│   Prediction Engine (Rust)  │    │         Database            │
│   Scoring, Resolution,      │    │   Users, Predictions,       │
│   Market Making, Rankings   │    │   Markets, Social Graph     │
└─────────────────────────────┘    └─────────────────────────────┘
```

## Agent Orchestra

This project uses specialized agents. Invoke them with `/agent:<name>` or use the orchestrator.

### Available Agents

| Agent | Domain | Invoke |
|-------|--------|--------|
| Architect | System design, cross-cutting concerns | `/agent:architect` |
| Frontend | VanJS components, reactivity, UI/UX | `/agent:frontend` |
| Backend | Node.js API, auth, social features | `/agent:backend` |
| Engine | Rust prediction engine, scoring | `/agent:engine` |
| Data | Schema design, queries, migrations | `/agent:data` |
| Test | Testing strategy across all layers | `/agent:test` |
| DevOps | Build, deploy, infrastructure | `/agent:devops` |

## Conventions

### Frontend (VanJS)
- Functional components with `van.derive` for reactivity
- State management via `van.state`
- File naming: `kebab-case.js`
- Components in `/frontend/src/components/`

### Backend (Node.js)
- ESM modules throughout
- Route handlers in `/backend/src/routes/`
- Middleware in `/backend/src/middleware/`
- Services in `/backend/src/services/`

### Prediction Engine (Rust)
- Workspace structure with multiple crates
- `engine-core`: Scoring algorithms, market mechanics
- `engine-ffi`: Node.js bindings via napi-rs
- Located in `/engine/`

### Database
- PostgreSQL with migrations in `/migrations/`
- Naming: `snake_case` for tables and columns

## Key Concepts

### Visibility Score
```
visibility_score = base_score 
                 × prediction_accuracy_multiplier 
                 × recency_decay 
                 × engagement_factor
```

### Prediction Lifecycle
1. Market created (binary, multi-outcome, or continuous)
2. Users stake predictions
3. Resolution trigger (time, oracle, or consensus)
4. Scoring and visibility adjustment
5. Reputation update propagates to feed ranking
