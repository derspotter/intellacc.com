import { For, Show, createSignal, onCleanup, onMount } from 'solid-js';
import {
  deleteNotification,
  getNotifications,
  getUnreadNotificationCount,
  markAllNotificationsRead,
  markNotificationRead
} from '../../../services/api';
import { registerSocketEventHandler } from '../../../services/socket';

const PAGE = 20;

const unwrap = (payload) => {
  if (!payload) return null;
  if (payload.notification) return payload.notification;
  if (payload.type === 'unreadCountUpdate') return null;
  return payload.id != null ? payload : null;
};

const actionText = (n) => {
  const who = n.actor_username || 'SOMEONE';
  const map = {
    like: 'LIKED YOUR POST',
    comment: 'COMMENTED ON YOUR POST',
    reply: 'REPLIED TO YOU',
    follow: 'FOLLOWED YOU',
    mention: 'MENTIONED YOU'
  };
  return `@${who} ${map[n.type] || 'SENT A NOTIFICATION'}`;
};

export default function NotificationsView() {
  const [items, setItems] = createSignal([]);
  const [unread, setUnread] = createSignal(0);
  const [hasMore, setHasMore] = createSignal(false);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal('');

  const normalize = (v) => Array.isArray(v) ? v : (v?.items || v?.notifications || []);

  const load = async (reset) => {
    if (loading()) return;
    setLoading(true);
    setError('');
    try {
      const offset = reset ? 0 : items().length;
      const rows = normalize(await getNotifications({ limit: PAGE, offset }));
      setItems(reset ? rows : (prev => {
        const seen = new Set(prev.map(i => String(i.id)));
        return [...prev, ...rows.filter(r => !seen.has(String(r.id)))];
      })(items()));
      setHasMore(rows.length >= PAGE);
      const c = await getUnreadNotificationCount().catch(() => null);
      setUnread(Math.max(0, Number(c?.count ?? items().filter(i => !i.read).length) || 0));
    } catch (e) {
      setError(e?.message || 'FAILED TO LOAD NOTIFICATIONS');
    } finally {
      setLoading(false);
    }
  };

  onMount(() => {
    load(true);
    const off = registerSocketEventHandler('notification', (payload) => {
      const n = unwrap(payload);
      if (payload?.type === 'unreadCountUpdate') { setUnread(Math.max(0, Number(payload.count) || 0)); return; }
      if (!n) return;
      setItems((prev) => prev.some(i => String(i.id) === String(n.id)) ? prev : [n, ...prev]);
      setUnread((u) => u + (n.read ? 0 : 1));
    });
    if (typeof off === 'function') onCleanup(off);
  });

  const markOne = async (n) => {
    if (n.read) return;
    setItems((prev) => prev.map(i => i.id === n.id ? { ...i, read: true } : i));
    setUnread((u) => Math.max(0, u - 1));
    try { await markNotificationRead(n.id); } catch { load(true); }
  };

  const markAll = async () => {
    setItems((prev) => prev.map(i => ({ ...i, read: true })));
    setUnread(0);
    try { await markAllNotificationsRead(); } catch { load(true); }
  };

  const remove = async (n) => {
    setItems((prev) => prev.filter(i => i.id !== n.id));
    if (!n.read) setUnread((u) => Math.max(0, u - 1));
    try { await deleteNotification(n.id); } catch { load(true); }
  };

  const open = (n) => {
    markOne(n);
    if (n.type === 'follow' && n.actor_id) window.location.hash = `#user/${n.actor_id}`;
  };

  return (
    <div class="h-full flex flex-col font-mono text-sm">
      <div class="shrink-0 flex items-center justify-between px-3 py-2 border-b border-bb-border bg-bb-panel text-xs">
        <span>UNREAD: <span data-testid="notifications-unread" class="text-bb-accent font-bold">{unread()}</span></span>
        <button
          type="button"
          data-testid="notifications-mark-all"
          onClick={markAll}
          class="px-2 py-0.5 border border-bb-border text-bb-muted hover:text-bb-accent hover:border-bb-accent uppercase font-bold"
        >
          [MARK ALL READ]
        </button>
      </div>

      <div class="flex-1 overflow-y-auto custom-scrollbar">
        <Show when={error()}>
          <div class="p-3 text-market-down text-xs">ERROR // {error().toUpperCase()}</div>
        </Show>
        <Show when={items().length > 0} fallback={
          <Show when={!loading()}>
            <div class="p-4 text-bb-muted">NO NOTIFICATIONS</div>
          </Show>
        }>
          <For each={items()}>
            {(n) => (
              <div
                data-testid="notification-row"
                class={`px-3 py-2 border-b border-bb-border/20 flex gap-3 items-baseline cursor-pointer hover:bg-white/5 ${n.read ? 'text-bb-muted' : 'text-bb-text'}`}
                onClick={() => open(n)}
              >
                <span class={`shrink-0 text-xxs ${n.read ? 'text-bb-muted' : 'text-bb-accent font-bold'}`}>{n.read ? '·' : '[N]'}</span>
                <span class="min-w-0 flex-1">
                  <span class={n.read ? '' : 'font-bold'}>{actionText(n)}</span>
                  <Show when={n.target_content}>
                    <span class="text-bb-muted"> // {String(n.target_content).slice(0, 120)}</span>
                  </Show>
                </span>
                <span class="shrink-0 text-xxs text-bb-muted">{n.created_at ? new Date(n.created_at).toLocaleString() : ''}</span>
                <button
                  type="button"
                  class="shrink-0 text-bb-muted hover:text-market-down text-xxs"
                  onClick={(e) => { e.stopPropagation(); remove(n); }}
                >
                  [X]
                </button>
              </div>
            )}
          </For>
        </Show>
        <Show when={loading()}>
          <div class="p-3 text-bb-muted animate-pulse text-xs">RUNNING QUERY...</div>
        </Show>
        <Show when={hasMore() && !loading()}>
          <button
            type="button"
            data-testid="notifications-load-more"
            class="w-full py-2 text-center text-bb-accent hover:bg-bb-accent/10 uppercase font-bold text-xs"
            onClick={() => load(false)}
          >
            LOAD MORE
          </button>
        </Show>
      </div>
    </div>
  );
}
