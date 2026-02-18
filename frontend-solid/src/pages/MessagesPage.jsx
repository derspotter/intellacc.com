import {
  createEffect,
  createSignal,
  For,
  Show
} from 'solid-js';
import {
  createDirectMessage,
  getDirectMessages,
  getGroupMessages,
  sendGroupMessage
} from '../services/api';
import { getCurrentUserId, isAuthenticated } from '../services/auth';

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

const normalizeGroupMessages = (payload) => {
  if (Array.isArray(payload)) {
    return payload;
  }
  if (Array.isArray(payload?.items)) {
    return payload.items;
  }
  return [];
};

const formatMessageText = (message) => {
  const text = message?.data ?? message?.content ?? message?.plaintext ?? '';
  if (typeof text !== 'string') {
    if (text && text.type === 'Buffer' && Array.isArray(text.data)) {
      try {
        return new TextDecoder().decode(Uint8Array.from(text.data));
      } catch {
        return JSON.stringify(text);
      }
    }
    return JSON.stringify(text);
  }

  const trimmed = text.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed === 'string') {
        return parsed;
      }
      if (parsed && typeof parsed.text === 'string') {
        return parsed.text;
      }
      if (parsed && parsed.message && typeof parsed.message === 'string') {
        return parsed.message;
      }
      if (typeof parsed.message_type === 'string') {
        return `${parsed.message_type}: ${JSON.stringify(parsed)}`;
      }
      return JSON.stringify(parsed);
    } catch {
      return trimmed;
    }
  }

  return text;
};

const getParticipantLabel = (conversation) => {
  if (conversation.other_username) {
    return conversation.other_username;
  }
  if (Array.isArray(conversation.participant_usernames)) {
    return conversation.participant_usernames.join(', ');
  }
  return null;
};

export default function MessagesPage() {
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal('');
  const [directs, setDirects] = createSignal([]);
  const [selectedGroup, setSelectedGroup] = createSignal('');
  const [groupMessages, setGroupMessages] = createSignal([]);
  const [loadingMessages, setLoadingMessages] = createSignal(false);
  const [conversationBusy, setConversationBusy] = createSignal(false);
  const [targetId, setTargetId] = createSignal('');
  const [messageText, setMessageText] = createSignal('');
  const [sendingMessage, setSendingMessage] = createSignal(false);

  const getCurrentUser = () => getCurrentUserId();

  const normalizeMessage = (message) => {
    const senderId = String(
      message?.sender_user_id
      || message?.senderUserId
      || message?.senderId
      || ''
    );
    return {
      ...message,
      isOwn: senderId && senderId === getCurrentUser()
    };
  };

  const loadConversations = async () => {
    if (!isAuthenticated()) {
      return;
    }

    try {
      setLoading(true);
      setError('');
      const response = await getDirectMessages();
      setDirects(normalizeRows(response));
    } catch (err) {
      setError(err?.message || 'Failed to load messages.');
      setDirects([]);
    } finally {
      setLoading(false);
    }
  };

  const loadMessages = async (groupId) => {
    if (!groupId) {
      setGroupMessages([]);
      return;
    }

    try {
      setLoadingMessages(true);
      const response = await getGroupMessages(groupId);
      setGroupMessages(normalizeGroupMessages(response).map(normalizeMessage));
      setError('');
    } catch (err) {
      setError(err?.message || 'Failed to load conversation messages.');
    } finally {
      setLoadingMessages(false);
    }
  };

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
      const created = await createDirectMessage(nextTarget);
      const groupId = created?.groupId;
      await loadConversations();
      if (groupId) {
        setSelectedGroup(groupId);
        await loadMessages(groupId);
      }
      setTargetId('');
      setTimeout(() => {
        setError('');
      }, 1);
    } catch (err) {
      setError(err?.message || 'Failed to create message thread.');
    } finally {
      setConversationBusy(false);
    }
  };

  const selectConversation = (groupId) => {
    setSelectedGroup(groupId);
    void loadMessages(groupId);
  };

  const handleSendMessage = async (event) => {
    event.preventDefault();
    const text = messageText().trim();
    const groupId = selectedGroup();

    if (!groupId) {
      setError('Select a conversation first.');
      return;
    }

    if (!text) {
      setError('Type a message first.');
      return;
    }

    try {
      setSendingMessage(true);
      setError('');
      await sendGroupMessage(groupId, text);
      setMessageText('');
      await loadMessages(groupId);
    } catch (err) {
      setError(err?.message || 'Failed to send message.');
    } finally {
      setSendingMessage(false);
    }
  };

  createEffect(() => {
    if (!isAuthenticated()) {
      return;
    }
    void loadConversations();
  });

  createEffect(() => {
    if (isAuthenticated() && selectedGroup()) {
      void loadMessages(selectedGroup());
    }
  });

  return (
    <section class="messages-page">
      <h1>Messages</h1>
      <Show when={!isAuthenticated()}>
        <p class="login-notice">
          Sign in to access direct messages.
        </p>
      </Show>

      <Show when={error()}>
        <p class="error">{error()}</p>
      </Show>

      <Show when={isAuthenticated()}>
        <form class="messages-compose" onSubmit={startConversation}>
          <label class="form-group">
            <span>Start or open direct message (user id)</span>
            <input
              type="text"
              class="form-input"
              value={targetId()}
              onInput={(event) => setTargetId(event.target.value)}
              placeholder="e.g. 24"
              disabled={conversationBusy()}
            />
          </label>
          <div class="messages-actions">
            <button
              type="submit"
              class="post-action submit-button"
              disabled={conversationBusy()}
            >
              {conversationBusy() ? 'Opening…' : 'Open'}
            </button>
            <button
              type="button"
              class="post-action"
              disabled={loading()}
              onClick={() => void loadConversations()}
            >
              Refresh List
            </button>
          </div>
        </form>

        <div class="messages-layout">
          <section class="messages-conversations">
            <h2>Conversations</h2>
            <Show when={loading()}>
              <p class="muted">Loading conversations…</p>
            </Show>
            <Show when={!loading() && directs().length === 0}>
              <p class="muted">No direct messages yet.</p>
            </Show>
            <ul class="message-thread-list">
              <For each={directs()}>
                {(conversation) => {
                  const groupId = conversation.group_id || conversation.groupId;
                  const participants = getParticipantLabel(conversation);
                  return (
                    <li>
                      <button
                        type="button"
                        class={`message-thread-item ${selectedGroup() === groupId ? 'active' : ''}`}
                        onClick={() => selectConversation(groupId)}
                      >
                        <div class="message-thread-title">
                          {participants || conversation.other_user_id || 'Direct message'}
                        </div>
                        <div class="muted">
                          {groupId}
                        </div>
                      </button>
                    </li>
                  );
                }}
              </For>
            </ul>
          </section>

          <section class="messages-content">
            <h2>Conversation</h2>
            <Show when={!selectedGroup()}>
              <p class="muted">Pick a conversation to view messages.</p>
            </Show>
            <Show when={selectedGroup()}>
              <div class="message-thread-controls">
                <button
                  type="button"
                  class="post-action"
                  onClick={() => void loadMessages(selectedGroup())}
                  disabled={loadingMessages()}
                >
                  {loadingMessages() ? 'Refreshing…' : 'Refresh'}
                </button>
              </div>
            </Show>

            <Show when={loadingMessages()}>
              <p class="muted">Loading messages…</p>
            </Show>
            <Show when={!loadingMessages() && groupMessages().length === 0 && selectedGroup()}>
              <p class="muted">No messages in this conversation yet.</p>
            </Show>
            <ul class="message-content-list">
              <For each={groupMessages()}>
                {(msg) => (
                  <li class={`message-content-item ${msg.isOwn ? 'sent' : 'received'}`}>
                    <div class="message-meta">
                      <span>{msg.isOwn ? 'You' : `User ${msg.sender_user_id || msg.senderId || 'system'}`}</span>
                      <span>{msg.created_at ? new Date(msg.created_at).toLocaleString() : ''}</span>
                    </div>
                    <div class="message-body">
                      {msg.message_type || 'application'}
                    </div>
                    <div class="message-text">
                      {formatMessageText(msg)}
                    </div>
                  </li>
                )}
              </For>
            </ul>

            <Show when={selectedGroup()}>
              <form class="message-compose-form" onSubmit={handleSendMessage}>
                <label class="form-group">
                  <span>New message</span>
                  <textarea
                    rows="4"
                    class="form-textarea"
                    value={messageText()}
                    onInput={(event) => setMessageText(event.target.value)}
                    placeholder="Write a message..."
                    disabled={sendingMessage()}
                  />
                </label>
                <button
                  type="submit"
                  class="post-action submit-button"
                  disabled={sendingMessage()}
                >
                  {sendingMessage() ? 'Sending…' : 'Send'}
                </button>
              </form>
            </Show>
          </section>
        </div>
      </Show>
    </section>
  );
}
