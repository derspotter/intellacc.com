import {
  createEffect,
  createSignal,
  For,
  Show
} from 'solid-js';
import {
  deleteNotification,
  getNotifications,
  getUnreadNotificationCount,
  markAllNotificationsRead,
  markNotificationRead
} from '../services/api';
import { isAuthenticated } from '../services/auth';

const normalizeNotifications = (payload) => {
  if (Array.isArray(payload)) {
    return payload;
  }
  if (Array.isArray(payload?.items)) {
    return payload.items;
  }
  if (Array.isArray(payload?.notifications)) {
    return payload.notifications;
  }
  return [];
};

const getUnreadCount = (notifications) => notifications.filter((notification) => !notification.read).length;

export default function NotificationsPage() {
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal('');
  const [notifications, setNotifications] = createSignal([]);
  const [unreadOnly, setUnreadOnly] = createSignal(false);
  const [offset, setOffset] = createSignal(0);
  const [hasMore, setHasMore] = createSignal(false);
  const [limit] = createSignal(25);
  const [unreadCount, setUnreadCount] = createSignal(0);

  const loadList = async (reset = false) => {
    if (!isAuthenticated()) {
      return;
    }

    try {
      setLoading(true);
      setError('');
      const response = await getNotifications({
        limit: limit(),
        offset: reset ? 0 : offset(),
        unreadOnly: unreadOnly()
      });

      const rows = normalizeNotifications(response);
      const offsetIncrement = rows.length < limit() ? rows.length : limit();
      const count = await getUnreadNotificationCount().catch(() => ({ count: 0 }));

      if (reset) {
        setNotifications(rows);
        setOffset(offsetIncrement);
      } else {
        setNotifications((current) => [...current, ...rows]);
        setOffset((current) => current + rows.length);
      }

      setHasMore(rows.length >= limit());
      setUnreadCount(Number(count?.count || rows.filter((item) => !item.read).length));
    } catch (err) {
      setError(err?.message || 'Failed to load notifications.');
    } finally {
      setLoading(false);
    }
  };

  const handleMarkRead = async (notification) => {
    try {
      await markNotificationRead(notification.id);
      setNotifications((current) =>
        current.map((item) =>
          item.id === notification.id ? { ...item, read: true } : item
        )
      );
      setUnreadCount((current) => Math.max(0, current - 1));
    } catch (err) {
      setError(err?.message || 'Failed to mark notification as read.');
    }
  };

  const handleDelete = async (notification) => {
    try {
      await deleteNotification(notification.id);
      setNotifications((current) => current.filter((item) => item.id !== notification.id));
      if (!notification.read) {
        setUnreadCount((current) => Math.max(0, current - 1));
      }
    } catch (err) {
      setError(err?.message || 'Failed to delete notification.');
    }
  };

  const handleMarkAllRead = async () => {
    try {
      await markAllNotificationsRead();
      setNotifications((current) => current.map((item) => ({ ...item, read: true })));
      setUnreadCount(0);
    } catch (err) {
      setError(err?.message || 'Failed to mark all notifications.');
    }
  };

  createEffect(() => {
    if (!isAuthenticated()) {
      return;
    }
    setOffset(0);
    setHasMore(false);
    setUnreadOnly(unreadOnly());
    void loadList(true);
  });

  return (
    <section class="notifications-page">
      <h1>Notifications</h1>
      <Show when={!isAuthenticated()}>
        <p class="login-notice">
          Sign in to view notifications.
        </p>
      </Show>

      <Show when={isAuthenticated()}>
        <div class="notifications-toolbar">
          <div class="notifications-filter">
            <button
              type="button"
              class={`post-action ${!unreadOnly() ? 'submit-button' : ''}`}
              onClick={() => setUnreadOnly(false)}
            >
              All
            </button>
            <button
              type="button"
              class={`post-action ${unreadOnly() ? 'submit-button' : ''}`}
              onClick={() => setUnreadOnly(true)}
            >
              Unread
            </button>
          </div>
          <button
            type="button"
            class="post-action"
            onClick={handleMarkAllRead}
            disabled={unreadCount() === 0}
          >
            Mark all read
          </button>
        </div>

        <p class="muted">
          {unreadCount()} unread notification{unreadCount() === 1 ? '' : 's'}
        </p>

        <Show when={error()}>
          <p class="error">{error()}</p>
        </Show>

        <Show when={loading()}>
          <p class="muted">Loading notifications…</p>
        </Show>

        <Show when={!loading() && notifications().length === 0}>
          <p class="muted">No notifications yet.</p>
        </Show>

        <ul class="notification-list">
          <For each={notifications()}>
            {(notification) => (
              <li class={`notification-item-row ${notification.read ? '' : 'unread'}`}>
                <div class="notification-main">
                  <h3>{notification.type || 'Notification'}</h3>
                  <p>{notification.message || notification.text || 'No message content'}</p>
                  <p class="muted">
                    {notification.created_at ? new Date(notification.created_at).toLocaleString() : ''}
                  </p>
                </div>
                <div class="notification-actions">
                  <button
                    type="button"
                    class="post-action"
                    onClick={() => handleMarkRead(notification)}
                    disabled={Boolean(notification.read)}
                  >
                    Mark read
                  </button>
                  <button
                    type="button"
                    class="post-action"
                    onClick={() => handleDelete(notification)}
                  >
                    Delete
                  </button>
                </div>
              </li>
            )}
          </For>
        </ul>

        <Show when={hasMore()}>
          <div class="form-actions">
            <button
              type="button"
              class="post-action submit-button"
              onClick={() => void loadList(false)}
              disabled={loading()}
            >
              {loading() ? 'Loading…' : 'Load more'}
            </button>
          </div>
        </Show>
      </Show>
    </section>
  );
}
