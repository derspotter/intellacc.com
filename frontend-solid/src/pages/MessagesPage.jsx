import {
  createEffect,
  createSignal,
  For,
  Show
} from 'solid-js';
import {
  createDirectMessage,
  getDirectMessages,
  getGroupMessages
} from '../services/api';
import { isAuthenticated } from '../services/auth';

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

export default function MessagesPage() {
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal('');
  const [directs, setDirects] = createSignal([]);
  const [selectedGroup, setSelectedGroup] = createSignal('');
  const [groupMessages, setGroupMessages] = createSignal([]);
  const [loadingMessages, setLoadingMessages] = createSignal(false);
  const [conversationBusy, setConversationBusy] = createSignal(false);
  const [targetId, setTargetId] = createSignal('');

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
      setGroupMessages(normalizeRows(response));
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
      }
      setTargetId('');
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
          <button
            type="submit"
            class="post-action submit-button"
            disabled={conversationBusy()}
          >
            {conversationBusy() ? 'Opening…' : 'Open'}
          </button>
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
                  const users = conversation.participant_usernames || conversation.users;
                  return (
                    <li>
                      <button
                        type="button"
                        class={`message-thread-item ${selectedGroup() === groupId ? 'active' : ''}`}
                        onClick={() => selectConversation(groupId)}
                      >
                        <div>{groupId}</div>
                        <div class="muted">
                          {users
                            ? Array.isArray(users)
                              ? users.join(', ')
                              : String(users)
                            : 'Direct message'}
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
              <Show when={loadingMessages()}>
                <p class="muted">Loading messages…</p>
              </Show>
              <Show when={!loadingMessages() && groupMessages().length === 0}>
                <p class="muted">No messages in this conversation yet.</p>
              </Show>
              <ul class="message-content-list">
                <For each={groupMessages()}>
                  {(msg) => (
                    <li class="message-content-item">
                      <div class="message-meta">
                        <span>#{msg.id || 'msg'}</span>
                        <span>{msg.created_at ? new Date(msg.created_at).toLocaleString() : ''}</span>
                      </div>
                      <div class="message-body">
                        {msg.message_type || msg.type || 'application'}
                      </div>
                      <div class="message-text">
                        {msg.data?.text || msg.content || JSON.stringify(msg.data || msg) || 'Message content unavailable'}
                      </div>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
          </section>
        </div>
      </Show>
    </section>
  );
}
