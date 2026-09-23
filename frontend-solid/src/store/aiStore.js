import { createStore } from 'solid-js/store';
import { aiApi } from '../services/api';

const initial = () => ({
  open: false, dm: false, settings: null, conversations: [], conversation: null, messages: [],
  loading: false, sending: false, error: '', draft: '', pending: null, notice: ''
});
const [state, setState] = createStore(initial());
let epoch = 0;
let identity;
let opener;

const resetForUser = (id) => {
  if (identity === id) return;
  identity = id;
  epoch++;
  opener = null;
  setState(initial());
};

const refreshSettings = async () => {
  const version = epoch;
  const settings = await aiApi.settings();
  if (version === epoch) setState('settings', settings);
  return settings;
};

const select = async (id) => {
  if (state.sending || state.loading) return;
  const version = epoch;
  setState({ loading: true, error: '' });
  try {
    const data = await aiApi.conversation(id);
    if (version === epoch) setState({ conversation: data.conversation, messages: data.messages || [], draft: '', pending: null });
  } catch (err) {
    if (version === epoch) setState('error', err.message || 'Could not load this conversation.');
  } finally {
    if (version === epoch) setState('loading', false);
  }
};

const start = async (postId) => {
  if (state.sending || state.loading) return;
  const version = epoch;
  setState({ loading: true, error: '' });
  try {
    const { conversation } = await aiApi.createConversation(postId);
    if (version === epoch) setState({ conversation, messages: [], draft: '', pending: null,
      conversations: [conversation, ...state.conversations].slice(0, 50) });
  } catch (err) {
    if (version === epoch) setState('error', err.message || 'Could not start a conversation.');
  } finally {
    if (version === epoch) setState('loading', false);
  }
};

const initialize = async (postId) => {
  if (state.loading || state.sending) return;
  const version = epoch;
  setState({ loading: true, error: '' });
  try {
    await refreshSettings();
    if (version !== epoch) return;
    const result = await aiApi.conversations();
    if (version !== epoch) return;
    setState({ conversations: result.conversations || [], loading: false });
    if (postId) {
      const previous = state.conversations.find((c) => Number(c.post_id) === Number(postId));
      if (previous && String(state.conversation?.id) !== String(previous.id)) await select(previous.id);
      else if (!previous) await start(postId);
    } else if (!state.conversation && state.conversations.length) {
      await select(state.conversations[0].id);
    }
  } catch (err) {
    if (version === epoch) setState('error', err.message || 'Could not load AI settings.');
  } finally {
    if (version === epoch) setState('loading', false);
  }
};

const open = (postId) => {
  opener = document.activeElement;
  setState('open', true);
  if (postId && (state.sending || state.loading) && Number(state.conversation?.post_id) !== Number(postId)) {
    setState('notice', 'Wait for the current AI request before switching posts.');
    return;
  }
  void initialize(postId);
};

const close = () => {
  setState('open', false);
  if (opener?.isConnected) opener.focus();
};

const send = async () => {
  const message = state.draft.trim();
  if (!message || state.sending || state.loading || !state.settings?.configured) return;
  const version = epoch;
  // Creation does not invoke a model or incur a provider charge.
  if (!state.conversation) {
    await start();
    if (version !== epoch || !state.conversation) return;
    setState('draft', message);
  }
  const id = state.conversation.id;
  // Reuse the id after a lost response: retrying must not charge twice.
  const requestId = state.pending?.message === message && state.pending?.conversationId === id
    ? state.pending.requestId : crypto.randomUUID();
  setState({ sending: true, error: '', pending: { message, conversationId: id, requestId } });
  try {
    const result = await aiApi.send(id, message, requestId);
    if (version !== epoch) return;
    setState({ messages: [...state.messages, ...(result.messages || [])], draft: '', pending: null });
    const list = await aiApi.conversations().catch(() => null);
    if (version === epoch && list) setState('conversations', list.conversations || []);
  } catch (err) {
    if (version === epoch) {
      setState('error', err.message || 'Could not retrieve the answer. Retry the same message to check its result.');
      if (err.data?.error === 'request_failed' || err.status === 502) setState('pending', 'failed', true);
    }
  } finally {
    if (version === epoch) setState('sending', false);
  }
};

const remove = async () => {
  if (!state.conversation || state.sending || state.loading) return;
  const version = epoch;
  const id = state.conversation.id;
  setState({ loading: true, error: '' });
  try {
    await aiApi.removeConversation(id);
    if (version === epoch) setState({ conversation: null, messages: [], draft: '', pending: null,
      conversations: state.conversations.filter((c) => c.id !== id) });
  } catch (err) {
    if (version === epoch) setState('error', err.message || 'Could not delete this conversation.');
  } finally {
    if (version === epoch) setState('loading', false);
  }
};

export default { state, resetForUser, refreshSettings, initialize, open, close, select, start, send, remove,
  newAttempt: () => { setState('pending', null); return send(); },
  showDm: (value = true) => setState('dm', value),
  setDraft: (draft) => setState('draft', draft),
  setNotice: (notice) => setState('notice', notice)
};
