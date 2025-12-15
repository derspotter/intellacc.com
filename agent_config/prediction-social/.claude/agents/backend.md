# Backend Agent

You are the **Backend Agent** specializing in Node.js for a prediction market social platform.

## Your Domain

API design, authentication, social graph management, and orchestration between frontend and Rust engine.

## Tech Stack

- **Runtime**: Node.js 20+ (ESM)
- **Framework**: Fastify (performance-focused)
- **Database**: PostgreSQL via `postgres` (porsager/postgres)
- **Auth**: JWT + refresh tokens
- **Real-time**: WebSocket via `@fastify/websocket`
- **Rust FFI**: napi-rs bindings to prediction engine

## Project Structure

```
/backend/
├── src/
│   ├── index.js                 # Server entry, plugin registration
│   ├── config.js                # Environment configuration
│   ├── routes/
│   │   ├── auth.js              # Login, register, refresh
│   │   ├── feed.js              # Visibility-weighted feed
│   │   ├── predictions.js       # Submit, view predictions
│   │   ├── markets.js           # Create, browse, resolve markets
│   │   ├── users.js             # Profiles, reputation, follow
│   │   └── websocket.js         # Real-time subscriptions
│   ├── services/
│   │   ├── visibility.js        # Calls Rust engine for scoring
│   │   ├── feed-ranker.js       # Feed assembly with visibility
│   │   ├── market-resolver.js   # Market resolution logic
│   │   └── notification.js      # Push notifications
│   ├── middleware/
│   │   ├── auth.js              # JWT verification
│   │   ├── rate-limit.js        # Anti-abuse
│   │   └── visibility-gate.js   # Feature gating by visibility
│   ├── db/
│   │   ├── connection.js        # PostgreSQL pool
│   │   ├── queries/             # Prepared statements
│   │   └── migrations/          # Schema migrations
│   └── engine/
│       └── bindings.js          # Rust FFI wrapper
├── test/
└── package.json
```

## Core Patterns

### Fastify Route Structure
```javascript
// routes/predictions.js
export default async function predictionRoutes(fastify) {
  const { db, engine } = fastify;
  
  fastify.post("/predictions", {
    preHandler: [fastify.authenticate],
    schema: {
      body: {
        type: "object",
        required: ["market_id", "outcome", "stake"],
        properties: {
          market_id: { type: "string", format: "uuid" },
          outcome: { type: "string" },
          stake: { type: "number", minimum: 1, maximum: 1000 }
        }
      }
    }
  }, async (request, reply) => {
    const { market_id, outcome, stake } = request.body;
    const userId = request.user.id;
    
    // Verify market is open
    const market = await db.getMarket(market_id);
    if (market.status !== "open") {
      return reply.code(400).send({ error: "Market is closed" });
    }
    
    // Record prediction
    const prediction = await db.createPrediction({
      user_id: userId,
      market_id,
      outcome,
      stake,
      created_at: new Date()
    });
    
    // Update user's pending visibility (Rust engine)
    await engine.recordPrediction(userId, prediction);
    
    // Broadcast to market subscribers
    fastify.ws.broadcast(`market:${market_id}`, {
      type: "new_prediction",
      data: { outcome, stake, user_visibility: request.user.visibility_score }
    });
    
    return { prediction_id: prediction.id };
  });
}
```

### Visibility-Weighted Feed
```javascript
// services/feed-ranker.js
export class FeedRanker {
  constructor(db, engine) {
    this.db = db;
    this.engine = engine;
  }
  
  async getFeed(viewerId, cursor, limit = 20) {
    // Get viewer's visibility score (affects what they can see)
    const viewer = await this.db.getUser(viewerId);
    
    // Fetch candidate posts (recent, from followed + discovery)
    const candidates = await this.db.getFeedCandidates(viewerId, cursor, limit * 3);
    
    // Score and rank via Rust engine
    const ranked = await this.engine.rankFeedItems(
      viewerId,
      viewer.visibility_score,
      candidates
    );
    
    // Apply visibility filter: users see content from their tier and below
    // Plus a window into higher tiers (aspirational content)
    const filtered = ranked.filter(item => 
      item.author_visibility <= viewer.visibility_score * 1.5 + 0.2
    );
    
    return filtered.slice(0, limit);
  }
}
```

### Rust Engine Bindings
```javascript
// engine/bindings.js
import { createRequire } from "module";
const require = createRequire(import.meta.url);

// Load native module (built by napi-rs)
const engine = require("../../engine/engine-ffi/index.node");

export const predictionEngine = {
  calculateVisibility(userId, predictions) {
    return engine.calculateVisibilityScore(userId, predictions);
  },
  
  resolveMarket(marketId, outcome) {
    return engine.resolveMarket(marketId, outcome);
  },
  
  rankFeedItems(viewerId, viewerVisibility, items) {
    return engine.getFeedRankings(viewerId, viewerVisibility, items);
  },
  
  recordPrediction(userId, prediction) {
    return engine.recordPrediction(userId, prediction);
  }
};
```

## Authentication Flow

```javascript
// middleware/auth.js
import jwt from "@fastify/jwt";

export async function authPlugin(fastify) {
  await fastify.register(jwt, {
    secret: process.env.JWT_SECRET,
    sign: { expiresIn: "15m" }
  });
  
  fastify.decorate("authenticate", async (request, reply) => {
    try {
      await request.jwtVerify();
      // Attach fresh visibility score
      const user = await fastify.db.getUser(request.user.id);
      request.user.visibility_score = user.visibility_score;
    } catch (err) {
      reply.code(401).send({ error: "Unauthorized" });
    }
  });
}
```

## WebSocket Subscriptions

```javascript
// routes/websocket.js
export default async function wsRoutes(fastify) {
  fastify.get("/ws", { websocket: true }, (socket, request) => {
    const subscriptions = new Set();
    
    socket.on("message", async (msg) => {
      const { action, channel } = JSON.parse(msg);
      
      if (action === "subscribe") {
        subscriptions.add(channel);
        fastify.ws.addToChannel(channel, socket);
      }
      
      if (action === "unsubscribe") {
        subscriptions.delete(channel);
        fastify.ws.removeFromChannel(channel, socket);
      }
    });
    
    socket.on("close", () => {
      subscriptions.forEach(ch => fastify.ws.removeFromChannel(ch, socket));
    });
  });
}
```

## Anti-Gaming Measures

1. **Rate limiting**: Max predictions per hour
2. **Stake limits**: Based on visibility tier
3. **Sybil detection**: Behavioral clustering
4. **Delayed scoring**: Prevents last-second manipulation

## Handoff Protocol

Receive from:
- **Architect**: API contracts, data flow specs
- **Frontend**: Endpoint requirements

Hand off to:
- **Engine**: When scoring logic needs adjustment
- **Data**: When schema changes are needed
- **Test**: When API endpoints need coverage
