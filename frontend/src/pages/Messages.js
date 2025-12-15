// frontend/src/pages/Messages.js
// MLS E2EE Messaging - No legacy modes
import van from 'vanjs-core';
const { div, h2, h3, button, input, span, p, ul, li, textarea, form, i } = van.tags;
import messagingService from '../services/messaging.js';
import { getUserId as authGetUserId } from '../services/auth.js';
import messagingStore from '../stores/messagingStore.js';
import coreCryptoClient from '../services/mls/coreCryptoClient.js';
import vaultStore from '../stores/vaultStore.js';

/**
 * Messages page component for MLS E2EE messaging
 */
export default function MessagesPage() {

  // Initialize MLS messaging
  const initialize = async () => {
    try {
      messagingStore.setConversationsLoading(true);
      messagingStore.clearError();

      const uid = authGetUserId();
      if (uid != null) messagingStore.setCurrentUserId(uid);

      await messagingService.initialize();

      // Initialize MLS E2EE using userId
      const userId = messagingStore.currentUserId;
      if (!userId) {
        messagingStore.setError('Not logged in');
        return;
      }

      await coreCryptoClient.ensureMlsBootstrap(String(userId));
      messagingStore.setMlsInitialized(true);
      console.log('[Messages] MLS initialized for userId:', userId);

      // Check for pending invites
      await coreCryptoClient.checkForInvites();

      // Load MLS groups
      await loadMlsGroups();

      // Set up real-time MLS handlers
      setupMlsHandlers();

    } catch (err) {
      console.error('[Messages] Initialization error:', err);
      messagingStore.setError(err.message || 'Failed to initialize MLS');
    } finally {
      messagingStore.setConversationsLoading(false);
    }
  };

  // Load MLS groups from backend
  const loadMlsGroups = async () => {
    try {
      const groups = await messagingService.getMlsGroups();
      messagingStore.setMlsGroups(groups);
      console.log('[Messages] Loaded MLS groups:', groups.length);
    } catch (err) {
      console.warn('[Messages] Error loading MLS groups:', err);
    }
  };

  // Set up real-time MLS event handlers
  const setupMlsHandlers = () => {
    coreCryptoClient.onMessage((message) => {
      console.log('[Messages] MLS message received:', message);
      if (message.type === 'application' && message.plaintext) {
        messagingStore.addMlsMessage(message.groupId, {
          id: message.id,
          senderId: message.senderId,
          plaintext: message.plaintext,
          timestamp: new Date().toISOString(),
          type: 'received'
        });
      }
    });

    coreCryptoClient.onWelcome(async ({ groupId }) => {
      console.log('[Messages] Joined new MLS group:', groupId);
      await loadMlsGroups();
    });
  };

  // Select an MLS group and load its messages
  const selectMlsGroup = async (groupId) => {
    messagingStore.selectMlsGroup(groupId);
    messagingStore.setMessagesLoading(true);

    try {
      const messages = await coreCryptoClient.fetchAndDecryptMessages(groupId);
      const formatted = messages
        .filter(m => m.type === 'application' && m.plaintext)
        .map(m => ({
          id: m.id,
          senderId: m.senderId,
          plaintext: m.plaintext,
          timestamp: new Date().toISOString(),
          type: 'received'
        }));
      messagingStore.setMlsMessages(groupId, formatted);
    } catch (err) {
      console.warn('[Messages] Error loading MLS messages:', err);
    } finally {
      messagingStore.setMessagesLoading(false);
    }
  };

  // Send an MLS-encrypted message
  const sendMessage = async (e) => {
    e.preventDefault();
    const text = messagingStore.newMessage.trim();
    const groupId = messagingStore.selectedMlsGroupId;

    if (!text || !groupId) return;

    try {
      const result = await coreCryptoClient.sendMessage(groupId, text);
      console.log('[Messages] MLS message sent:', result);

      // Optimistic update
      messagingStore.addMlsMessage(groupId, {
        id: result.id || Date.now(),
        senderId: messagingStore.currentUserId,
        plaintext: text,
        timestamp: new Date().toISOString(),
        type: 'sent'
      });

      messagingStore.setNewMessage('');
    } catch (err) {
      console.error('[Messages] MLS send error:', err);
      messagingStore.setError(err.message || 'Failed to send encrypted message');
    }
  };

  // Create a new MLS group
  const createMlsGroup = async (e) => {
    e.preventDefault();
    const name = messagingStore.newConversationUser.trim();
    if (!name) return;

    try {
      messagingStore.setMessagesLoading(true);
      messagingStore.clearError();

      const group = await coreCryptoClient.createGroup(name);
      console.log('[Messages] MLS group created:', group);

      messagingStore.addMlsGroup(group);
      messagingStore.setNewConversationUser('');
      messagingStore.setShowNewConversation(false);
      messagingStore.selectMlsGroup(group.group_id);
    } catch (err) {
      console.error('[Messages] Create MLS group error:', err);
      messagingStore.setError(err.message || 'Failed to create group');
    } finally {
      messagingStore.setMessagesLoading(false);
    }
  };

  // Invite user to the selected MLS group
  const inviteMlsUser = async (e) => {
    e.preventDefault();
    const userId = messagingStore.mlsInviteUserId.trim();
    const groupId = messagingStore.selectedMlsGroupId;

    if (!userId || !groupId) return;

    try {
      messagingStore.setMessagesLoading(true);
      await coreCryptoClient.inviteToGroup(groupId, userId);
      console.log('[Messages] User invited to MLS group:', userId);

      messagingStore.setMlsInviteUserId('');
      messagingStore.setShowMlsInvite(false);
    } catch (err) {
      console.error('[Messages] Invite error:', err);
      messagingStore.setError(err.message || 'Failed to invite user');
    } finally {
      messagingStore.setMessagesLoading(false);
    }
  };

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
    if (!timestamp) return '';
    const date = new Date(timestamp);
    if (isNaN(date.getTime())) return '';

    const now = new Date();
    const diff = now - date;

    if (diff < 24 * 60 * 60 * 1000) {
      return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
    } else if (diff < 7 * 24 * 60 * 60 * 1000) {
      return date.toLocaleDateString('en-US', { weekday: 'short' });
    } else {
      return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    }
  };

  // Initialize MLS on page load (checks store to avoid re-initializing)
  // Only initialize if vault is unlocked
  if (!messagingStore.mlsInitialized && !vaultStore.isLocked) {
    initialize();
  }

  // If vault is locked, show locked state
  return () => {
    if (vaultStore.isLocked && vaultStore.vaultExists) {
      return div({ class: "messages-page messages-locked" }, [
        div({ class: "vault-locked-state" }, [
          div({ class: "lock-icon-large" }, "\uD83D\uDD12"),
          h2("Vault Locked"),
          p("Your encrypted messages are protected by your vault passphrase."),
          p({ class: "text-muted" }, "Unlock your vault to access your E2EE messages."),
          button({
            class: "button button-primary",
            onclick: () => vaultStore.setShowUnlockModal(true)
          }, "Unlock Vault")
        ])
      ]);
    }

    return div({ class: "messages-page" }, [
    div({ class: "messages-container" }, [

      // Sidebar - MLS Groups List
      div({ class: "conversations-sidebar" }, [
        div({ class: "sidebar-header" }, [
          h2("E2EE Messages"),
          button({
            class: "btn btn-primary btn-sm",
            onclick: () => messagingStore.setShowNewConversation(!messagingStore.showNewConversation)
          }, "+ New")
        ]),

        // MLS status indicator
        div({ class: "mode-toggle" }, [
          () => messagingStore.mlsInitialized ?
            span({ class: "mls-status active" }, "MLS Ready") :
            span({ class: "mls-status" }, "Initializing MLS...")
        ]),

        // Create group form
        div({ class: "new-conversation-container" },
          () => messagingStore.showNewConversation ? div({ class: "new-conversation-form" }, [
            form({ onsubmit: createMlsGroup }, [
              input({
                type: "text",
                placeholder: "Group name...",
                value: () => messagingStore.newConversationUser,
                oninput: (e) => messagingStore.setNewConversationUser(e.target.value),
                class: "form-input"
              }),
              button({ type: "submit", class: "btn btn-primary btn-sm" }, "Create Group")
            ])
          ]) : ""
        ),

        // Search
        div({ class: "search-box" }, [
          input({
            type: "text",
            placeholder: "Search groups...",
            value: () => messagingStore.searchQuery,
            oninput: (e) => messagingStore.setSearchQuery(e.target.value),
            class: "form-input"
          })
        ]),

        // Groups list
        div({ class: "conversations-list" }, [
          () => {
            if (messagingStore.conversationsLoading) return div({ class: "loading" }, "Loading...");

            const groups = messagingStore.mlsSidebarItems || [];
            if (groups.length === 0) {
              return div({ class: "empty-state" }, [
                p("No E2EE groups yet"),
                p({ class: "text-muted" }, "Create a group to start encrypted messaging")
              ]);
            }

            return ul([
              ...groups.map(item => li({
                key: item.id,
                'data-group-id': item.id,
                class: () => {
                  const selected = messagingStore.selectedMlsGroupId === item.id;
                  return `conversation-item mls-group ${selected ? 'selected' : ''}`;
                },
                onclick: () => selectMlsGroup(item.id)
              }, [
                div({ class: "conversation-info" }, [
                  div({ class: "conversation-name" }, [
                    span({ class: "lock-icon" }, "🔒 "),
                    item.name || 'Unnamed Group'
                  ]),
                  div({ class: "group-id text-muted" }, item.id?.substring(0, 8) + '...')
                ])
              ]))
            ]);
          }
        ])
      ]),

      // Main chat area
      div({ class: "chat-area" }, [
        () => {
          if (!messagingStore.selectedMlsGroupId) {
            return div({ class: "no-conversation" }, [
              div({ class: "empty-state" }, [
                i({ class: "icon-message" }),
                h2("Select an E2EE group"),
                p("Choose a group from the sidebar or create a new one")
              ])
            ]);
          }

          // MLS Group selected
          return div({ class: "conversation-view mls-conversation" }, [
            // Chat header
            div({ class: "chat-header" }, [
              div({ class: "chat-title" }, [
                h3(() => messagingStore.selectedMlsGroup?.name || 'E2EE Group'),
                div({ class: "encryption-status mls-active" }, [
                  i({ class: "icon-lock" }),
                  span("MLS End-to-End Encrypted")
                ])
              ]),
              button({
                class: "btn btn-sm",
                onclick: () => messagingStore.setShowMlsInvite(!messagingStore.showMlsInvite)
              }, "+ Invite")
            ]),

            // Invite form
            () => messagingStore.showMlsInvite ? div({ class: "invite-form" }, [
              form({ onsubmit: inviteMlsUser }, [
                input({
                  type: "text",
                  placeholder: "User ID to invite...",
                  value: () => messagingStore.mlsInviteUserId,
                  oninput: (e) => messagingStore.setMlsInviteUserId(e.target.value),
                  class: "form-input"
                }),
                button({ type: "submit", class: "btn btn-primary btn-sm" }, "Invite")
              ])
            ]) : null,

            // Messages list
            div({ class: "messages-list" },
              () => {
                if (messagingStore.messagesLoading) {
                  return div({ class: "loading" }, "Loading encrypted messages...");
                }
                const messages = messagingStore.currentMlsMessages || [];
                if (messages.length === 0) {
                  return div({ class: "empty-messages" }, "No messages yet. Send an encrypted message!");
                }

                const messagesList = ul([
                  ...messages.map(msg => li({
                    class: `message-item ${msg.type === 'sent' || msg.senderId === messagingStore.currentUserId ? 'sent' : 'received'}`
                  }, [
                    div({ class: "message-content" }, [
                      div({ class: "message-text" }, msg.plaintext),
                      div({ class: "message-meta" }, [
                        span({ class: "message-sender" }, `User ${msg.senderId}`),
                        span({ class: "message-time" }, formatTime(msg.timestamp))
                      ])
                    ])
                  ]))
                ]);

                setTimeout(scrollToBottom, 50);
                return messagesList;
              }
            ),

            // Message input
            div({ class: "message-input-area" }, [
              form({ onsubmit: sendMessage }, [
                div({ class: "input-group" }, [
                  textarea({
                    placeholder: "Type an encrypted message...",
                    value: () => messagingStore.newMessage,
                    oninput: (e) => messagingStore.setNewMessage(e.target.value),
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
          ]);
        }
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
  };
}
