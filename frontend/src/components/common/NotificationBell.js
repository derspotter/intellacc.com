import van from 'vanjs-core';
const { div, button, span } = van.tags;
import api from '../../services/api';
import socketService from '../../services/socket';

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
  const intervalId = setInterval(loadUnreadCount, 30000);

  // Listen for socket notification events
  const handleNotification = (data) => {
    console.log('Notification received:', data);
    
    if (data.type === 'new') {
      // New notification received, increment count
      unreadCount.val = unreadCount.val + 1;
    } else if (data.type === 'unreadCountUpdate') {
      // Direct count update from server
      unreadCount.val = data.count;
    }
  };

  // Register socket handler
  const unregister = socketService.on('notification', handleNotification);

  // Store cleanup function on the component
  const bellElement = div({ class: "notification-bell-container" }, [
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

  // Store cleanup functions
  bellElement._cleanup = () => {
    clearInterval(intervalId);
    unregister?.();
  };

  // Store loadUnreadCount function for external access
  bellElement.loadUnreadCount = loadUnreadCount;

  return bellElement;
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