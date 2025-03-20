// src/services/socket.js
import van from 'vanjs-core';
import io from 'socket.io-client';
import { getTokenData } from './auth';
import store from '../store';

// Create reactive state for socket
export const socketState = {
  connected: van.state(false),
  messages: van.state([])
};

// Custom event handlers registry
const eventHandlers = {
  newPost: [],
  newPrediction: [],
  predictionResolved: [],
  newBet: [],
  notification: []
};

// Socket.IO instance
let socket = null;

/**
 * Initialize Socket.IO connection
 */
export function initializeSocket() {
  // Check if we're in development mode
  const isDevelopment = 
    window.location.hostname === 'localhost' || 
    window.location.hostname === '127.0.0.1';
  
  // In development mode, only initialize if backend is available
  // This prevents connection errors when running frontend only
  if (isDevelopment) {
    // Test if backend is available first
    fetch('/api/health-check')
      .then(response => {
        if (response.ok) {
          createSocketConnection();
        } else {
          console.log('Backend not available, skipping socket connection');
        }
      })
      .catch(error => {
        console.log('Backend not available, skipping socket connection', error);
      });
  } else {
    // In production, always try to connect
    createSocketConnection();
  }
  
  return socket;
}

/**
 * Create the actual socket connection
 */
function createSocketConnection() {
  if (!socket) {
    try {
      /**
       * Socket.IO Connection Configuration
       * Frontend: 5173 (Vite)
       * Backend: 3000 (Socket.IO server)
       */
      socket = io('http://localhost:3000', {
        path: '/socket.io',
        transports: ['websocket'],
        reconnection: true,
        reconnectionAttempts: 5,
        reconnectionDelay: 1000,
        timeout: 5000 // Add a timeout to fail faster
      });
      
      // Set up event listeners
      setupSocketHandlers();
    } catch (error) {
      console.error('Failed to initialize socket:', error);
    }
  }
}

/**
 * Set up Socket.IO event handlers
 */
function setupSocketHandlers() {
  // Connection event
  socket.on('connect', () => {
    console.log('Connected to Socket.IO server!');
    socketState.connected.val = true;
    
    // Send test message
    socket.emit('test-message', {
      message: 'Hello from client!',
      timestamp: new Date().toISOString()
    });
    
    // Join rooms based on authenticated user
    joinUserRooms();
  });
  
  // Disconnection event
  socket.on('disconnect', () => {
    console.log('Disconnected from Socket.IO server');
    socketState.connected.val = false;
    
    // Add disconnect message
    addMessage('Disconnected from server');
  });
  
  // Connection error event
  socket.on('connect_error', (error) => {
    console.log('Connection error:', error.message);
    socketState.connected.val = false;
    
    // Add error message
    addMessage(`Connection error: ${error.message}`);
  });
  
  // Broadcast message event
  socket.on('broadcast', (data) => {
    addMessage(`Broadcast: ${JSON.stringify(data)}`);
  });
  
  // New post event
  socket.on('newPost', (data) => {
    addMessage(`New post: ${data.content || JSON.stringify(data)}`);
    
    // Update posts in store if available
    if (store.posts) {
      const posts = store.posts.state.posts.val;
      store.posts.state.posts.val = [data, ...posts];
    }
    
    // Notify registered handlers
    notifyHandlers('newPost', data);
  });
  
  // New prediction event
  socket.on('newPrediction', (data) => {
    addMessage(`New prediction: ${data.event || JSON.stringify(data)}`);
    
    // Update predictions in store if available
    if (store.predictions) {
      const predictions = store.predictions.state.predictions.val;
      store.predictions.state.predictions.val = [data, ...predictions];
    }
    
    // Notify registered handlers
    notifyHandlers('newPrediction', data);
  });
  
  // Prediction resolved event
  socket.on('predictionResolved', (data) => {
    addMessage(`Prediction resolved: ${data.event || JSON.stringify(data)}`);
    
    // Update prediction in store if available
    if (store.predictions) {
      const predictions = store.predictions.state.predictions.val;
      const updatedPredictions = predictions.map(p => 
        p.id === data.id ? { ...p, ...data } : p
      );
      store.predictions.state.predictions.val = updatedPredictions;
    }
    
    // Notify registered handlers
    notifyHandlers('predictionResolved', data);
  });
  
  // New bet event
  socket.on('newBet', (data) => {
    addMessage(`New bet: ${JSON.stringify(data)}`);
    
    // Refresh assigned predictions in store if available
    if (store.predictions) {
      store.predictions.actions.fetchAssignedPredictions();
      store.predictions.actions.fetchBettingStats();
    }
    
    // Notify registered handlers
    notifyHandlers('newBet', data);
  });
  
  // User-specific notification event
  socket.on('notification', (data) => {
    addMessage(`Notification: ${data.message || JSON.stringify(data)}`);
    
    // Notify registered handlers
    notifyHandlers('notification', data);
  });
}

/**
 * Add message to socket messages state
 * @param {string} message - Message text
 */
function addMessage(message) {
  socketState.messages.val = [...socketState.messages.val, message];
  
  // Keep only the last 50 messages to prevent memory issues
  if (socketState.messages.val.length > 50) {
    socketState.messages.val = socketState.messages.val.slice(-50);
  }
}

/**
 * Join user-specific rooms
 */
function joinUserRooms() {
  if (!socketState.connected.val) return;
  
  // Join predictions room
  socket.emit('join-predictions');
  console.log('Joined predictions room');
  
  // Join user-specific room if authenticated
  const tokenData = getTokenData();
  if (tokenData && tokenData.userId) {
    socket.emit('join-profile', tokenData.userId);
    console.log(`Joined user-${tokenData.userId} room`);
  }
}

/**
 * Register handler for socket event
 * @param {string} event - Event name
 * @param {Function} handler - Event handler
 * @returns {boolean} Registration success
 */
export function on(event, handler) {
  if (event in eventHandlers) {
    eventHandlers[event].push(handler);
    return true;
  }
  return false;
}

/**
 * Unregister handler for socket event
 * @param {string} event - Event name
 * @param {Function} handler - Event handler
 * @returns {boolean} Unregistration success
 */
export function off(event, handler) {
  if (event in eventHandlers && handler) {
    eventHandlers[event] = eventHandlers[event].filter(h => h !== handler);
    return true;
  }
  return false;
}

/**
 * Notify all registered handlers for an event
 * @param {string} event - Event name
 * @param {any} data - Event data
 */
function notifyHandlers(event, data) {
  if (event in eventHandlers) {
    eventHandlers[event].forEach(handler => {
      try {
        handler(data);
      } catch (error) {
        console.error(`Error in ${event} handler:`, error);
      }
    });
  }
}

/**
 * Send message to server
 * @param {string} event - Event name
 * @param {any} data - Event data
 */
export function emit(event, data) {
  if (!socketState.connected.val) {
    console.warn('Socket not connected, cannot emit:', event);
    return false;
  }
  
  socket.emit(event, data);
  return true;
}

/**
 * Join a specific room
 * @param {string} room - Room name
 * @param {any} data - Room data
 * @returns {boolean} Join success
 */
export function joinRoom(room, data = null) {
  if (!socketState.connected.val) {
    console.warn('Socket not connected, cannot join room:', room);
    return false;
  }
  
  if (room === 'predictions') {
    socket.emit('join-predictions');
    return true;
  } else if (room === 'profile' && data) {
    socket.emit('join-profile', data);
    return true;
  }
  
  return false;
}

// Export socket service
export default {
  state: socketState,
  initializeSocket,
  on,
  off,
  emit,
  joinRoom
};