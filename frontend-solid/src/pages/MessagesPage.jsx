import { createEffect, createMemo, createSignal, For, Show, onCleanup } from 'solid-js';
import { getDirectMessages } from '../services/api';
import { getCurrentUserId as getAuthUserId, isAuthenticated } from '../services/auth';
import vaultStore from '../store/vaultStore';
import vaultService from '../services/mls/vaultService';
import coreCryptoClient from '@shared/mls/coreCryptoClient.js';
import { onMlsMessage, onMlsWelcome } from '../services/socket';

const normalizeRows = (payload) => {
  if (Array.isArray(payload)) {
    return payload;
  }
  if (Array.isArray(payload?.items)) {
    return payload.items;
  }
  if (Array.isArray(payload?.directMessages)) {
    return payload.directMessages;
  }
  return [];
};

const normalizeMessageRows = (payload) => {
  if (Array.isArray(payload)) {
    return payload;
  }
  if (Array.isArray(payload?.items)) {
    return payload.items;
  }
  return [];
};

const getConversationId = (conversation) => {
  return String(
    conversation?.group_id ??
    conversation?.groupId ??
    conversation?.id ??
    ''
  );
};

const getSenderId = (message) => {
  return (
    message.sender_id ||
    message.senderId ||
    message.sender?.id ||
    message.user_id ||
    message.userId
  );
};

const getMessageText = (message) => {
  if (!message) {
    return '';
  }

  if (message.message_type === 'text' && message.text) {
    return message.text;
  }

  if (typeof message.text === 'string') {
    return message.text;
  }

  if (typeof message.content === 'string') {
    return message.content;
  }

  if (typeof message.data?.text === 'string') {
    return message.data.text;
  }

  if (message.plaintext) {
    return message.plaintext;
  }

  if (message.data) {
    try {
      return JSON.stringify(message.data);
    } catch {
      // ignore
    }
  }

  return '';
};

const formatMessageTime = (message) => {
  const time = message.created_at || message.timestamp || message.createdAt || message.updated_at;
  if (!time) {
    return '';
  }
  const value = new Date(time);
  if (Number.isNaN(value.getTime())) {
    return '';
  }
  return value.toLocaleString();
};

const getConversationName = (conversation, groupId) => {
  if (!conversation) {
    return `Conversation ${groupId}`;
  }

  if (conversation.participant_usernames) {
    const users = conversation.participant_usernames;
    if (Array.isArray(users) && users.length) {
      return users.join(', ');
    }
  }

  if (conversation.other_username) {
    return conversation.other_username;
  }

  if (conversation.other_user_id) {
    return `User ${conversation.other_user_id}`;
  }

  const users = conversation.users || conversation.participants;
  if (Array.isArray(users) && users.length) {
    return users.join(', ');
  }

  return `Conversation ${groupId}`;
};

export default function MessagesPage() {
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal('');
  const [directs, setDirects] = createSignal([]);
  const [selectedGroup, setSelectedGroup] = createSignal('');
  const [groupMessages, setGroupMessages] = createSignal([]);
  const [loadingMessages, setLoadingMessages] = createSignal(false);
  const [conversationBusy, setConversationBusy] = createSignal(false);
  const [sendingMessage, setSendingMessage] = createSignal(false);
  const [messageText, setMessageText] = createSignal('');
  const [targetId, setTargetId] = createSignal('');
  const [searchQuery, setSearchQuery] = createSignal('');
  const [showNewConversation, setShowNewConversation] = createSignal(false);
  const [isInitialized, setIsInitialized] = createSignal(false);
  const [groupError, setGroupError] = createSignal('');

  const currentUserId = createMemo(() => {
    return getAuthUserId() || coreCryptoClient?.identityName || vaultStore.userId || '';
  });

  const isLocked = () => vaultStore.state?.isLocked === true;

  const visibleConversations = createMemo(() => {
    const query = searchQuery().trim().toLowerCase();
    if (!query) {
      return directs();
    }

    return directs().filter((conversation) => {
      const groupId = getConversationId(conversation);
      const users = conversation.participant_usernames || conversation.users || '';
      const userText = Array.isArray(users) ? users.join(' ') : String(users || '').toLowerCase();
      return groupId.includes(query) || userText.includes(query);
    });
  });

  const processPendingQueue = async () => {
    if (!isAuthenticated()) {
      return;
    }

    try {
      const userId = getAuthUserId();
      if (userId) {
        await coreCryptoClient.ensureMlsBootstrap(String(userId));
      }
      await coreCryptoClient.syncMessages();
    } catch (err) {
      console.warn('[MessagesPage] MLS sync failed:', err?.message || err);
    }
  };

  const loadConversations = async () => {
    if (!isAuthenticated()) {
      return [];
    }

    try {
      setLoading(true);
      setError('');
      const response = await getDirectMessages();
      const rows = normalizeRows(response);
      setDirects(rows);
      return rows;
    } catch (err) {
      setError(err?.message || 'Failed to load messages.');
      setDirects([]);
      return [];
    } finally {
      setLoading(false);
    }
  };

  const refreshConversationMessages = async (groupId) => {
    if (!groupId) {
      setGroupMessages([]);
      return;
    }

    try {
      const response = await vaultService.getMessages(groupId);
      setGroupMessages(normalizeMessageRows(response));
      setError('');
      setGroupError('');
    } catch (err) {
      if (err?.message === 'Vault locked') {
        setGroupError('Unlock your vault to load messages for this conversation.');
      } else {
        setError(err?.message || 'Failed to load conversation messages.');
      }
      setGroupMessages([]);
    }
  };

  const loadMessages = async (groupId) => {
    if (!groupId) {
      setGroupMessages([]);
      return;
    }

    setLoadingMessages(true);
    try {
      await processPendingQueue();
      await refreshConversationMessages(groupId);
    } finally {
      setLoadingMessages(false);
    }
  };

  const initializeMessaging = async () => {
    if (!isAuthenticated() || isLocked()) {
      return;
    }

    const userId = getAuthUserId();
    if (!userId) {
      return;
    }

    try {
      await coreCryptoClient.ensureMlsBootstrap(String(userId));
      await processPendingQueue();
      await loadConversations();
      setIsInitialized(true);
    } catch (err) {
      setError(err?.message || 'Unable to initialize encrypted messaging.');
      setIsInitialized(false);
    }
  };

  const pendingHintGroupIds = new Set();
  let disposed = false;
  let mlsSyncTimer = null;

  const scheduleMlsSync = (groupId, { forceReloadConversations = false } = {}) => {
    if (groupId) {
      pendingHintGroupIds.add(String(groupId));
    }

    if (mlsSyncTimer) {
      return;
    }

    mlsSyncTimer = setTimeout(async () => {
      const groupIds = Array.from(pendingHintGroupIds);
      pendingHintGroupIds.clear();
      mlsSyncTimer = null;

      if (disposed || !isAuthenticated() || isLocked()) {
        return;
      }

      await processPendingQueue();

      const hasConversation = (gid) => {
        const target = String(gid);
        return (directs() || []).some((conversation) => getConversationId(conversation) === target);
      };

      const shouldReloadConversations =
        forceReloadConversations ||
        groupIds.length === 0 ||
        groupIds.some((gid) => !hasConversation(gid));

      if (shouldReloadConversations) {
        await loadConversations();
      }

      const current = selectedGroup();
      const idsToRefresh = groupIds.length ? groupIds : (current ? [current] : []);
      for (const id of idsToRefresh) {
        if (String(id) === String(current)) {
          await loadMessages(id);
        }
      }
    }, 150);
  };

  const mlsUnsubMessage = onMlsMessage((payload) => {
    const groupId = payload?.groupId || payload?.group_id;
    scheduleMlsSync(groupId);
  });

  const mlsUnsubWelcome = onMlsWelcome((payload) => {
    const groupId = payload?.groupId || payload?.group_id;
    scheduleMlsSync(groupId, { forceReloadConversations: true });
  });

  onCleanup(() => {
    disposed = true;
    if (mlsSyncTimer) {
      clearTimeout(mlsSyncTimer);
      mlsSyncTimer = null;
    }
    try {
      mlsUnsubMessage?.();
    } catch {}
    try {
      mlsUnsubWelcome?.();
    } catch {}
  });

  let wasLocked = true;
  createEffect(() => {
    const locked = isLocked();

    if (wasLocked && !locked) {
      setIsInitialized(false);
      void initializeMessaging();
    }

    if (!wasLocked && locked) {
      setError('');
      setGroupError('');
      setGroupMessages([]);
      setSelectedGroup('');
      setSendingMessage(false);
      setMessageText('');
    }

    wasLocked = locked;
  });

  const startConversation = async (event) => {
    event.preventDefault();
    const nextTarget = Number.parseInt(targetId(), 10);
    if (!Number.isInteger(nextTarget) || nextTarget <= 0) {
      setError('Please enter a valid user id.');
      return;
    }

    if (!isAuthenticated()) {
      setError('Sign in to start messages.');
      return;
    }

    try {
      setConversationBusy(true);
      setError('');
      const created = await coreCryptoClient.startDirectMessage(nextTarget);
      const groupId = getConversationId(created);
      await loadConversations();
      if (groupId) {
        setSelectedGroup(groupId);
        await loadMessages(groupId);
      }
      setTargetId('');
      setShowNewConversation(false);
    } catch (err) {
      setError(err?.message || 'Failed to create message thread.');
    } finally {
      setConversationBusy(false);
    }
  };

  const selectConversation = (groupId) => {
    const next = String(groupId || '');
    setSelectedGroup(next);
    void loadMessages(next);
  };

  const handleSendMessage = async (event) => {
    event.preventDefault();
    const text = messageText().trim();
    const conversationId = String(selectedGroup() || '');
    if (!text || !conversationId || sendingMessage() || isLocked()) {
      return;
    }

    const optimisticId = `opt_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    setSendingMessage(true);
    setError('');
    setGroupError('');

    setGroupMessages((current) => [
      ...current,
      {
        id: optimisticId,
        senderId: currentUserId(),
        plaintext: text,
        content: text,
        timestamp: new Date().toISOString(),
        groupId: conversationId
      }
    ]);
    setMessageText('');

    try {
      const result = await coreCryptoClient.sendMessage(conversationId, text);
      const sentId = result?.id;
      if (sentId) {
        setGroupMessages((current) => current.map((msg) => {
          if (msg.id !== optimisticId) {
            return msg;
          }
          return { ...msg, id: String(sentId) };
        }));
      }
    } catch (err) {
      setError(err?.message || 'Failed to send message.');
      setMessageText(text);
      setGroupMessages((current) => current.filter((msg) => msg.id !== optimisticId));
    } finally {
      setSendingMessage(false);
    }
  };

  createEffect(() => {
    if (!isAuthenticated() || isLocked()) {
      return;
    }
    if (!isInitialized()) {
      void initializeMessaging();
    }
  });

  createEffect(() => {
    const currentSelection = selectedGroup();
    if (isAuthenticated() && currentSelection && !isLocked()) {
      void loadMessages(currentSelection);
    }
  });

  return (
    <section class="messages-page">
      <div class="messages-container">
        <aside class="conversations-sidebar">
          <div class="sidebar-header">
            <h2>Messages</h2>
            <button
              type="button"
              class="post-action"
              onclick={() => setShowNewConversation((current) => !current)}
            >
              {showNewConversation() ? 'Cancel' : '+ New'}
            </button>
          </div>

          <Show when={showNewConversation()}>
            <div class="new-conversation-form">
              <form onSubmit={startConversation}>
                <input
                  type="text"
                  value={targetId()}
                  onInput={(event) => setTargetId(event.target.value)}
                  placeholder="Start by user id"
                  disabled={conversationBusy()}
                  required
                  min="1"
                />
                <button type="submit" class="post-action" disabled={conversationBusy()}>
                  {conversationBusy() ? 'Opening…' : 'Open'}
                </button>
              </form>
            </div>
          </Show>

          <div class="search-box">
            <input
              class="form-input"
              type="text"
              value={searchQuery()}
              onInput={(event) => setSearchQuery(event.target.value)}
              placeholder="Search conversations"
            />
          </div>

          <div class="conversations-list">
            <Show when={loading()}>
              <p class="loading">Loading conversations…</p>
            </Show>

            <Show when={!loading() && visibleConversations().length === 0}>
              <p class="empty-state">No conversations yet.</p>
            </Show>

            <ul>
              <For each={visibleConversations()}>
                {(conversation) => {
                  const groupId = getConversationId(conversation);
                  const displayName = getConversationName(conversation, groupId);

                  return (
                    <li
                      class="conversation-item"
                      classList={{ selected: String(selectedGroup()) === String(groupId) }}
                      role="button"
                      onClick={() => selectConversation(groupId)}
                    >
                      <div class="conversation-info">
                        <span class="conversation-name">{displayName}</span>
                        <span class="last-message-time">
                          {conversation.updated_at
                            ? new Date(conversation.updated_at).toLocaleString()
                            : `#${groupId}`}
                        </span>
                      </div>
                    </li>
                  );
                }}
              </For>
            </ul>
          </div>
        </aside>

        <div class="chat-area">
          <Show when={!selectedGroup()}>
            <div class="no-conversation">
              <div class="empty-state">
                <span class="icon-message" />
                <h2>Select a conversation</h2>
                <p>Pick a message thread to see message history.</p>
              </div>
            </div>
          </Show>

          <Show when={selectedGroup()}>
            <div class="conversation-view mls-conversation">
              <div class="chat-header">
                <div class="chat-title">
                  <h3>
                    {(() => {
                      const conversation = visibleConversations().find(
                        (candidate) => String(getConversationId(candidate)) === String(selectedGroup())
                      );
                      return getConversationName(conversation, selectedGroup());
                    })()}
                  </h3>
                  <div class="encryption-status mls-active">MLS conversation</div>
                </div>
              </div>

              <div class="messages-list">
                <Show when={loadingMessages()}>
                  <div class="loading">Loading messages…</div>
                </Show>

                <Show when={!loadingMessages() && groupMessages().length === 0}>
                  <div class="empty-messages">No messages in this conversation yet.</div>
                </Show>

                <Show when={groupMessages().length > 0}>
                  <ul>
                    <For each={groupMessages()}>
                      {(message) => {
                        const senderId = String(getSenderId(message) || '');
                        const currentId = String(currentUserId() || '');
                        const isSent = senderId && currentId && senderId === currentId;

                        return (
                          <li classList={{
                            'message-item': true,
                            sent: isSent,
                            received: !isSent
                          }}>
                            <div class="message-content">
                              <div class="message-text">{getMessageText(message) || 'Message content unavailable'}</div>
                              <div class="message-meta">
                                <span class="message-sender">
                                  {isSent ? 'You' : `User ${senderId || 'unknown'}`}
                                </span>
                                <span class="message-time">
                                  {formatMessageTime(message)}
                                </span>
                              </div>
                            </div>
                          </li>
                        );
                      }}
                    </For>
                  </ul>
                </Show>
              </div>

              <div class="message-input-area">
                <form class="message-composer" onSubmit={handleSendMessage}>
                  <div class="input-group">
                    <textarea
                      class="message-textarea"
                      value={messageText()}
                      onInput={(event) => setMessageText(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' && !event.shiftKey) {
                          event.preventDefault();
                          void handleSendMessage(event);
                        }
                      }}
                      placeholder={
                        isLocked()
                          ? 'Unlock messaging to send a message'
                          : 'Type your message'
                      }
                      disabled={!selectedGroup() || isLocked()}
                      rows="1"
                    />
                    <button
                      class="send-button"
                      type="submit"
                      disabled={
                        sendingMessage() ||
                        !messageText().trim() ||
                        !selectedGroup() ||
                        isLocked()
                      }
                    >
                      {sendingMessage() ? 'Sending…' : 'Send'}
                    </button>
                  </div>
                  <Show when={groupError()}>
                    <p class="error">{groupError()}</p>
                  </Show>
                </form>
              </div>
            </div>
          </Show>
        </div>
      </div>

      <Show when={error()}>
        <p class="error">{error()}</p>
      </Show>
    </section>
  );
}
