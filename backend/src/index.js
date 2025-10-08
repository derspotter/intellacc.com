const express = require('express');
const { Pool } = require('pg');
const http = require('http'); // Import the http module
const socketIo = require('socket.io'); // Import Socket.IO
const { verifyToken } = require('./utils/jwt');
const notificationService = require('./services/notificationService');

const app = express();
const DEFAULT_PORT = Number(process.env.PORT || process.env.NODE_PORT || 3000);

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
io.use((socket, next) => {
  try {
    const token = socket.handshake.auth?.token || socket.handshake.query?.token;
    if (!token) return next(new Error('Authentication required'));
    const payload = verifyToken(token);
    if (payload?.error) return next(new Error('Invalid token'));
    socket.userId = payload.userId;
    next();
  } catch (err) {
    next(new Error('Invalid token'));
  }
});

// Set Socket.IO instance in notification service
notificationService.setSocketIo(io);

// Set Socket.IO instance in messaging service
const messagingService = require('./services/messagingService');
messagingService.setSocketIo(io);

// Socket.IO logic
io.on('connection', (socket) => {
  console.log('A user connected');

  socket.on('test-message', (data) => {
    console.log('Received test message:', data);
    // Echo back to all connected clients
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
  
  // Join profile room (for personalized updates) - derive from authenticated socket
  socket.on('join-profile', () => {
    if (socket.userId) {
      socket.join(`user-${socket.userId}`);
      console.log(`User ${socket.userId} joined their profile room`);
    }
  });

  // Join user notification room (no client-provided id)
  socket.on('authenticate', () => {
    if (socket.userId) {
      socket.join(`user:${socket.userId}`);
      console.log(`User ${socket.userId} authenticated for notifications`);
    }
  });

  // Join messaging room for real-time message delivery (no client-provided id)
  socket.on('join-messaging', () => {
    if (socket.userId) {
      socket.join(`messaging:${socket.userId}`);
      console.log(`User ${socket.userId} joined messaging room`);
    }
  });

  // Handle typing indicators for messaging (use authenticated userId)
  socket.on('typing-start', async (data) => {
    try {
      const { conversationId } = data || {};
      if (!conversationId || !socket.userId) return;
      const messagingService = require('./services/messagingService');
      const isParticipant = await messagingService.checkConversationMembership(conversationId, socket.userId);
      if (!isParticipant) return;
      socket.to(`conversation:${conversationId}`).emit('user-typing', {
        conversationId,
        userId: socket.userId,
        isTyping: true
      });
    } catch {}
  });

  socket.on('typing-stop', async (data) => {
    try {
      const { conversationId } = data || {};
      if (!conversationId || !socket.userId) return;
      const messagingService = require('./services/messagingService');
      const isParticipant = await messagingService.checkConversationMembership(conversationId, socket.userId);
      if (!isParticipant) return;
      socket.to(`conversation:${conversationId}`).emit('user-typing', {
        conversationId,
        userId: socket.userId,
        isTyping: false
      });
    } catch {}
  });

  // Join specific conversation room for typing indicators (validate membership)
  socket.on('join-conversation', async (conversationId) => {
    try {
      if (!conversationId || !socket.userId) return;
      const messagingService = require('./services/messagingService');
      const isParticipant = await messagingService.checkConversationMembership(conversationId, socket.userId);
      if (isParticipant) {
        socket.join(`conversation:${conversationId}`);
        console.log(`User ${socket.userId} joined conversation room: ${conversationId}`);
      }
    } catch {}
  });

  // Leave conversation room
  socket.on('leave-conversation', (conversationId) => {
    if (conversationId) {
      socket.leave(`conversation:${conversationId}`);
      console.log(`Socket left conversation room: ${conversationId}`);
    }
  });

  socket.on('disconnect', () => {
    console.log('User disconnected');
  });
});

// Middleware
app.use(express.json());

// Security headers (baseline hardening)
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

// Additional Routes
app.use('/api', require('./routes/api'));

// Attach io instance to app for controllers to use
app.set('io', io);

// IMPORTANT FIX: Use the server with Socket.IO attached instead of app.listen
const startServer = (port = DEFAULT_PORT) => new Promise((resolve, reject) => {
  if (server.listening) {
    return resolve(server);
  }

  const handleError = (err) => {
    server.off('error', handleError);
    reject(err);
  };

  server.once('error', handleError);
  server.listen(port, '0.0.0.0', () => {
    server.off('error', handleError);
    console.log(`Server running with Socket.IO on port ${port}`);
    resolve(server);
  });
});

if (require.main === module) {
  startServer().catch((err) => {
    console.error('Failed to start server:', err);
    process.exitCode = 1;
  });
}

module.exports = {
  app,
  server,
  io,
  pool,
  startServer
};
