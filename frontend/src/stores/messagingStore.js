// frontend/src/stores/messagingStore.js
// Central reactive store for messaging state management

import * as vanX from 'vanjs-ext';

/**
 * Central messaging store using VanX reactive patterns
 * Manages all messaging state with automatic reactivity
 */
const messagingStore = vanX.reactive({
  // Core state
  conversations: [],
  messagesByConversation: {}, // Use plain object instead of Map for VanX compatibility
  selectedConversationId: null,
  loading: false,
  error: '',
  
  // Typing indicators - use array instead of Set for VanX compatibility
  typingUsers: [],
  
  // New conversation form
  showNewConversation: false,
  newConversationUser: '',
  newMessage: '',
  
  // Search
  searchQuery: '',
  
  // Calculated fields will be added after store creation
  
  // Store methods for managing state
  setConversations(conversations) {
    messagingStore.conversations = [...conversations];
  },
  
  addConversation(conversation) {
    const exists = messagingStore.conversations.some(c => c.id === conversation.id);
    if (!exists) {
      messagingStore.conversations = [conversation, ...messagingStore.conversations];
    }
  },
  
  updateConversation(conversationId, updates) {
    messagingStore.conversations = messagingStore.conversations.map(conv =>
      conv.id === conversationId ? { ...conv, ...updates } : conv
    );
  },
  
  setMessages(conversationId, messages) {
    // Create new object to trigger reactivity
    messagingStore.messagesByConversation = {
      ...messagingStore.messagesByConversation,
      [conversationId]: [...messages]
    };
  },
  
  addMessage(conversationId, message) {
    const existingMessages = messagingStore.messagesByConversation[conversationId] || [];
    
    // Check for duplicates by ID
    const messageExists = existingMessages.some(m => m.id === message.id);
    if (messageExists) {
      console.log(`Message ${message.id} already exists, skipping`);
      return false;
    }
    
    // Add message in chronological order
    const newMessages = [...existingMessages];
    const insertIndex = newMessages.findIndex(m => new Date(m.created_at) > new Date(message.created_at));
    
    if (insertIndex === -1) {
      newMessages.push(message);
    } else {
      newMessages.splice(insertIndex, 0, message);
    }
    
    // Update object to trigger reactivity
    messagingStore.messagesByConversation = {
      ...messagingStore.messagesByConversation,
      [conversationId]: newMessages
    };
    
    console.log(`Added message ${message.id} to conversation ${conversationId}`);
    return true;
  },
  
  updateMessage(messageId, updates) {
    // Find and update message across all conversations
    for (const [conversationId, messages] of Object.entries(messagingStore.messagesByConversation)) {
      const messageIndex = messages.findIndex(m => m.id === messageId);
      if (messageIndex !== -1) {
        const newMessages = [...messages];
        newMessages[messageIndex] = { ...newMessages[messageIndex], ...updates };
        
        messagingStore.messagesByConversation = {
          ...messagingStore.messagesByConversation,
          [conversationId]: newMessages
        };
        break;
      }
    }
  },
  
  removeMessage(messageId) {
    // Find and remove message across all conversations
    for (const [conversationId, messages] of Object.entries(messagingStore.messagesByConversation)) {
      const filteredMessages = messages.filter(m => m.id !== messageId);
      if (filteredMessages.length !== messages.length) {
        messagingStore.messagesByConversation = {
          ...messagingStore.messagesByConversation,
          [conversationId]: filteredMessages
        };
        break;
      }
    }
  },
  
  markMessagesAsRead(messageIds) {
    const now = new Date().toISOString();
    
    // Update read status for specified messages
    for (const [conversationId, messages] of Object.entries(messagingStore.messagesByConversation)) {
      let updated = false;
      const newMessages = messages.map(message => {
        if (messageIds.includes(message.id)) {
          updated = true;
          return { ...message, read_at: now };
        }
        return message;
      });
      
      if (updated) {
        messagingStore.messagesByConversation = {
          ...messagingStore.messagesByConversation,
          [conversationId]: newMessages
        };
      }
    }
  },
  
  selectConversation(conversationId) {
    messagingStore.selectedConversationId = conversationId;
    // Clear typing indicators when switching conversations
    messagingStore.typingUsers = [];
  },
  
  clearSelection() {
    messagingStore.selectedConversationId = null;
    messagingStore.typingUsers = [];
  },
  
  setTypingUsers(userIds) {
    messagingStore.typingUsers = [...userIds];
  },
  
  addTypingUser(userId) {
    if (!messagingStore.typingUsers.includes(userId)) {
      messagingStore.typingUsers = [...messagingStore.typingUsers, userId];
    }
  },
  
  removeTypingUser(userId) {
    messagingStore.typingUsers = messagingStore.typingUsers.filter(id => id !== userId);
  },
  
  setLoading(loading) {
    messagingStore.loading = loading;
  },
  
  setError(error) {
    messagingStore.error = error;
  },
  
  clearError() {
    messagingStore.error = '';
  },
  
  setShowNewConversation(show) {
    messagingStore.showNewConversation = show;
  },
  
  setNewConversationUser(user) {
    messagingStore.newConversationUser = user;
  },
  
  setNewMessage(message) {
    messagingStore.newMessage = message;
  },
  
  setSearchQuery(query) {
    messagingStore.searchQuery = query;
  },
  
  clearCache() {
    messagingStore.conversations = [];
    messagingStore.messagesByConversation = {};
    messagingStore.selectedConversationId = null;
    messagingStore.typingUsers = [];
    messagingStore.error = '';
  }
});

// Helper function for getting other user name
function getOtherUserName(conversation) {
  try {
    const token = localStorage.getItem('token');
    if (!token) return 'Unknown User';
    
    const payload = JSON.parse(atob(token.split('.')[1]));
    const userId = payload.userId;
    
    return conversation.participant_1 === userId 
      ? conversation.participant_2_username 
      : conversation.participant_1_username;
  } catch (error) {
    console.error('Error getting other user name:', error);
    return 'Unknown User';
  }
}

// Add calculated fields after store creation to avoid circular reference
messagingStore.selectedConversation = vanX.calc(() => {
  if (!messagingStore.selectedConversationId) return null;
  return messagingStore.conversations.find(c => c.id === messagingStore.selectedConversationId) || null;
});

messagingStore.currentMessages = vanX.calc(() => {
  if (!messagingStore.selectedConversationId) return [];
  return messagingStore.messagesByConversation[messagingStore.selectedConversationId] || [];
});

messagingStore.filteredConversations = vanX.calc(() => {
  if (!messagingStore.searchQuery) return messagingStore.conversations;
  return messagingStore.conversations.filter(conv => {
    const otherUserName = getOtherUserName(conv);
    return otherUserName.toLowerCase().includes(messagingStore.searchQuery.toLowerCase());
  });
});

export default messagingStore;