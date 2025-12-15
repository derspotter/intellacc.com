# Prediction Social - Agent Orchestra

A social media platform where **visibility is earned through prediction accuracy**.

## 🎭 Agent Orchestra

This project uses specialized AI agents for different domains. Each agent has deep expertise in their area:

| Command | Agent | Specialty |
|---------|-------|-----------|
| `/agent:architect` | 🏗️ Architect | System design, interfaces, data flow |
| `/agent:frontend` | 🎨 Frontend | VanJS components, reactivity, UI |
| `/agent:backend` | ⚙️ Backend | Node.js API, auth, services |
| `/agent:engine` | 🦀 Engine | Rust scoring algorithms, FFI |
| `/agent:data` | 🗄️ Data | PostgreSQL schema, queries |
| `/agent:test` | 🧪 Test | Testing across all layers |
| `/agent:devops` | 🚀 DevOps | Docker, CI/CD, infrastructure |

## 🚀 Quick Start

```bash
# Install dependencies
npm install
cd engine && cargo build --release -p engine-ffi
cd ..

# Start development
docker-compose -f docker-compose.dev.yml up -d  # Start Postgres
npm run db:migrate                               # Run migrations
npm run dev                                      # Start frontend + backend
```

## 📁 Project Structure

```
prediction-social/
├── .claude/
│   ├── agents/           # Agent prompt files
│   │   ├── architect.md
│   │   ├── frontend.md
│   │   ├── backend.md
│   │   ├── engine.md
│   │   ├── data.md
│   │   ├── test.md
│   │   └── devops.md
│   ├── config.json       # Agent configuration
│   └── ORCHESTRATOR.md   # Coordination guide
├── frontend/             # VanJS application
├── backend/              # Node.js API
├── engine/               # Rust prediction engine
├── migrations/           # Database migrations
├── tests/                # Cross-cutting tests
└── docker/               # Container configs
```

## 🎯 Core Concept: Visibility Score

Users earn visibility (0.0 - 1.0) through accurate predictions:

```
visibility = f(accuracy, volume, recency, stake)
```

**Tiers:**
- 🌱 **Novice** (< 0.3) - New users, limited reach
- 🎯 **Predictor** (0.3 - 0.5) - Building track record
- 📊 **Forecaster** (0.5 - 0.7) - Reliable predictions
- 🔮 **Seer** (0.7 - 0.9) - High accuracy, broad reach
- 👁️ **Oracle** (> 0.9) - Top predictors, maximum visibility

## 🔄 Typical Workflows

### New Feature
```
1. /agent:architect  → Design the feature
2. /agent:engine     → Update scoring (if needed)
3. /agent:data       → Schema changes
4. /agent:backend    → API endpoints
5. /agent:frontend   → UI components
6. /agent:test       → Write tests
7. /agent:devops     → Deploy
```

### Bug Fix
```
1. Identify layer
2. Invoke specific agent
3. /agent:test → Verify fix
```

## 🏛️ Architecture

```
┌─────────────────────────────────────────────┐
│            Frontend (VanJS)                 │
│  Feed • Predictions • Profile • Markets    │
└─────────────────┬───────────────────────────┘
                  │ REST / WebSocket
┌─────────────────▼───────────────────────────┐
│           Backend (Node.js)                 │
│   Auth • Feed Ranking • Market Resolution  │
└────────┬────────────────────────┬───────────┘
         │ FFI (napi-rs)          │ SQL
┌────────▼────────┐    ┌──────────▼───────────┐
│  Rust Engine    │    │    PostgreSQL        │
│  Scoring •      │    │  Users • Markets •   │
│  Ranking        │    │  Predictions • Feed  │
└─────────────────┘    └──────────────────────┘
```

## 📖 Agent Details

Each agent file in `.claude/agents/` contains:
- Domain expertise and responsibilities
- Code patterns and examples
- API contracts and interfaces
- Handoff protocols to other agents

Read an agent file to understand its capabilities before invoking it.

## 🤝 Contributing

1. Read the relevant agent file first
2. Follow the code patterns established
3. Write tests for new functionality
4. Update agent files if patterns change
