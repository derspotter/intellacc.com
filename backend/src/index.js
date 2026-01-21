const express = require('express');
const { Pool } = require('pg');
const http = require('http');
const socketIo = require('socket.io');
const { verifyToken } = require('./utils/jwt');
const notificationService = require('./services/notificationService');
const passwordResetService = require('./services/passwordResetService');

const app = express();
const port = process.env.NODE_PORT || 3000;

// PostgreSQL Pool
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// Create HTTP server
const server = http.createServer(app);

// Initialize Socket.IO with restricted CORS
const allowedOrigins = process.env.FRONTEND_URL ? [process.env.FRONTEND_URL] : ['http://localhost:5173'];
const io = socketIo(server, {
  cors: {
    origin: allowedOrigins,
    methods: ["GET", "POST"]
  }
});

// Authenticate socket connections with JWT
io.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth?.token || socket.handshake.query?.token;
    if (!token) return next(new Error('Authentication required'));
    const payload = verifyToken(token);
    if (payload?.error) return next(new Error('Invalid token'));

    const userId = payload.userId;
    const result = await pool.query('SELECT password_changed_at FROM users WHERE id = $1', [userId]);
    if (result.rows.length === 0) return next(new Error('Invalid token'));

    const passwordChangedAt = result.rows[0].password_changed_at;
    if (passwordChangedAt && payload.iat) {
      const tokenIssuedAt = new Date(payload.iat * 1000);
      if (tokenIssuedAt < new Date(passwordChangedAt)) {
        return next(new Error('Token revoked'));
      }
    }

    socket.userId = userId;
    next();
  } catch (err) {
    next(new Error('Invalid token'));
  }
});

// Set Socket.IO instance in notification service
notificationService.setSocketIo(io);
passwordResetService.setSocketIo(io);

// Set Socket.IO instance in MLS service
const mlsService = require('./services/mlsService');
mlsService.setSocketIo(io);

// Socket.IO logic
io.on('connection', (socket) => {
  console.log(`[Socket.IO] Connection handler. userId: ${socket.userId}`);

  socket.on('test-message', (data) => {
    console.log('Received test message:', data);
    io.emit('broadcast', {
      type: 'echo',
      originalMessage: data,
      timestamp: new Date().toISOString()
    });
  });

  // Join predictions room
  socket.on('join-predictions', () => {
    socket.join('predictions');
    console.log('User joined predictions room');
  });

  // Join profile room (for personalized updates)
  socket.on('join-profile', () => {
    if (socket.userId) {
      socket.join(`user-${socket.userId}`);
      console.log(`User ${socket.userId} joined their profile room`);
    }
  });

  // Join user notification room
  socket.on('authenticate', () => {
    if (socket.userId) {
      socket.join(`user:${socket.userId}`);
      console.log(`User ${socket.userId} authenticated for notifications`);
    }
  });

  // Join messaging room for real-time message delivery
  socket.on('join-messaging', () => {
    if (socket.userId) {
      socket.join(`messaging:${socket.userId}`);
      console.log(`User ${socket.userId} joined messaging room`);
    }
  });

  // Join MLS room for E2EE message delivery
  socket.on('join-mls', () => {
    if (socket.userId) {
      socket.join(`mls:${socket.userId}`);
      console.log(`[MLS] User ${socket.userId} joined MLS room`);
    }
  });

  socket.on('disconnect', () => {
    console.log(`User disconnected: ${socket.userId}`);
  });
});

// Middleware
app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf;
  }
}));

// Background worker for delayed password resets
passwordResetService.startResetWorker();

// Security headers
app.use((req, res, next) => {
  try {
    const csp = [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
      `connect-src 'self' ${process.env.FRONTEND_URL || ''}`.trim(),
      "img-src 'self' data:",
      "style-src 'self' 'unsafe-inline'",
      "frame-ancestors 'none'"
    ].filter(Boolean).join('; ');
    res.setHeader('Content-Security-Policy', csp);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  } catch {}
  next();
});

// Example Route
app.get('/', async (req, res) => {
  try {
    const client = await pool.connect();
    const result = await client.query('SELECT NOW()');
    res.send(`Intellacc Backend Running. Database Time: ${result.rows[0].now}`);
    client.release();
  } catch (err) {
    console.error(err);
    res.status(500).send('Server Error');
  }
});

// API Routes
app.use('/api', require('./routes/api'));

// Attach io instance to app for controllers to use
app.set('io', io);

// Start server only when run directly (not when imported for testing)
const PORT = process.env.PORT || 3000;
if (require.main === module) {
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running with Socket.IO on port ${PORT}`);
  });
}

module.exports = { app, server, io };
