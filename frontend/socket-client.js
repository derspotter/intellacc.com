// socket-client.js
import van from "./van-1.5.3.min.js";
import { io } from "https://cdn.skypack.dev/socket.io-client@4.8.1";

// Create reactive state for socket messages
const socketMessages = van.state([]);
const isConnected = van.state(false);

// Use relative URL for the socket connection to work in any environment
const socket = io("/", {
  path: "/socket.io",
  transports: ["websocket"],
  reconnection: true,
});

// Custom event callbacks that other components can subscribe to
const socketEventHandlers = {
  newPost: [],
  newPrediction: [],
  predictionResolved: [],
  newBet: []
};

// Register a handler for a specific socket event
export function onSocketEvent(eventName, callback) {
  if (eventName in socketEventHandlers) {
    socketEventHandlers[eventName].push(callback);
    return true;
  }
  return false;
}

// Remove a handler for a specific socket event
export function offSocketEvent(eventName, callback) {
  if (eventName in socketEventHandlers && callback) {
    socketEventHandlers[eventName] = socketEventHandlers[eventName]
      .filter(handler => handler !== callback);
    return true;
  }
  return false;
}

// Join a specific room (used for predictions, profile, etc.)
export function joinRoom(roomName, userId = null) {
  if (isConnected.val) {
    if (roomName === 'profile' && userId) {
      socket.emit('join-profile', userId);
      return true;
    } else if (roomName === 'predictions') {
      socket.emit('join-predictions');
      return true;
    }
  }
  return false;
}

// On connect, setup connection and join necessary rooms
socket.on("connect", () => {
  console.log("Connected to Socket.IO server!");
  isConnected.val = true;
  
  // Send a test message
  socket.emit("test-message", {
    message: "Hello from VanJS client!",
    timestamp: new Date().toISOString()
  });
  
  // Get user ID from localStorage if available
  const token = localStorage.getItem('token');
  if (token) {
    try {
      // Extract user ID from token (in a real app you would properly decode the JWT)
      const payload = JSON.parse(atob(token.split('.')[1]));
      if (payload && payload.userId) {
        joinRoom('profile', payload.userId);
      }
    } catch (e) {
      console.error('Error decoding token:', e);
    }
  }
  
  // Join predictions room for real-time updates
  joinRoom('predictions');
});

// Handle general broadcast messages
socket.on("broadcast", (data) => {
  socketMessages.val = [...socketMessages.val, `Broadcast: ${JSON.stringify(data)}`];
});

// Handle new posts
socket.on("newPost", (data) => {
  socketMessages.val = [...socketMessages.val, `New Post: ${JSON.stringify(data)}`];
  // Notify all registered handlers
  socketEventHandlers.newPost.forEach(handler => handler(data));
});

// Handle new predictions
socket.on("newPrediction", (data) => {
  socketMessages.val = [...socketMessages.val, `New Prediction: ${JSON.stringify(data)}`];
  // Notify all registered handlers
  socketEventHandlers.newPrediction.forEach(handler => handler(data));
});

// Handle prediction resolved events
socket.on("predictionResolved", (data) => {
  socketMessages.val = [...socketMessages.val, `Prediction Resolved: ${JSON.stringify(data)}`];
  // Notify all registered handlers
  socketEventHandlers.predictionResolved.forEach(handler => handler(data));
});

// Handle new bet events
socket.on("newBet", (data) => {
  socketMessages.val = [...socketMessages.val, `New Bet: ${JSON.stringify(data)}`];
  // Notify all registered handlers
  socketEventHandlers.newBet.forEach(handler => handler(data));
});

// Handle connection errors
socket.on("connect_error", (error) => {
  console.log("Connection error:", error.message);
  isConnected.val = false;
  socketMessages.val = [...socketMessages.val, `Error: ${error.message}`];
});

// On disconnect
socket.on("disconnect", () => {
  console.log("Disconnected from server");
  isConnected.val = false;
  socketMessages.val = [...socketMessages.val, "Disconnected from server"];
});

// Export the socket instance and states for component use
export { socket, socketMessages, isConnected };