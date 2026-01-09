// frontend/src/pages/Messages.js
// MLS E2EE Messaging - No legacy modes
import van from 'vanjs-core';
const { div, h2, h3, button, input, span, p, ul, li, textarea, form, i } = van.tags;
import messagingService from '../services/messaging.js';
import { getUserId as authGetUserId } from '../services/auth.js';
import messagingStore from '../stores/messagingStore.js';
import coreCryptoClient from '../services/mls/coreCryptoClient.js';
import vaultStore from '../stores/vaultStore.js';
import { api } from '../services/api.js';
import { SafetyNumbersButton, ContactVerifyButton, VerificationBadge, FingerprintWarningBanner, ContactVerificationModal } from '../components/SafetyNumbers.js';
import { NewConversationPanel } from '../components/UserSearch.js';

// Pending fetch promises (not sensitive data, just coordination)
const pendingFetches = new Map();

async function getUserName(userId) {
  if (!userId) return 'Unknown';
  const id = String(userId);

  // Check store cache first (cleared on vault lock for security)
  if (messagingStore.userNameCache[id]) {
    return messagingStore.userNameCache[id];
  }

  // If already fetching, wait for that request
  if (pendingFetches.has(id)) {
    return pendingFetches.get(id);
  }

  // Fetch user info
  const fetchPromise = (async () => {
    try {
      const user = await api.users.getUser(id);
      const name = user?.username || `User ${id}`;
      messagingStore.userNameCache[id] = name;
      return name;
    } catch (err) {
      console.warn('[Messages] Could not fetch user:', id, err);
      const fallback = `User ${id}`;
      messagingStore.userNameCache[id] = fallback;
      return fallback;
    } finally {
      pendingFetches.delete(id);
    }
  })();

  pendingFetches.set(id, fetchPromise);
  return fetchPromise;
}

/**
 * Component to display sender name with async lookup
 * Shows "User {id}" initially, then updates to username when fetched
 */
function SenderName(userId) {
  const id = String(userId);

  // If we already have the name cached, return it directly
  if (messagingStore.userNameCache[id]) {
    return span({ class: "message-sender" }, messagingStore.userNameCache[id]);
  }

  // Create reactive state for the name
  const nameState = van.state(`User ${id}`);

  // Trigger async fetch and update state when ready
  getUserName(id).then(name => {
    nameState.val = name;
  });

  // Return reactive span
  return span({ class: "message-sender" }, nameState);
}

/**
 * Messages page component for MLS E2EE messaging
 */
export default function MessagesPage() {
  // Local state for invite form toggle (fixes VanJS reactivity issue with VanX store)
  const showInviteForm = van.state(false);
  // Local state for showing inline new conversation panel
  const showNewConvoPanel = van.state(false);
  // Local state for fingerprint verification modal (userId to verify, null if closed)
  const verifyingUserId = van.state(null);

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

      // Set up real-time MLS handlers before pulling pending welcomes
      setupMlsHandlers();

      // Check for pending invites
      await coreCryptoClient.syncMessages();

      // Load MLS groups
      await loadMlsGroups();

      // Load DMs
      await loadDirectMessages();

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

  // Load Direct Messages from backend
  const loadDirectMessages = async () => {
    try {
      const dms = await api.mls.getDirectMessages();
      messagingStore.setDirectMessages(dms);
      console.log('[Messages] Loaded DMs:', dms.length);
    } catch (err) {
      console.warn('[Messages] Error loading DMs:', err);
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
      await Promise.all([loadMlsGroups(), loadDirectMessages()]);
    });

    coreCryptoClient.onWelcomeRequest((invite) => {
      console.log('[Messages] Pending MLS welcome:', invite);
      messagingStore.addPendingWelcome(invite);
    });
  };

  const formatInviteLabel = (invite) => {
    if (!invite) return 'Unknown Invite';
    if (invite.groupId && invite.groupId.startsWith('dm_')) return 'Direct Message';
    if (invite.groupId) return `Group ${invite.groupId.substring(0, 8)}...`;
    return 'Group Invite';
  };

  const acceptPendingWelcome = async (invite) => {
    try {
      const groupId = await coreCryptoClient.acceptWelcome(invite);
      messagingStore.removePendingWelcome(invite.id);
      await Promise.all([loadMlsGroups(), loadDirectMessages()]);
      if (groupId) messagingStore.selectMlsGroup(groupId);
    } catch (err) {
      console.error('[Messages] Failed to accept welcome:', err);
      messagingStore.setError(err.message || 'Failed to accept invite');
    }
  };

  const rejectPendingWelcome = async (invite) => {
    try {
      await coreCryptoClient.rejectWelcome(invite);
      messagingStore.removePendingWelcome(invite.id);
    } catch (err) {
      console.error('[Messages] Failed to reject welcome:', err);
      messagingStore.setError(err.message || 'Failed to reject invite');
    }
  };

  // Select an MLS group and load its messages
  const selectMlsGroup = async (groupId) => {
    messagingStore.selectMlsGroup(groupId);
    messagingStore.setMessagesLoading(true);

    try {
      // 1. Load local history from encrypted vault
      const vaultService = (await import('../services/vaultService.js')).default;
      const history = await vaultService.getMessages(groupId);
      
      const formattedHistory = history.map(m => ({
        id: m.id,
        senderId: m.senderId,
        plaintext: m.plaintext,
        timestamp: m.timestamp,
        type: String(m.senderId) === String(messagingStore.currentUserId) ? 'sent' : 'received'
      }));
      
      messagingStore.setMlsMessages(groupId, formattedHistory);

      // 2. Fetch any pending messages from relay queue
      // Note: syncMessages logic handles this via socket events, but we can trigger a sync just in case
      // coreCryptoClient.syncMessages() is global, not per group.
      
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
      showInviteForm.val = false;  // Use local state for reliable UI update
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
          h2("Messages Locked"),
          p("Your encrypted messages are protected by your login password."),
          p({ class: "text-muted" }, "Unlock your local keystore to access your E2EE messages."),
          button({
            class: "button button-primary",
            onclick: () => vaultStore.setShowUnlockModal(true)
          }, "Unlock Messaging")
        ])
      ]);
    }

    return div({ class: "messages-page" }, [
    div({ class: "messages-container" }, [

      // Sidebar - MLS Groups List
      div({ class: "conversations-sidebar" }, [
        div({ class: "sidebar-header" }, [
          h2("E2EE Messages"),
          () => !showNewConvoPanel.val ? button({
            class: "btn btn-primary btn-sm",
            onclick: () => { showNewConvoPanel.val = true; }
          }, "+ New") : null
        ]),

        // MLS status indicator
        () => !showNewConvoPanel.val ? div({ class: "mode-toggle" }, [
          messagingStore.mlsInitialized ?
            span({ class: "mls-status active" }, "MLS Ready") :
            span({ class: "mls-status" }, "Initializing MLS...")
        ]) : null,

        // Inline New Conversation Panel OR Conversations List
        () => {
          if (showNewConvoPanel.val) {
            // Show inline new conversation panel
            return NewConversationPanel({
              onClose: () => { showNewConvoPanel.val = false; }
            });
          }

          // Search
          return div({ class: "sidebar-content" }, [
            div({ class: "search-box" }, [
              input({
                type: "text",
                placeholder: "Search conversations...",
                value: () => messagingStore.searchQuery,
                oninput: (e) => messagingStore.setSearchQuery(e.target.value),
                class: "form-input"
              })
            ]),

            // DMs and Groups list
            div({ class: "conversations-list" }, [
              () => {
                if (messagingStore.conversationsLoading) return div({ class: "loading" }, "Loading...");

                const dms = messagingStore.dmSidebarItems || [];
                const groups = (messagingStore.mlsSidebarItems || []).filter(g => !g.isDm);
                const pendingWelcomes = messagingStore.pendingWelcomes || [];

                if (dms.length === 0 && groups.length === 0 && pendingWelcomes.length === 0) {
                  return div({ class: "empty-state" }, [
                    p("No E2EE conversations yet"),
                    p({ class: "text-muted" }, "Click \"+ New\" to start a conversation"),
                    div({ style: "margin-top: 15px; font-size: 0.9em;" }, [
                        span("Missing history? "),
                        button({ 
                            class: "btn-link",
                            onclick: () => window.location.hash = 'settings'
                        }, "Link this device")
                    ])
                  ]);
                }

                return div([
                  // Pending Invites Section
                  pendingWelcomes.length > 0 ? div({ class: "section-header" }, "Pending Invites") : null,
                  pendingWelcomes.length > 0 ? ul({ class: "invite-list" }, [
                    ...pendingWelcomes.map(invite => li({
                      key: invite.id,
                      class: "invite-item"
                    }, [
                      div({ class: "invite-info" }, [
                        div({ class: "invite-title" }, formatInviteLabel(invite)),
                        div({ class: "invite-meta text-muted" }, `From user ${invite.senderUserId ?? 'unknown'}`)
                      ]),
                      div({ class: "invite-actions" }, [
                        button({ class: "btn btn-sm btn-primary", onclick: () => acceptPendingWelcome(invite) }, "Accept"),
                        button({ class: "btn btn-sm", onclick: () => rejectPendingWelcome(invite) }, "Reject")
                      ])
                    ]))
                  ]) : null,

                  // DMs Section
                  dms.length > 0 ? div({ class: "section-header" }, "Direct Messages") : null,
                  dms.length > 0 ? ul({ class: "dm-list" }, [
                    ...dms.map(item => li({
                      key: item.id,
                      'data-group-id': item.id,
                      class: () => {
                        const selected = messagingStore.selectedMlsGroupId === item.id;
                        return `conversation-item dm-item ${selected ? 'selected' : ''}`;
                      },
                      onclick: () => selectMlsGroup(item.id)
                    }, [
                      div({ class: "conversation-info" }, [
                        div({ class: "conversation-name" }, [
                          span({ class: "lock-icon" }, "\uD83D\uDD12 "),
                          item.name,
                          // Verification badge for DM contacts
                          item.otherUserId ? VerificationBadge({ contactUserId: item.otherUserId }) : null
                        ])
                      ])
                    ]))
                  ]) : null,

                  // Groups Section
                  groups.length > 0 ? div({ class: "section-header" }, "Groups") : null,
                  groups.length > 0 ? ul({ class: "group-list" }, [
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
                          span({ class: "lock-icon" }, "\uD83D\uDD12 "),
                          item.name || 'Unnamed Group'
                        ]),
                        div({ class: "group-id text-muted" }, item.id?.substring(0, 8) + '...')
                      ])
                    ]))
                  ]) : null
                ]);
              }
            ])
          ]);
        }
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

          // MLS Group selected (could be DM or Group)
          const isDm = coreCryptoClient.isDirectMessage(messagingStore.selectedMlsGroupId);
          const dmInfo = isDm ? messagingStore.directMessages.find(dm => dm.group_id === messagingStore.selectedMlsGroupId) : null;
          const chatTitle = isDm
            ? (dmInfo?.other_username || 'Direct Message')
            : (messagingStore.selectedMlsGroup?.name || 'E2EE Group');

          return div({ class: "conversation-view mls-conversation" }, [
            // Chat header
            div({ class: "chat-header" }, [
              div({ class: "chat-title" }, [
                h3(chatTitle),
                div({ class: "encryption-status mls-active" }, [
                  i({ class: "icon-lock" }),
                  span("MLS End-to-End Encrypted")
                ])
              ]),
              div({ class: "chat-header-actions" }, [
                SafetyNumbersButton(),
                // Show contact verify button for DMs
                isDm && dmInfo?.other_user_id ? ContactVerifyButton({
                  contactUserId: dmInfo.other_user_id,
                  contactUsername: dmInfo.other_username || 'Contact'
                }) : null,
                // Only show invite button for groups, not DMs
                isDm ? null : button({
                  class: "btn btn-sm",
                  onclick: () => { showInviteForm.val = !showInviteForm.val; }
                }, "+ Invite")
              ])
            ]),

            // Fingerprint warning banners (TOFU security alerts)
            () => {
              const warnings = messagingStore.fingerprintWarnings || [];
              if (warnings.length === 0) return null;
              return div({ class: "fingerprint-warnings" },
                warnings.map(warning => FingerprintWarningBanner({
                  message: `Security alert: User ${warning.userId}'s encryption key has changed!`,
                  onDismiss: () => messagingStore.dismissFingerprintWarning(warning.userId),
                  onVerify: () => {
                    // Open verification modal for this user
                    verifyingUserId.val = warning.userId;
                  }
                }))
              );
            },

            // Verification modal for fingerprint warnings
            () => {
              if (!verifyingUserId.val) return null;
              return ContactVerificationModal({
                contactUserId: verifyingUserId.val,
                contactUsername: `User ${verifyingUserId.val}`,
                onClose: () => {
                  verifyingUserId.val = null;
                },
                onVerify: () => {
                  messagingStore.dismissFingerprintWarning(verifyingUserId.val);
                  verifyingUserId.val = null;
                }
              });
            },

            // Invite form - always rendered but hidden via CSS class
            div({
              class: () => `invite-form ${showInviteForm.val ? 'visible' : 'hidden'}`
            }, [
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
            ]),

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
                        SenderName(msg.senderId),
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
