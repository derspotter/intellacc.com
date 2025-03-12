const express = require('express');
const { Pool } = require('pg');
const http = require('http'); // Import the http module
const socketIo = require('socket.io'); // Import Socket.IO

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

// Attach io instance to app
app.set('socketio', io);

server.listen(port, () => {
  console.log(`Intellacc Backend running on port ${port}`);
});
