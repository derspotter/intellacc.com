// frontend/src/pages/Messages.js
import van from 'vanjs-core';
import * as vanX from 'vanjs-ext';
const { div, h1, h2, h3, button, input, span, p, ul, li, textarea, form, i } = van.tags;
import messagingService from '../services/messaging.js';
import { getUserId as authGetUserId } from '../services/auth.js';
import messagingStore from '../stores/messagingStore.js';
// Rendering uses store projections; no pair key or recomputed names

/**
 * Messages page component for end-to-end encrypted messaging
 */
export default function MessagesPage() {
  // All state now comes from the reactive store
  // We derive reactive views from the store using van.derive()
  
  // Render from store's reactive projection to keep UI live

  // Initialize messaging
  const initialize = async () => {
    try {
      messagingStore.setConversationsLoading(true);
      messagingStore.clearError();
      // Initialize current user for store normalization
      const uid = authGetUserId();
      if (uid != null) messagingStore.setCurrentUserId(uid);
      
      await messagingService.initialize();
      await loadConversations();
      
    } catch (err) {
      // Initialization error surfaced to UI
      console.error('Error initializing messages:', err);
      // Don't set error if messaging service initialized successfully
      if (!err.message || !err.message.includes('conversations')) {
        messagingStore.setError('Failed to initialize messaging. Please check your encryption keys.');
      }
    } finally {
      messagingStore.setConversationsLoading(false);
    }
  };

  // Load conversations - now just calls service, store is updated automatically
  const loadConversations = async () => {
    try {
      await messagingService.getConversations();
      // Store is reactive; sidebar reads from messagingStore.sidebarItems
    } catch (err) { console.error('Error loading conversations:', err); messagingStore.setError('Failed to load conversations'); }
  };

  // Select conversation
  const selectConversation = async (conversation) => {
    try {
      // Update store selection
      messagingStore.selectConversation(conversation.id);
      messagingStore.setMessagesLoading(true);
      
      // Join conversation room for typing indicators
      messagingService.joinConversation(conversation.id);
      
      // Load messages if not present or stale
      const convId = String(conversation.id);
      const existing = (messagingStore.messagesByConversation || {})[convId];
      const meta = (messagingStore.messagesMeta || {})[convId];
      const fresh = meta && (Date.now() - (meta.lastFetchedTs || 0) < 30000);
      if (!existing || !Array.isArray(existing) || existing.length === 0 || !fresh) {
        await messagingService.getMessages(conversation.id);
      }
      
      // Mark messages as read
      const msgsNow = (messagingStore.messagesByConversation || {})[convId] || [];
      const myId = messagingStore.currentUserId != null ? messagingStore.currentUserId : null;
      const unreadMessages = msgsNow.filter(m => !m.read_at && m.receiver_id === myId);
      
      if (unreadMessages.length > 0) {
        await messagingService.markMessagesAsRead(unreadMessages.map(m => m.id));
      }
      
    } catch (err) { console.error('Error selecting conversation:', err); messagingStore.setError('Failed to load conversation'); }
    finally {
      messagingStore.setMessagesLoading(false);
    }
  };

  // Helper: select by ID to avoid stale closures over objects
  const selectConversationById = async (conversationId) => {
    let conv = (messagingStore.conversations || []).find(c => String(c.id) === String(conversationId));
    if (!conv) {
      // Try to fetch from API if store is missing the record
      try {
        conv = await messagingService.ensureConversation(conversationId);
      } catch (e) {
        console.warn('ensureConversation failed for id', conversationId, e);
      }
    }
    if (conv) {
      await selectConversation(conv);
    } else {
      // As last resort, select by id so messages load even without full convo data
      messagingStore.selectConversation(String(conversationId));
      try { await messagingService.getMessages(conversationId); } catch {}
    }
  };

  // Send message
  const sendMessage = async (e) => {
    e.preventDefault();
    
    if (!messagingStore.newMessage.trim() || !messagingStore.selectedConversation) return;
    
    try {
      const conversation = messagingStore.selectedConversation;
      const uid = messagingStore.currentUserId;
      const otherUserId = conversation.participant_1 === uid ? conversation.participant_2 : conversation.participant_1;
      
      await messagingService.sendMessage(
        conversation.id,
        otherUserId,
        messagingStore.newMessage.trim()
      );
      
      // Clear input (message will be added via socket event)
      messagingStore.setNewMessage('');
      
    } catch (err) { console.error('Error sending message:', err); messagingStore.setError('Failed to send message'); }
  };

  // Create new conversation
  const createNewConversation = async (e) => {
    e.preventDefault();
    
    if (!messagingStore.newConversationUser.trim()) return;
    
    try {
      messagingStore.setMessagesLoading(true);
      
      // For now, assume the input is a user ID
      // In a real app, you'd search by username
      const otherUserId = parseInt(messagingStore.newConversationUser.trim());
      
      if (isNaN(otherUserId)) {
        messagingStore.setError('Please enter a valid user ID');
        return;
      }
      
      const conversation = await messagingService.createConversation(otherUserId);
      
      // Conversation is automatically added to store by createConversation
      
      // Select the new conversation
      await selectConversation(conversation);
      
      // Hide new conversation form
      messagingStore.setShowNewConversation(false);
      messagingStore.setNewConversationUser('');
      
    } catch (err) {
      console.error('Error creating conversation:', err);
      // Provide specific error messages based on the error type
      if (err.message && err.message.includes('You must have a public key')) {
        messagingStore.setError('Your encryption keys are not set up properly. Please refresh the page to initialize them.');
      } else if (err.message && err.message.includes('other user must have a public key')) {
        messagingStore.setError('The other user does not have encryption keys set up and cannot receive messages.');
      } else if (err.message && err.message.includes('Key synchronization issue')) {
        messagingStore.setError('There is an issue with your encryption keys. Please refresh the page or contact support.');
      } else {
        messagingStore.setError('Failed to create conversation. Make sure the user exists and has encryption keys.');
      }
    } finally {
      messagingStore.setMessagesLoading(false);
    }
  };

  // No more event listeners needed - VanX reactivity handles everything!

  // Handle typing
  let typingTimer = null;
  const handleTyping = () => {
    if (!messagingStore.selectedConversation) return;
    
    // Send typing start
    messagingService.sendTypingIndicator(messagingStore.selectedConversation.id, true);
    
    // Clear previous timer
    if (typingTimer) {
      clearTimeout(typingTimer);
    }
    
    // Set timer to send typing stop
    typingTimer = setTimeout(() => {
      messagingService.sendTypingIndicator(messagingStore.selectedConversation.id, false);
    }, 2000);
  };

  // No local getUserId; use messagingStore.currentUserId (set during init)

  // Scroll to bottom of messages
  const scrollToBottom = () => {
    requestAnimationFrame(() => {
      const messagesContainer = document.querySelector('.messages-list');
      if (messagesContainer) {
        messagesContainer.scrollTop = messagesContainer.scrollHeight;
      }
    });
  };

  // Format timestamp
  const formatTime = (timestamp) => {
    if (!timestamp) return 'Invalid date';
    const date = new Date(timestamp);
    if (isNaN(date.getTime())) return 'Invalid date';
    
    const now = new Date();
    const diff = now - date;
    
    if (diff < 24 * 60 * 60 * 1000) {
      // Today - show time
      return date.toLocaleTimeString('en-US', { 
        hour: 'numeric', 
        minute: '2-digit',
        hour12: true 
      });
    } else if (diff < 7 * 24 * 60 * 60 * 1000) {
      // This week - show day
      return date.toLocaleDateString('en-US', { weekday: 'short' });
    } else {
      // Older - show date
      return date.toLocaleDateString('en-US', { 
        month: 'short', 
        day: 'numeric' 
      });
    }
  };

  // No snapshot helpers; render directly from store

  // Message component
  const MessageItem = (message) => {
    const isSent = message.sender_id === messagingStore.currentUserId;
    
    return li({
      class: `message-item ${isSent ? 'sent' : 'received'}`
    }, [
      div({ class: "message-content" }, [
        div({ class: "message-text" }, 
          message.isDecrypted ? message.decryptedContent : message.encrypted_content
        ),
        div({ class: "message-meta" }, [
          span({ class: "message-time" }, formatTime(message.created_at)),
          () => isSent && message.read_at ? 
            span({ class: "read-indicator" }, "✓✓") : 
            isSent ? 
              span({ class: "sent-indicator" }, "✓") : null
        ])
      ])
    ]);
  };

  // No more manual DOM manipulation needed - VanX handles everything!

  // Initialize once per page lifetime to avoid duplicate fetch/reset on re-renders
  if (!MessagesPage.__initialized) {
    MessagesPage.__initialized = true;
    initialize();
  }

  return div({ class: "messages-page" }, [
      div({ class: "messages-container" }, [
        
        // Sidebar - Conversations List
        div({ class: "conversations-sidebar" }, [
          div({ class: "sidebar-header" }, [
            h2("Messages"),
            button({
              class: "btn btn-primary btn-sm",
              onclick: () => {
                console.log('New button clicked, toggling showNewConversation from', messagingStore.showNewConversation);
                messagingStore.setShowNewConversation(!messagingStore.showNewConversation);
                console.log('showNewConversation is now', messagingStore.showNewConversation);
              }
            }, "+ New")
          ]),
          
          // New conversation form container
          div({ class: "new-conversation-container" }, 
            () => messagingStore.showNewConversation ? div({ class: "new-conversation-form" }, [
              form({ onsubmit: createNewConversation }, [
                input({
                  type: "number",
                  placeholder: "Enter user ID...",
                  value: () => messagingStore.newConversationUser,
                  oninput: (e) => messagingStore.setNewConversationUser(e.target.value),
                  class: "form-input"
                }),
                button({ type: "submit", class: "btn btn-primary btn-sm" }, "Start Chat")
              ])
            ]) : ""
          ),
          
          // Search
          div({ class: "search-box" }, [
            input({
              type: "text",
              placeholder: "Search conversations...",
              value: () => messagingStore.searchQuery,
              oninput: (e) => messagingStore.setSearchQuery(e.target.value),
              class: "form-input"
            })
          ]),
          
          // Conversations list
          div({ class: "conversations-list" }, [
            () => {
              if (messagingStore.conversationsLoading) return div({ class: "loading" }, "Loading conversations...");

              const list = messagingStore.sidebarItems || [];
              if (list.length === 0) {
                return div({ class: "empty-state" }, [
                  p("No conversations yet"),
                  p({ class: "text-muted" }, "Start a new conversation to begin messaging")
                ]);
              }

              // Build a plain snapshot to avoid reactive aliasing during render
              try { console.log('[UI] view =', JSON.stringify(list, null, 2)); } catch {}

              return ul([
                ...list.map(item => li({
                  key: item.id,
                  'data-conversation-id': item.id,
                  class: () => {
                    const selected = messagingStore.selectedConversationId === item.id;
                    return `conversation-item ${selected ? 'selected' : ''}`;
                  },
                  onclick: () => selectConversationById(item.id)
                }, [
                  div({ class: "conversation-info" }, [
                    div({ class: "conversation-name" }, item.name || 'Unknown'),
                    div({ class: "last-message-time" }, formatTime(item.time)),
                    () => item.unread > 0 ? span({ class: "unread-badge" }, item.unread) : null
                  ])
                ]))
              ]);
            }
          ])
        ]),
        
        // Main chat area
        div({ class: "chat-area" }, [
          () => messagingStore.selectedConversation === null ? 
            // No conversation selected
            div({ class: "no-conversation" }, [
              div({ class: "empty-state" }, [
                i({ class: "icon-message" }),
                h2("Select a conversation"),
                p("Choose a conversation from the sidebar to start messaging")
              ])
            ]) :
            
            // Conversation selected
            div({ class: "conversation-view" }, [
              // Chat header
              div({ class: "chat-header" }, [
                div({ class: "chat-title" }, [
                  h3(() => messagingStore.selectedConversationName || 'Unknown'),
                  div({ class: "encryption-status" }, [
                    i({ class: "icon-lock" }),
                    span("End-to-end encrypted")
                  ])
                ])
              ]),
              
              // Messages list - now fully reactive!
              div({ class: "messages-list" }, 
                () => {
                  if (messagingStore.messagesLoading) {
                    return div({ class: "loading" }, "Loading messages...");
                  }
                  if (messagingStore.currentMessages.length === 0) {
                    return div({ class: "empty-messages" }, "No messages yet. Say hello!");
                  }
                  
                  // Create reactive list that updates automatically
                  const messagesList = ul(messagingStore.currentMessages.map(MessageItem));
                  
                  // Auto-scroll when messages change
                  setTimeout(scrollToBottom, 50);
                  
                  return messagesList;
                }
              ),
                
              // Debug test button
              button({
                onclick: () => {
                  console.log('Test button clicked, adding dummy message');
                  const dummyMessage = {
                    id: Date.now(),
                    sender_id: messagingStore.currentUserId,
                    created_at: new Date().toISOString(),
                    isDecrypted: true,
                    decryptedContent: 'Test message ' + Date.now(),
                    read_at: null
                  };
                  messagingStore.addMessage(messagingStore.selectedConversationId, dummyMessage);
                  console.log('Dummy message added via store');
                }
              }, "Add Test Message"),

              // Typing indicator
              () => messagingStore.typingUsers.length > 0 ? 
                div({ class: "typing-indicator" }, [
                  span("Typing..."),
                  div({ class: "typing-dots" }, [
                    span("."), span("."), span(".")
                  ])
                ]) : null,
              
              // Message input
              div({ class: "message-input-area" }, [
                form({ onsubmit: sendMessage }, [
                  div({ class: "input-group" }, [
                    textarea({
                      placeholder: "Type your message...",
                      value: () => messagingStore.newMessage,
                      oninput: (e) => {
                        messagingStore.setNewMessage(e.target.value);
                        handleTyping();
                      },
                      onkeydown: (e) => {
                        if (e.key === 'Enter' && !e.shiftKey) {
                          e.preventDefault();
                          sendMessage(e);
                        }
                      },
                      class: "message-textarea",
                      rows: 1
                    }),
                    button({
                      type: "submit",
                      class: "send-button",
                      disabled: () => !messagingStore.newMessage.trim()
                    }, [
                      i({ class: "icon-send" }),
                      "Send"
                    ])
                  ])
                ])
              ])
            ])
        ])
      ]),
      
      // Error display
      () => messagingStore.error ? div({ class: "error-message" }, [
        div({ class: "alert alert-error" }, [
          messagingStore.error,
          button({
            class: "btn-close",
            onclick: () => messagingStore.clearError()
          }, "×")
        ])
      ]) : null
    ]);
}
