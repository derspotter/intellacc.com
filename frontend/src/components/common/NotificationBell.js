import van from 'vanjs-core';
const { div, button, span } = van.tags;
import api from '../../services/api';

/**
 * Notification bell component for the sidebar
 * Shows unread notification count and toggles notification dropdown
 * @param {Object} props - Component props
 * @param {Function} props.onClick - Function to call when bell is clicked
 * @returns {HTMLElement} Notification bell element
 */
export default function NotificationBell({ onClick }) {
  const unreadCount = van.state(0);
  const loading = van.state(false);

  // Load unread count on component creation
  const loadUnreadCount = async () => {
    try {
      loading.val = true;
      const result = await api.notifications.getUnreadCount();
      unreadCount.val = result.count;
    } catch (error) {
      console.error('Error loading unread count:', error);
    } finally {
      loading.val = false;
    }
  };

  // Load initial count
  loadUnreadCount();

  // Auto-refresh every 30 seconds
  setInterval(loadUnreadCount, 30000);

  return div({ class: "notification-bell-container" }, [
    button({
      class: () => `notification-bell ${unreadCount.val > 0 ? 'has-unread' : ''}`,
      onclick: () => onClick?.(),
      disabled: () => loading.val,
      title: () => `${unreadCount.val} unread notifications`
    }, [
      // Bell icon (using Unicode bell symbol)
      span({ class: "bell-icon" }, "🔔"),
      
      // Unread count badge
      () => unreadCount.val > 0 
        ? span({ class: "unread-badge" }, 
            unreadCount.val > 99 ? "99+" : unreadCount.val.toString()
          )
        : null
    ])
  ]);
}

/**
 * Get the current unread count
 * This can be used by parent components to check notification status
 */
NotificationBell.getUnreadCount = async () => {
  try {
    const result = await api.notifications.getUnreadCount();
    return result.count;
  } catch (error) {
    console.error('Error getting unread count:', error);
    return 0;
  }
};

/**
 * Refresh the unread count
 * This can be called when notifications are read/received
 */
NotificationBell.refresh = async (bellInstance) => {
  if (bellInstance && bellInstance.loadUnreadCount) {
    await bellInstance.loadUnreadCount();
  }
};