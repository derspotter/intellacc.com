import { createSignal, onMount, onCleanup, For, Show } from 'solid-js';
import { getGroupMessages, sendGroupMessage } from '../../services/api';
import { joinGroupChat, leaveGroupChat } from '../../services/socket';

export default function GroupChat(props) {
  const [messages, setMessages] = createSignal([]);
  const [text, setText] = createSignal('');
  const [sending, setSending] = createSignal(false);
  let listRef;
  const scrollDown = () => { if (listRef) listRef.scrollTop = listRef.scrollHeight; };
  const append = (m) => { setMessages((cur) => (cur.some((x) => x.id === m.id) ? cur : [...cur, m])); queueMicrotask(scrollDown); };
  const onMsg = (m) => { if (m && m.id) append(m); };

  onMount(async () => {
    try { const r = await getGroupMessages(props.group.slug, { limit: 50 }); setMessages(r.messages || []); queueMicrotask(scrollDown); } catch { /* empty */ }
    joinGroupChat(props.group.id, onMsg);
  });
  onCleanup(() => leaveGroupChat(props.group.id, onMsg));

  const send = async (e) => {
    e.preventDefault();
    const c = text().trim();
    if (!c || sending()) return;
    setSending(true);
    try { await sendGroupMessage(props.group.id, c); setText(''); } catch { /* keep text */ } finally { setSending(false); }
  };

  return (
    <div class="group-chat">
      <div class="group-chat-list" ref={(el) => (listRef = el)}>
        <Show when={messages().length === 0}><p class="groups-empty">No messages yet.</p></Show>
        <For each={messages()}>
          {(m) => (
            <div class="group-chat-msg">
              <span class="group-chat-user">{m.username || `user-${m.user_id}`}</span>
              <span class="group-chat-text">{m.content}</span>
            </div>
          )}
        </For>
      </div>
      <Show when={props.group.is_member} fallback={<p class="groups-empty">Join this group to chat.</p>}>
        <form class="group-chat-form" onSubmit={send}>
          <input class="group-chat-input" value={text()} onInput={(e) => setText(e.currentTarget.value)} placeholder="Message…" maxlength="1000" />
          <button type="submit" class="button primary" disabled={sending()}>Send</button>
        </form>
      </Show>
    </div>
  );
}
