const express = require('express');
const { Pool } = require('pg');
const http = require('http'); // Import the http module
const socketIo = require('socket.io'); // Import Socket.IO
const notificationService = require('./services/notificationService');

const app = express();
const port = process.env.NODE_PORT || 3000;

// PostgreSQL Pool
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// Create HTTP server
const server = http.createServer(app);

// Initialize Socket.IO
const io = socketIo(server, {
  cors: {
    origin: "*", // Allow all origins for testing
    methods: ["GET", "POST"]
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
  
  // Join profile room (for personalized updates)
  socket.on('join-profile', (userId) => {
    if (userId) {
      socket.join(`user-${userId}`);
      console.log(`User ${userId} joined their profile room`);
    }
  });

  // Join user notification room
  socket.on('authenticate', (userId) => {
    if (userId) {
      socket.join(`user:${userId}`);
      console.log(`User ${userId} authenticated for notifications`);
    }
  });

  // Join messaging room for real-time message delivery
  socket.on('join-messaging', (userId) => {
    if (userId) {
      socket.join(`messaging:${userId}`);
      console.log(`User ${userId} joined messaging room`);
    }
  });

  // Handle typing indicators for messaging
  socket.on('typing-start', (data) => {
    const { conversationId, userId } = data;
    if (conversationId && userId) {
      socket.to(`conversation:${conversationId}`).emit('user-typing', {
        conversationId,
        userId,
        isTyping: true
      });
    }
  });

  socket.on('typing-stop', (data) => {
    const { conversationId, userId } = data;
    if (conversationId && userId) {
      socket.to(`conversation:${conversationId}`).emit('user-typing', {
        conversationId,
        userId,
        isTyping: false
      });
    }
  });

  // Join specific conversation room for typing indicators
  socket.on('join-conversation', (conversationId) => {
    if (conversationId) {
      socket.join(`conversation:${conversationId}`);
      console.log(`Socket joined conversation room: ${conversationId}`);
    }
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
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running with Socket.IO on port ${PORT}`);
});
