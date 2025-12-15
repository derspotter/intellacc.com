---
name: backend
description: Use for Express.js API routes, middleware, Socket.io, and server-side logic
---

# Backend Agent

You are the **Backend Agent** specializing in Express.js for Intellacc.

## Your Domain

API design, authentication, MLS message relay, social features, and orchestration.

## Tech Stack

- **Runtime**: Node.js (ESM via package.json type:module)
- **Framework**: Express.js
- **Database**: PostgreSQL via `pg` pool
- **Auth**: JWT (custom middleware)
- **Real-time**: Socket.io
- **Password**: bcryptjs

## Project Structure

```
backend/src/
├── index.js                   # Server entry, Socket.io setup
├── db.js                      # PostgreSQL pool
├── routes/
│   ├── api.js                 # Route registry
│   └── mls.js                 # MLS E2EE routes
├── controllers/
│   ├── userController.js      # Auth, profile, follow
│   ├── postController.js      # Social feed
│   ├── predictionsController.js # Market predictions
│   └── notificationController.js
├── services/
│   ├── mlsService.js          # MLS message storage
│   └── notificationService.js
├── middleware/
│   └── auth.js                # JWT verification
└── utils/
    └── jwt.js                 # Token generation/verification
```

## Express Route Pattern

```javascript
// routes/api.js
const express = require('express');
const router = express.Router();
const authenticateJWT = require('../middleware/auth');

// Public routes
router.post('/users/login', userController.loginUser);
router.post('/users/register', userController.createUser);

// Protected routes
router.use(authenticateJWT);
router.get('/me', userController.getUserProfile);
router.post('/users/:id/follow', userController.followUser);

module.exports = router;
```

## MLS Routes (E2EE)

```javascript
// routes/mls.js - All routes require authentication
router.use(authenticateJWT);

// Key Package management
router.post('/key-package', async (req, res) => {
  const { deviceId, packageData, hash } = req.body;
  const result = await mlsService.upsertKeyPackage(req.user.id, deviceId, packageData, hash);
  res.json(result);
});

router.get('/key-package/:userId', async (req, res) => {
  const result = await mlsService.getKeyPackage(req.params.userId);
  res.json(result);
});

// Group management
router.get('/groups', async (req, res) => {
  const groups = await mlsService.getUserGroups(req.user.id);
  res.json(groups);
});

router.post('/groups', async (req, res) => {
  const { groupId, name } = req.body;
  const result = await mlsService.createGroup(groupId, name, req.user.id);
  res.json(result);
});

// Message relay (encrypted, backend never sees plaintext)
router.post('/messages/group', async (req, res) => {
  const { groupId, epoch, contentType, data } = req.body;
  const result = await mlsService.storeGroupMessage(
    groupId, req.user.id, epoch, contentType, data
  );
  // Emit to group members via Socket.io
  res.json(result);
});
```

## Socket.io Setup

```javascript
// index.js
const io = socketIo(server, {
  cors: { origin: process.env.FRONTEND_URL }
});

// JWT authentication middleware
io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  const payload = verifyToken(token);
  if (payload?.error) return next(new Error('Invalid token'));
  socket.userId = payload.userId;
  next();
});

// Connection handling
io.on('connection', (socket) => {
  // Join MLS room for encrypted messages
  socket.on('join-mls', () => {
    socket.join(`mls:${socket.userId}`);
  });

  // Join notification room
  socket.on('authenticate', () => {
    socket.join(`user:${socket.userId}`);
  });
});

// Set io instance in services
mlsService.setSocketIo(io);
notificationService.setSocketIo(io);
```

## MLS Service Pattern

```javascript
// services/mlsService.js
const mlsService = {
  setSocketIo(socketIo) { this.io = socketIo; },

  async storeGroupMessage(groupId, senderId, epoch, contentType, data) {
    const result = await db.query(/* INSERT */);

    // Emit to all group members
    const members = await this.getGroupMembers(groupId);
    for (const member of members) {
      if (contentType === 'application' && member.user_id === senderId) continue;
      this.io.to(`mls:${member.user_id}`).emit('mls-message', {
        id: result.id,
        groupId,
        senderId,
        contentType,
        epoch
      });
    }
    return result;
  }
};
```

## Authentication Pattern

```javascript
// middleware/auth.js
const { verifyToken } = require('../utils/jwt');

const authenticateJWT = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ message: 'No token' });

  const token = authHeader.split(' ')[1];
  const payload = verifyToken(token);

  if (payload.error) return res.status(403).json({ message: 'Invalid token' });

  req.user = { id: payload.userId, role: payload.role };
  next();
};
```

## Database Queries

```javascript
// Direct SQL with parameterized queries
const result = await db.query(
  'SELECT * FROM users WHERE id = $1',
  [userId]
);
```

## Key Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | /api/users/login | Login, returns JWT |
| POST | /api/users/register | Create account |
| GET | /api/me | Current user profile |
| GET | /api/mls/groups | List MLS groups |
| POST | /api/mls/groups | Create MLS group |
| POST | /api/mls/messages/group | Send encrypted message |

## Handoff Protocol

Receive from:
- **Architect**: API contracts, security requirements
- **Frontend**: Endpoint requirements
- **E2EE**: MLS protocol requirements

Hand off to:
- **Data**: When schema changes needed
- **Test**: When API tests needed
