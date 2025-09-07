// test_socket_auth.js
// Minimal Socket.IO client test for JWT authentication and room join

const io = require('socket.io-client');
const jwt = require('jsonwebtoken');

const SERVER_URL = 'http://localhost:3000'; // Adjust if needed
const JWT_SECRET = process.env.JWT_SECRET || 'your_jwt_secret'; // Use your actual secret
const myUserId = 123; // Replace with a valid userId from your DB
const otherUserId = 999; // Replace with a different userId

// Generate a valid JWT for myUserId
const validToken = jwt.sign({ userId: myUserId }, JWT_SECRET, { expiresIn: '1h' });
// Generate an invalid JWT
const invalidToken = 'invalid.token.value';

function testConnection(token, description, joinOtherRoom = false) {
  console.log(`\n--- ${description} ---`);
  const socket = io(SERVER_URL, {
    auth: { token },
    transports: ['websocket']
  });

  socket.on('connect', () => {
    console.log('Connected as userId:', myUserId);
    socket.emit('join-messaging'); // Should succeed
    if (joinOtherRoom) {
      // Try to join another user's room (should not work)
      socket.emit('join-messaging', otherUserId);
    }
    setTimeout(() => socket.disconnect(), 1000);
  });

  socket.on('connect_error', (err) => {
    console.log('Connection error:', err.message);
  });

  socket.on('disconnect', () => {
    console.log('Disconnected');
  });
}

// Test with valid JWT
setTimeout(() => testConnection(validToken, 'Valid JWT, own room'), 100);
// Test with invalid JWT
setTimeout(() => testConnection(invalidToken, 'Invalid JWT'), 2000);
// Test with valid JWT, try to join other user room
setTimeout(() => testConnection(validToken, 'Valid JWT, try to join other user room', true), 4000);
