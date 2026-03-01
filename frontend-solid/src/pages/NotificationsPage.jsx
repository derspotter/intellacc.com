import { createEffect, createSignal, For, Show, onCleanup, onMount } from 'solid-js';
import {
  deleteNotification,
  getNotifications,
  getUnreadNotificationCount,
  markAllNotificationsRead,
  markNotificationRead
} from '../services/api';
import { isAuthenticated } from '../services/auth';
import { isPushSupported, getSubscriptionState, subscribeToPush } from '../services/pushService';
import { useSocket } from '../services/socket';
import NotificationItem from '../components/common/NotificationItem';

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

export default function NotificationsPage() {
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal('');
  const [notifications, setNotifications] = createSignal([]);
  const [unreadOnly, setUnreadOnly] = createSignal(false);
  const [hasMore, setHasMore] = createSignal(false);
  const [offset, setOffset] = createSignal(0);
  const [limit] = createSignal(20);
  const [unreadCount, setUnreadCount] = createSignal(0);
  const [pushSupported] = createSignal(isPushSupported());
  const [pushEnabled, setPushEnabled] = createSignal(false);
  const [pushLoading, setPushLoading] = createSignal(false);
  const { connect, getSocket } = useSocket();

  const getNotificationId = (payload) => {
    if (!payload) {
      return '';
    }
    if (typeof payload === 'object') {
      return payload.id || payload.notificationId || '';
    }
    return payload;
  };

  const getNotificationPayload = (payload) => {
    if (!payload || typeof payload !== 'object') {
      return null;
    }

    if (payload.type === 'new' && payload.notification) {
      return payload.notification;
    }

    if (payload.notification && payload.notification.id) {
      return payload.notification;
    }

    return payload;
  };

  const loadList = async (reset = false) => {
    if (!isAuthenticated()) {
      return;
    }

    try {
      setLoading(true);
      setError('');
      const requestOffset = reset ? 0 : offset();
      const response = await getNotifications({
        limit: limit(),
        offset: requestOffset,
        unreadOnly: unreadOnly()
      });

      const rows = normalizeNotifications(response);
      const nextOffset = rows.length < limit() ? 0 : requestOffset + rows.length;
      const count = await getUnreadNotificationCount().catch(() => ({ count: 0 }));

      if (reset) {
        setNotifications(rows);
        setOffset(nextOffset);
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
    const notificationId = getNotificationId(notification);
    if (!notificationId) {
      return;
    }

    try {
      await markNotificationRead(notificationId);
      setNotifications((current) =>
        current.map((item) =>
          String(item.id) === String(notificationId) ? { ...item, read: true } : item
        )
      );
      setUnreadCount((current) => Math.max(0, current - 1));
    } catch (err) {
      setError(err?.message || 'Failed to mark notification as read.');
    }
  };

  const handleDelete = async (notification) => {
    const notificationId = getNotificationId(notification);
    if (!notificationId) {
      return;
    }

    try {
      await deleteNotification(notificationId);
      setNotifications((current) =>
        current.filter((item) => String(item.id) !== String(notificationId))
      );
      const isUnread = typeof notification === 'object' && notification.read !== undefined
        ? !notification.read
        : notifications().some((item) => String(item.id) === String(notificationId) && !item.read);

      if (isUnread) {
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
      setError(err?.message || 'Failed to mark all notifications as read.');
    }
  };

  const handleLoadMore = () => {
    if (!loading() && hasMore()) {
      void loadList();
    }
  };

  const setFilter = (next) => {
    setUnreadOnly(next);
    setOffset(0);
    setHasMore(false);
    setNotifications([]);
    setError('');
    void loadList(true);
  };

  const handleEnablePush = async () => {
    setPushLoading(true);
    setError('');
    try {
      await subscribeToPush();
      setPushEnabled(true);
    } catch (err) {
      setError(err?.message || 'Failed to enable notifications.');
      setPushEnabled(false);
    } finally {
      setPushLoading(false);
    }
  };

  const handleSocketNotification = (payload) => {
    if (!isAuthenticated() || !payload) {
      return;
    }

    if (payload.type === 'unreadCountUpdate') {
      if (typeof payload.count === 'number') {
        setUnreadCount(payload.count);
      }
      return;
    }

    const incoming = getNotificationPayload(payload);
    if (!incoming) {
      return;
    }

    const incomingId = getNotificationId(incoming);
    if (!incomingId) {
      return;
    }

    setNotifications((current) => {
      const filtered = current.filter((item) => String(item.id) !== String(incomingId));
      const next = [incoming, ...filtered];
      setUnreadCount(next.filter((item) => !item.read).length);
      return next;
    });
  };

  const refreshFromSocket = () => {
    const socket = getSocket();
    if (!socket) {
      return null;
    }

    socket.on('notification', handleSocketNotification);
    return () => {
      socket.off('notification', handleSocketNotification);
    };
  };

  const checkPushStatus = async () => {
    if (!isAuthenticated() || !pushSupported()) {
      return;
    }

    try {
      const state = await getSubscriptionState();
      setPushEnabled(state.subscribed);
    } catch {
      setPushEnabled(false);
    }
  };

  createEffect(() => {
    if (!isAuthenticated()) {
      return;
    }
    setOffset(0);
    setHasMore(false);
    setUnreadOnly((current) => current);
    void loadList(true);
  });

  onMount(() => {
    checkPushStatus();

    if (isAuthenticated()) {
      connect();
    }

    const detachSocket = refreshFromSocket();
    onCleanup(() => {
      if (detachSocket) {
        detachSocket();
      }
    });
  });

  return (
    <section class="notifications-page">
      <div class="page-header">
        <h1>Notifications</h1>
        <div class="header-actions">
          <Show when={isAuthenticated() && pushSupported() && !pushEnabled()}>
            <button
              type="button"
              class="enable-push-btn primary-btn"
              onClick={handleEnablePush}
              disabled={pushLoading()}
            >
              {pushLoading() ? 'Enabling...' : 'Enable notifications'}
            </button>
          </Show>

          <div class="filter-buttons">
            <button
              type="button"
              class={`filter-btn ${!unreadOnly() ? 'active' : ''}`}
              onClick={() => setFilter(false)}
            >
              All
            </button>
            <button
              type="button"
              class={`filter-btn ${unreadOnly() ? 'active' : ''}`}
              onClick={() => setFilter(true)}
            >
              Unread
            </button>
          </div>

          <button
            type="button"
            class="mark-all-read-btn"
            onClick={handleMarkAllRead}
            disabled={unreadCount() === 0}
          >
            Mark all read
          </button>
        </div>
      </div>

      <Show when={!isAuthenticated()}>
        <p class="empty-state">Sign in to view notifications.</p>
      </Show>

      <Show when={isAuthenticated()}>
        <p class="muted">{unreadCount()} unread</p>

        <Show when={error()}>
          <div class="error-state">
            <p class="error-message">{error()}</p>
            <button
              type="button"
              class="retry-btn"
              onClick={() => void loadList(true)}
              disabled={loading()}
            >
              Try again
            </button>
          </div>
        </Show>

        <Show when={loading() && notifications().length === 0}>
          <div class="loading-state">
            <div class="loading-spinner" />
            <p>Loading notifications…</p>
          </div>
        </Show>

        <Show when={!loading() && !notifications().length}>
          <div class="empty-state">
            <div class="empty-icon">🔔</div>
            <div class="empty-title">
              {unreadOnly() ? 'No unread notifications' : 'No notifications yet'}
            </div>
            <div class="empty-subtitle">You can expect updates once others interact with your content.</div>
          </div>
        </Show>

        <div class="notifications-page-content">
          <div class="notifications-list" role="list">
            <For each={notifications()}>
              {(notification) => (
                <NotificationItem
                  notification={notification}
                  onMarkAsRead={handleMarkRead}
                  onDelete={handleDelete}
                />
              )}
            </For>
          </div>
        </div>

        <Show when={hasMore()}>
          <div class="load-more-container">
            <button
              type="button"
              class="load-more-btn"
              onClick={handleLoadMore}
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
