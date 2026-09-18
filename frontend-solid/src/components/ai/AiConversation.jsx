import { createEffect, createSignal, For, onMount, Show } from 'solid-js';
import ai from '../../store/aiStore';
import './ai.css';

export default function AiConversation(props) {
  const [confirmDelete, setConfirmDelete] = createSignal(false);
  const state = ai.state;
  let messages;
  const busy = () => state.loading || state.sending;
  onMount(() => { if (!props.drawer) void ai.initialize(); });
  createEffect(() => {
    void state.messages.length;
    void state.sending;
    if (messages) messages.scrollTop = messages.scrollHeight;
  });
  createEffect(() => { void state.conversation?.id; setConfirmDelete(false); });

  return (
    <div class="ai-conversation">
      <div class="ai-toolbar">
        <select aria-label="AI conversation" disabled={busy()} value={state.conversation?.id || ''}
          onChange={(e) => { if (e.currentTarget.value) void ai.select(e.currentTarget.value); }}>
          <option value="" selected={!state.conversation}>New conversation</option>
          <For each={state.conversations}>{(c) => <option value={c.id} selected={String(c.id) === String(state.conversation?.id)}>{c.title || 'Private AI chat'}</option>}</For>
        </select>
        <button type="button" onClick={() => ai.start()} disabled={busy()}>New</button>
        <Show when={state.conversation}>
          <button type="button" aria-label="Delete AI conversation" onClick={() => setConfirmDelete(true)} disabled={busy()}>Delete</button>
        </Show>
      </div>
      <Show when={confirmDelete()}>
        <div class="ai-delete-confirm">
          <span>Delete this AI conversation and its history?</span>
          <button type="button" disabled={busy()} onClick={async () => { await ai.remove(); setConfirmDelete(false); }}>Delete history</button>
          <button type="button" onClick={() => setConfirmDelete(false)}>Keep</button>
        </div>
      </Show>
      <p class="ai-privacy">Private AI chat · Sent to your chosen provider using your API key. Not end-to-end encrypted.</p>
      <Show when={state.conversation?.post_id}>
        <a class="ai-context" href={`#post/${state.conversation.post_id}`} onClick={() => props.drawer && ai.close()}>
          Context: post #{state.conversation.post_id}
        </a>
      </Show>
      <Show when={state.settings && !state.settings.configured}>
        <div class="ai-setup">
          <strong>Choose your AI</strong>
          <p>Add your provider, model and API key in settings to start chatting.</p>
          <a href="#settings" onClick={() => ai.close()}>Open AI settings</a>
        </div>
      </Show>
      <div class="ai-messages" ref={messages} role="log" aria-label="Private AI messages" aria-live="polite" aria-busy={state.sending}>
        <Show when={!state.messages.length && state.settings?.configured && !state.loading}>
          <div class="ai-empty">
            <strong>What would you like to explore?</strong>
            <p>{state.conversation?.post_id ? 'Ask about this post, summarize the thread, or challenge an argument.' : 'Ask a question, explore an idea, or open AI on a post for context.'}</p>
            <Show when={state.conversation?.post_id}>
              <div class="ai-suggestions">
                <For each={['Summarize this discussion', 'Challenge this argument', 'What evidence would help?']}>
                  {(prompt) => <button type="button" onClick={() => ai.setDraft(prompt)}>{prompt}</button>}
                </For>
              </div>
            </Show>
          </div>
        </Show>
        <For each={state.messages}>{(message) => (
          <article class="ai-message" classList={{ 'ai-message-user': message.role === 'user' }}>
            <div class="ai-message-label">{message.role === 'user' ? 'You' : `AI · ${message.model || state.settings?.model || ''}`}</div>
            <div class="ai-message-content">{message.content}</div>
            <Show when={message.status === 'failed'}><p class="ai-error">This request failed. No answer was saved.</p></Show>
          </article>
        )}</For>
        <Show when={state.sending}>
          <article class="ai-message ai-message-user"><div class="ai-message-label">You</div><div class="ai-message-content">{state.pending?.message}</div></article>
          <p role="status" class="ai-status">AI is thinking…</p>
        </Show>
        <Show when={state.loading}><p role="status" class="ai-status">Loading…</p></Show>
      </div>
      <Show when={state.error}><p role="alert" class="ai-error">{state.error}</p></Show>
      <Show when={state.pending?.failed}><p class="ai-privacy">A new attempt may use additional provider credits.</p></Show>
      <form class="ai-composer" onSubmit={(e) => { e.preventDefault(); void (state.pending?.failed ? ai.newAttempt() : ai.send()); }}>
        <label class="ai-sr-only" for={`ai-prompt-${props.drawer ? 'drawer' : 'dm'}`}>Message AI</label>
        <textarea id={`ai-prompt-${props.drawer ? 'drawer' : 'dm'}`} rows="2" maxLength="8000"
          placeholder="Ask anything…" value={state.draft} disabled={busy() || !state.settings?.configured}
          onInput={(e) => ai.setDraft(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
              e.preventDefault();
              if (!state.pending?.failed) void ai.send();
            }
          }} />
        <button type="submit" disabled={busy() || !state.draft.trim() || !state.settings?.configured}>
          {state.sending ? 'Thinking…' : state.pending?.failed ? 'Start new attempt' : state.pending?.message === state.draft.trim() ? 'Retry' : 'Send'}
        </button>
      </form>
      <div class="ai-footer">{state.settings?.model || 'Your model'} · Answers may be inaccurate · No live web search</div>
    </div>
  );
}
