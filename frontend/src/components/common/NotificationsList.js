import van from 'vanjs-core';
const { div, button, h3, p } = van.tags;
import api from '../../services/api';
import NotificationItem from './NotificationItem';
import socketService from '../../services/socket';

/**
 * Notifications list component - displays notifications in a dropdown or modal
 * @param {Object} props - Component props  
 * @param {boolean} props.isOpen - Whether the dropdown is open
 * @param {Function} props.onClose - Function to call when closing the dropdown
 * @param {Function} props.onUnreadCountChange - Callback when unread count changes
 * @returns {HTMLElement} Notifications list element
 */
export default function NotificationsList({ isOpen, onClose, onUnreadCountChange }) {
  const notifications = van.state([]);
  const loading = van.state(false);
  const error = van.state(null);
  const hasMore = van.state(true);
  const offset = van.state(0);
  const limit = 20;

  // Load notifications
  const loadNotifications = async (reset = false) => {
    try {
      loading.val = true;
      error.val = null;

      const currentOffset = reset ? 0 : offset.val;
      const result = await api.notifications.getAll({
        limit,
        offset: currentOffset,
        unreadOnly: false
      });

      if (reset) {
        notifications.val = result.notifications;
        offset.val = limit;
      } else {
        notifications.val = [...notifications.val, ...result.notifications];
        offset.val += limit;
      }

      hasMore.val = result.notifications.length === limit;

      // Update unread count
      const unreadCount = notifications.val.filter(n => !n.read).length;
      onUnreadCountChange?.(unreadCount);

    } catch (err) {
      console.error('Error loading notifications:', err);
      error.val = 'Failed to load notifications';
    } finally {
      loading.val = false;
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
      onUnreadCountChange?.(0);
      
    } catch (err) {
      console.error('Error marking all as read:', err);
    }
  };

  // Handle notification marked as read
  const handleNotificationRead = (notificationId) => {
    notifications.val = notifications.val.map(n => 
      n.id === notificationId ? { ...n, read: true } : n
    );
    
    const unreadCount = notifications.val.filter(n => !n.read).length;
    onUnreadCountChange?.(unreadCount);
  };

  // Handle notification deleted
  const handleNotificationDeleted = (notificationId) => {
    notifications.val = notifications.val.filter(n => n.id !== notificationId);
    
    const unreadCount = notifications.val.filter(n => !n.read).length;
    onUnreadCountChange?.(unreadCount);
  };

  // Socket notification handler
  const handleSocketNotification = (data) => {
    console.log('Notification received in list:', data);
    
    if (data.type === 'new' && data.notification) {
      // Add new notification to the top of the list if dropdown is open
      if (isOpen.val) {
        notifications.val = [data.notification, ...notifications.val];
        
        // Update unread count
        const unreadCount = notifications.val.filter(n => !n.read).length;
        onUnreadCountChange?.(unreadCount);
      }
    }
  };

  // Register socket handler when component is created
  const unregister = socketService.on('notification', handleSocketNotification);

  // Load notifications when component opens
  van.derive(() => {
    if (isOpen.val && notifications.val.length === 0) {
      loadNotifications(true);
    }
  });

  // Don't render if not open
  if (!isOpen.val) return null;

  return div({ class: "notifications-dropdown" }, [
    // Header
    div({ class: "notifications-header" }, [
      h3({ class: "notifications-title" }, "Notifications"),
      
      div({ class: "notifications-actions" }, [
        button({
          class: "mark-all-read-btn",
          onclick: markAllAsRead,
          disabled: () => notifications.val.filter(n => !n.read).length === 0
        }, "Mark all read"),
        
        button({
          class: "close-btn",
          onclick: onClose
        }, "×")
      ])
    ]),

    // Content
    div({ class: "notifications-content" }, [
      // Loading state
      () => loading.val && notifications.val.length === 0
        ? div({ class: "notifications-loading" }, "Loading notifications...")
        : null,

      // Error state
      () => error.val
        ? div({ class: "notifications-error" }, error.val)
        : null,

      // Empty state
      () => !loading.val && notifications.val.length === 0 && !error.val
        ? div({ class: "notifications-empty" }, [
            p("No notifications yet"),
            p({ class: "empty-subtitle" }, "When someone likes, comments, or follows you, you'll see it here.")
          ])
        : null,

      // Notifications list
      () => notifications.val.length > 0
        ? div({ class: "notifications-list" }, 
            notifications.val.map(notification => 
              NotificationItem({
                notification,
                onMarkAsRead: handleNotificationRead,
                onDelete: handleNotificationDeleted
              })
            )
          )
        : null,

      // Load more button
      () => hasMore.val && notifications.val.length > 0
        ? button({
            class: "load-more-btn",
            onclick: loadMore,
            disabled: () => loading.val
          }, () => loading.val ? "Loading..." : "Load more")
        : null
    ])
  ]);
}

// Export function to refresh notifications list
NotificationsList.refresh = (listInstance) => {
  if (listInstance && listInstance.loadNotifications) {
    listInstance.loadNotifications(true);
  }
};