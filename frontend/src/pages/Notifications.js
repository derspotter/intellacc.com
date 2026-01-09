import van from 'vanjs-core';
const { div, h1, button, p, span } = van.tags;
import api from '../services/api';
import NotificationItem from '../components/common/NotificationItem';
// import PushPermissionBanner from '../components/common/PushPermissionBanner'; // Removed in favor of header button
import socketService from '../services/socket';
import { isPushSupported, getSubscriptionState, subscribeToPush } from '../services/pushService';

/**
 * Notifications page - displays all user notifications
 * @returns {HTMLElement} Notifications page element
 */
export default function NotificationsPage() {
  const notifications = van.state([]);
  const loading = van.state(true);
  const error = van.state(null);
  const hasMore = van.state(true);
  const offset = van.state(0);
  const filter = van.state('all'); // 'all' or 'unread' - start with 'all'
  const limit = 20;

  // Push notification state
  const pushSupported = van.state(isPushSupported());
  const pushEnabled = van.state(false);
  const pushLoading = van.state(false);

  // Check push status
  const checkPushStatus = async () => {
    if (!pushSupported.val) return;
    try {
      const state = await getSubscriptionState();
      pushEnabled.val = state.subscribed;
    } catch (err) {
      console.error('Error checking push status:', err);
    }
  };

  // Enable push notifications
  const handleEnablePush = async () => {
    pushLoading.val = true;
    try {
      await subscribeToPush();
      pushEnabled.val = true;
      // Show success message or just update UI
    } catch (err) {
      console.error('Error enabling push:', err);
      alert('Failed to enable notifications. Please check your browser settings.');
    } finally {
      pushLoading.val = false;
    }
  };

  // Load notifications
  const loadNotifications = async (reset = false) => {
    try {
      console.log('🔔 Loading notifications - reset:', reset, 'filter:', filter.val);
      loading.val = true;
      error.val = null;

      const currentOffset = reset ? 0 : offset.val;
      console.log('📤 API call parameters:', { limit, offset: currentOffset, unreadOnly: filter.val === 'unread' });

      const result = await api.notifications.getAll({
        limit,
        offset: currentOffset,
        unreadOnly: filter.val === 'unread'
      });

      console.log('📥 API response:', result);

      if (reset) {
        notifications.val = result.notifications;
        offset.val = limit;
      } else {
        notifications.val = [...notifications.val, ...result.notifications];
        offset.val += limit;
      }

      hasMore.val = result.notifications.length === limit;
      console.log('✅ Notifications loaded:', notifications.val.length, 'notifications');
      console.log('📋 First notification:', notifications.val[0]);
      console.log('🔍 Notifications state check - length:', notifications.val.length, 'loading:', loading.val, 'error:', error.val);

    } catch (err) {
      console.error('❌ Error loading notifications:', err);
      error.val = 'Failed to load notifications';
    } finally {
      console.log('🏁 Setting loading to false');
      loading.val = false;
      console.log('🏁 Loading state is now:', loading.val);
    }
  };

  // Load more notifications
  const loadMore = () => {
    if (!loading.val && hasMore.val) {
      loadNotifications(false);
    }
  };

  // Mark all as read
  const markAllAsRead = async () => {
    try {
      await api.notifications.markAllAsRead();

      // Update local state
      notifications.val = notifications.val.map(n => ({ ...n, read: true }));

      // Update bell count
      if (window.NotificationBell) {
        window.NotificationBell.refresh();
      }

    } catch (err) {
      console.error('Error marking all as read:', err);
      error.val = 'Failed to mark all as read';
    }
  };

  // Handle notification marked as read
  const handleNotificationRead = (notificationId) => {
    notifications.val = notifications.val.map(n =>
      n.id === notificationId ? { ...n, read: true } : n
    );

    // Update bell count
    if (window.NotificationBell) {
      window.NotificationBell.refresh();
    }
  };

  // Handle notification deleted
  const handleNotificationDeleted = (notificationId) => {
    notifications.val = notifications.val.filter(n => n.id !== notificationId);

    // Update bell count
    if (window.NotificationBell) {
      window.NotificationBell.refresh();
    }
  };

  // Socket notification handler
  const handleSocketNotification = (data) => {
    console.log('Notification received in page:', data);

    if (data.type === 'new' && data.notification) {
      // Add new notification to the top of the list
      notifications.val = [data.notification, ...notifications.val];
    }
  };

  // Register socket handler
  const unregister = socketService.on('notification', handleSocketNotification);

  // Handle filter change
  const handleFilterChange = (newFilter) => {
    if (filter.val !== newFilter) {
      filter.val = newFilter;
      loadNotifications(true);
    }
  };

  // Load initial notifications and push status
  loadNotifications(true);
  checkPushStatus();

  // Cleanup on unmount
  const pageElement = div({ class: "notifications-page" }, [
    div({ class: "page-header" }, [
      h1("Notifications"),

      div({ class: "header-actions" }, [
        // Enable Notifications Button (only if supported and not enabled)
        () => pushSupported.val && !pushEnabled.val
          ? button({
            class: "enable-push-btn primary-btn",
            onclick: handleEnablePush,
            disabled: pushLoading,
            style: "margin-right: 0.5rem; background-color: var(--primary-dark);" // Distinct style
          }, pushLoading.val ? "Enabling..." : "Enable Notifications 🔔")
          : null,

        // Filter buttons
        div({ class: "filter-buttons" }, [
          button({
            class: () => `filter-btn ${filter.val === 'all' ? 'active' : ''}`,
            onclick: () => handleFilterChange('all')
          }, "All"),
          button({
            class: () => `filter-btn ${filter.val === 'unread' ? 'active' : ''}`,
            onclick: () => handleFilterChange('unread')
          }, "Unread")
        ]),

        // Mark all read button
        button({
          class: "mark-all-read-btn primary-btn",
          onclick: markAllAsRead,
          disabled: () => notifications.val.filter(n => !n.read).length === 0
        }, "Mark all as read")
      ])
    ]),

    // Content
    () => {
      console.log('🔄 Content render - loading:', loading.val, 'notifications:', notifications.val.length, 'error:', error.val);

      return div({ class: "notifications-page-content" }, [
        // Push permission banner - REMOVED
        // PushPermissionBanner(),

        // Loading state
        loading.val && notifications.val.length === 0
          ? div({ class: "loading-state" }, [
            div({ class: "loading-spinner" }),
            p("Loading notifications...")
          ])
          : null,

        // Error state
        error.val
          ? div({ class: "error-state" }, [
            p({ class: "error-message" }, error.val),
            button({
              class: "retry-btn",
              onclick: () => loadNotifications(true)
            }, "Try again")
          ])
          : null,

        // Empty state
        !loading.val && notifications.val.length === 0 && !error.val
          ? div({ class: "empty-state" }, [
            div({ class: "empty-icon" }, "🔔"),
            p({ class: "empty-title" },
              filter.val === 'unread' ? "No unread notifications" : "No notifications yet"
            ),
            p({ class: "empty-subtitle" },
              "When someone likes, comments, or follows you, you'll see it here."
            )
          ])
          : null,

        // Notifications list
        !loading.val && notifications.val.length > 0
          ? div({ class: "notifications-list" }, [
            ...notifications.val.map(notification => {
              console.log('🔸 Rendering notification:', notification.id, notification.type);
              return NotificationItem({
                notification,
                onMarkAsRead: handleNotificationRead,
                onDelete: handleNotificationDeleted
              });
            }),

            // Load more button
            hasMore.val
              ? div({ class: "load-more-container" }, [
                button({
                  class: "load-more-btn",
                  onclick: loadMore,
                  disabled: () => loading.val
                }, () => loading.val ? "Loading..." : "Load more")
              ])
              : null
          ])
          : null
      ]);
    }
  ]);

  // Store cleanup function
  pageElement._cleanup = () => {
    unregister?.();
  };

  return pageElement;
}