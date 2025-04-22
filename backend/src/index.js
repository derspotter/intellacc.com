const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const socketMiddleware = require('./middleware/socketMiddleware');
const db = require('./db');

const app = express();
const port = process.env.NODE_PORT || 3000;

// PostgreSQL connection is handled by db module

// Create HTTP server
const server = http.createServer(app);

// Initialize Socket.IO with proper CORS configuration
const io = socketIo(server, {
  cors: {
    origin: "*", // Allow all origins for testing
    methods: ["GET", "POST", "PUT", "DELETE", "PATCH"],
    credentials: true
  },
  // Support all transport methods
  transports: ['websocket', 'polling'],
  // Improve connection reliability
  pingTimeout: 30000,
  pingInterval: 25000
});

// Store the io instance globally to easily access it for debugging
global.socketIoInstance = io;

console.log('Socket.IO initialized successfully');

// Socket.IO connection handler
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

  socket.on('disconnect', () => {
    console.log('User disconnected');
  });
});

// Middleware registration - order matters!
// 1. Basic middleware
app.use(express.json());

// 2. Apply Socket.IO middleware early in the pipeline
console.log('Setting up Socket.IO middleware');
const socketMw = socketMiddleware(io);
app.use(socketMw);

// 3. Store io on app for reliable access
console.log('Storing Socket.IO instance on app');
app.set('io', io);

// Routes
app.use('/api', require('./routes/api'));

// Example Route
app.get('/', async (req, res) => {
  try {
    const result = await db.query('SELECT NOW()');
    res.send(`Intellacc Backend Running. Database Time: ${result.rows[0].now}`);
  } catch (err) {
    console.error(err);
    res.status(500).send('Server Error');
  }
});

// Start server
server.listen(port, () => {
  console.log(`Intellacc Backend running on port ${port}`);
});
