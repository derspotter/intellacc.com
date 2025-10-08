// src/services/socket.js
import van from 'vanjs-core';
import io from 'socket.io-client';
import { getToken, getTokenData } from './auth';
import store from '../store';

// Create reactive state for socket
export const socketState = {
  connected: van.state(false),
  messages: van.state([])
};

// Custom event handlers registry
const eventHandlers = {
  // Core connection events
  connect: [],
  disconnect: [],

  // Domain events
  newPost: [],
  newPrediction: [],
  predictionResolved: [],
  newBet: [],
  marketUpdate: [],
  notification: [],
  // Messaging events
  newMessage: [],
  messageSent: [],
  messagesRead: [],
  messageDeleted: [],
  'user-typing': [],
  'mls:commit': [],
  'mls:message': [],
  'mls:history-secret': [],
  'mls:migration': []
};

/**
 * Register a handler for a socket event
 * @param {string} eventName - The name of the event to listen for
 * @param {Function} handler - The handler function to call when the event is received
 * @returns {Function} - Function to remove the handler
 */
export function registerSocketEventHandler(eventName, handler) {
  if (!eventHandlers[eventName]) {
    eventHandlers[eventName] = [];
  }
  
  eventHandlers[eventName].push(handler);
  
  // Return function to unregister
  return () => {
    const index = eventHandlers[eventName].indexOf(handler);
    if (index !== -1) {
      eventHandlers[eventName].splice(index, 1);
    }
  };
}

// Socket.IO instance
let socket = null;
// Queue for emits attempted while disconnected
const _emitQueue = [];
let messagingStorePromise = null;

async function getMessagingStore() {
  if (!messagingStorePromise) {
    messagingStorePromise = import('../stores/messagingStore.js').then(mod => mod.default);
  }
  return messagingStorePromise;
}

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
       * 
      * Frontend: 5173 (Vite)
       * Backend: 3000 (Socket.IO server)
       */
      // Use origin-based connection to work in both dev and production
      // In development, use same origin to leverage Vite proxy
      const socketUrl = window.location.origin;
      
      if (import.meta?.env?.DEV) console.log('Creating Socket.IO connection to:', socketUrl);
      
      const token = getToken();
      socket = io(socketUrl, {
        path: '/socket.io',
        transports: ['websocket'],
        reconnection: true,
        reconnectionAttempts: 5,
        reconnectionDelay: 1000,
        timeout: 5000, // Add a timeout to fail faster
        auth: token ? { token } : undefined
      });

      // Ensure latest token is used on reconnect attempts
      if (socket && socket.io) {
        socket.io.on('reconnect_attempt', () => {
          const freshToken = getToken();
          socket.auth = freshToken ? { token: freshToken } : undefined;
        });
      }
      
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
    if (import.meta?.env?.DEV) console.log('Connected to Socket.IO server!');
    socketState.connected.val = true;

    // Notify custom handlers
    notifyHandlers('connect');
    
    // Send test message
    socket.emit('test-message', {
      message: 'Hello from client!',
      timestamp: new Date().toISOString()
    });
    
    // Join rooms based on authenticated user
    joinUserRooms();

    // Flush any queued emits from offline period
    try {
      while (_emitQueue.length > 0) {
        const { event, data } = _emitQueue.shift();
        socket.emit(event, data);
      }
    } catch (e) {
      // leave remaining items for next connect
    }
  });
  
  // Disconnection event
  socket.on('disconnect', () => {
    if (import.meta?.env?.DEV) console.log('Disconnected from Socket.IO server');
    socketState.connected.val = false;

    // Notify custom handlers
    notifyHandlers('disconnect');
    
    // Add disconnect message
    addMessage('Disconnected from server');
  });
  
  // Connection error event
  socket.on('connect_error', (error) => {
    if (import.meta?.env?.DEV) console.log('Connection error:', error.message);
    socketState.connected.val = false;
    
    // Add error message
    addMessage(`Connection error: ${error.message}`);
  });
  
  socket.on('mls:commit', async (payload) => {
    if (import.meta?.env?.DEV) console.debug('MLS commit received', payload);
    try {
      const store = await getMessagingStore();
      if (payload?.conversationId != null) {
        store.markConversationStale(payload.conversationId);
        store.setMlsPending(payload.conversationId, {
          reason: 'commit',
          senderClientId: payload?.senderClientId ?? null,
          epoch: payload?.epoch ?? null
        });
      }
    } catch (err) {
      if (import.meta?.env?.DEV) console.warn('Failed to mark conversation stale for MLS commit', err);
    }
    notifyHandlers('mls:commit', payload);
  });

  socket.on('mls:message', async (payload) => {
    if (import.meta?.env?.DEV) console.debug('MLS message received', payload);
    try {
      const store = await getMessagingStore();
      if (payload?.conversationId != null) {
        store.markConversationStale(payload.conversationId);
        store.setMlsPending(payload.conversationId, {
          reason: 'message',
          senderClientId: payload?.senderClientId ?? null,
          epoch: payload?.epoch ?? null
        });
      }
    } catch (err) {
      if (import.meta?.env?.DEV) console.warn('Failed to mark conversation stale for MLS message', err);
    }
    notifyHandlers('mls:message', payload);
  });

  socket.on('mls:history-secret', async (payload) => {
    if (import.meta?.env?.DEV) console.debug('MLS history secret received', payload);
    try {
      const store = await getMessagingStore();
      if (payload?.conversationId != null) {
        store.markConversationStale(payload.conversationId);
        store.setMlsPending(payload.conversationId, {
          reason: 'history-secret',
          senderClientId: payload?.senderClientId ?? null,
          epoch: payload?.epoch ?? null
        });
      }
    } catch (err) {
      if (import.meta?.env?.DEV) console.warn('Failed to process MLS history secret event', err);
    }
    notifyHandlers('mls:history-secret', payload);
  });

  socket.on('mls:migration', async (payload) => {
    if (import.meta?.env?.DEV) console.debug('MLS migration event received', payload);
    try {
      const store = await getMessagingStore();
      if (payload?.conversationId != null) {
        store.markConversationStale(payload.conversationId);
        store.setMlsPending(payload.conversationId, {
          reason: 'migration',
          encryptionMode: payload?.encryptionMode ?? 'mls',
          ciphersuite: payload?.ciphersuite ?? null
        });
        store.updateConversation(payload.conversationId, {
          encryptionMode: payload?.encryptionMode ?? 'mls',
          mlsMigrationEligible: false
        });
      }
    } catch (err) {
      if (import.meta?.env?.DEV) console.warn('Failed to process MLS migration event', err);
    }
    notifyHandlers('mls:migration', payload);
  });
  
  // Broadcast message event
  socket.on('broadcast', (data) => {
    if (import.meta?.env?.DEV) addMessage(`Broadcast: ${JSON.stringify(data)}`);
  });
  
  // We are no longer using socket for post updates
  // Socket is now reserved for notifications and other real-time features
  
  // New prediction event
  socket.on('newPrediction', (data) => {
    if (import.meta?.env?.DEV) addMessage(`New prediction: ${data.event || JSON.stringify(data)}`);
    
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
    if (import.meta?.env?.DEV) addMessage(`Prediction resolved: ${data.event || JSON.stringify(data)}`);
    
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
    if (import.meta?.env?.DEV) addMessage(`New bet: ${JSON.stringify(data)}`);
    
    // Refresh assigned predictions in store if available
    if (store.predictions) {
      store.predictions.actions.fetchAssignedPredictions();
      store.predictions.actions.fetchBettingStats();
    }
    
    // Notify registered handlers
    notifyHandlers('newBet', data);
  });
  
  // Market update event - real-time price changes
  socket.on('marketUpdate', (data) => {
    if (import.meta?.env?.DEV) console.log('📈 Market update received:', data);
    
    // Notify registered handlers for real-time UI updates
    notifyHandlers('marketUpdate', data);
  });
  
  // User-specific notification event
  socket.on('notification', (data) => {
    if (import.meta?.env?.DEV) addMessage(`Notification: ${data.message || JSON.stringify(data)}`);
    
    // Notify registered handlers
    notifyHandlers('notification', data);
  });

  // Messaging events
  socket.on('newMessage', (data) => {
    if (import.meta?.env?.DEV) console.log('[Socket] Received newMessage event:', data);
    notifyHandlers('newMessage', data);
  });

  socket.on('messageSent', (data) => {
    if (import.meta?.env?.DEV) console.log('[Socket] Received messageSent event:', data);
    notifyHandlers('messageSent', data);
  });

  socket.on('messagesRead', (data) => {
    if (import.meta?.env?.DEV) console.log('[Socket] Received messagesRead event:', data);
    notifyHandlers('messagesRead', data);
  });

  socket.on('messageDeleted', (data) => {
    if (import.meta?.env?.DEV) console.log('[Socket] Received messageDeleted event:', data);
    notifyHandlers('messageDeleted', data);
  });

  socket.on('user-typing', (data) => {
    if (import.meta?.env?.DEV) console.log('[Socket] Received user-typing event:', data);
    notifyHandlers('user-typing', data);
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
  if (import.meta?.env?.DEV) console.log('Joined predictions room');
  
  // Join user-specific room if authenticated
  const tokenData = getTokenData();
  if (tokenData && tokenData.userId) {
    // Server derives user id from JWT; do not pass userId from client
    socket.emit('join-profile');
    if (import.meta?.env?.DEV) console.log(`Requested join to user-${tokenData.userId} room`);
    
    // Authenticate for notifications (no userId param)
    socket.emit('authenticate');
    if (import.meta?.env?.DEV) console.log(`Authenticated for notifications as user ${tokenData.userId}`);

    // Join messaging room for real-time encrypted messaging
    socket.emit('join-messaging');
    if (import.meta?.env?.DEV) console.log(`Joined messaging room for user ${tokenData.userId}`);
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
    const item = { event, data };
    if (_emitQueue.length >= 50) _emitQueue.shift();
    _emitQueue.push(item);
    if (import.meta?.env?.DEV) console.warn('Socket not connected, queued emit:', event);
    return true; // queued successfully
  }
  
  socket.emit(event, data);
  return true;
}

/**
 * Disconnect the socket connection and clear state
 */
export function disconnect() {
  try {
    if (socket) {
      socket.disconnect();
    }
  } catch (e) {
    console.error('Error disconnecting socket:', e);
  } finally {
    socketState.connected.val = false;
  }
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
  joinRoom,
  disconnect
};
