import van from 'vanjs-core';
const { div, button, span, a, p } = van.tags;
import api from '../../services/api';

/**
 * Individual notification item component
 * @param {Object} props - Component props
 * @param {Object} props.notification - Notification object from API
 * @param {Function} props.onMarkAsRead - Callback when notification is marked as read
 * @param {Function} props.onDelete - Callback when notification is deleted
 * @returns {HTMLElement} Notification item element
 */
export default function NotificationItem({ notification, onMarkAsRead, onDelete }) {
  const processing = van.state(false);

  // Format time ago
  const getTimeAgo = (createdAt) => {
    const now = new Date();
    const created = new Date(createdAt);
    const diffMs = now - created;
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMins / 60);
    const diffDays = Math.floor(diffHours / 24);

    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;
    return created.toLocaleDateString();
  };

  // Get notification icon based on type
  const getNotificationIcon = (type) => {
    switch (type) {
      case 'like': return '❤️';
      case 'comment': return '💬';
      case 'reply': return '↩️';
      case 'follow': return '👤';
      case 'mention': return '@';
      default: return '🔔';
    }
  };

  // Handle marking as read
  const handleMarkAsRead = async () => {
    if (notification.read || processing.val) return;

    try {
      processing.val = true;
      await api.notifications.markAsRead(notification.id);
      onMarkAsRead?.(notification.id);
    } catch (error) {
      console.error('Error marking notification as read:', error);
    } finally {
      processing.val = false;
    }
  };

  // Handle delete
  const handleDelete = async () => {
    if (processing.val) return;

    try {
      processing.val = true;
      await api.notifications.delete(notification.id);
      onDelete?.(notification.id);
    } catch (error) {
      console.error('Error deleting notification:', error);
      processing.val = false; // Keep processing state on error
    }
  };

  // Handle click - navigate to relevant content and mark as read
  const handleClick = async () => {
    // Mark as read if not already read
    if (!notification.read) {
      await handleMarkAsRead();
    }

    // Navigate to relevant content
    if (notification.target_type === 'post' && notification.target_id) {
      window.location.hash = `#post/${notification.target_id}`;
    } else if (notification.target_type === 'comment' && notification.target_id) {
      // For comments, we might want to navigate to the parent post with the comment highlighted
      window.location.hash = `#post/${notification.target_id}`;
    } else if (notification.target_type === 'user' && notification.actor_id) {
      window.location.hash = `#user/${notification.actor_id}`;
    }
  };

  return div({
    class: () => `notification-item ${notification.read ? 'read' : 'unread'} ${processing.val ? 'processing' : ''}`,
    onclick: handleClick
  }, [
    // Notification icon and content
    div({ class: "notification-content" }, [
      span({ class: "notification-icon" }, getNotificationIcon(notification.type)),
      
      div({ class: "notification-text" }, [
        div({ class: "notification-message" }, [
          span({ class: "actor-name" }, notification.actor_username),
          span({ class: "action-text" }, ` ${getActionText(notification.type)}`)
        ]),
        
        // Show target content preview if available
        () => notification.target_content 
          ? p({ class: "target-content" }, 
              notification.target_content.length > 50 
                ? notification.target_content.substring(0, 50) + '...'
                : notification.target_content
            )
          : null,
          
        span({ class: "notification-time" }, getTimeAgo(notification.created_at))
      ])
    ]),

    // Action buttons
    div({ class: "notification-actions" }, [
      // Mark as read button (only show if unread)
      () => !notification.read 
        ? button({
            class: "mark-read-btn",
            onclick: (e) => {
              e.stopPropagation();
              handleMarkAsRead();
            },
            disabled: () => processing.val,
            title: "Mark as read"
          }, "✓")
        : null,

      // Delete button
      button({
        class: "delete-btn",
        onclick: (e) => {
          e.stopPropagation();
          handleDelete();
        },
        disabled: () => processing.val,
        title: "Delete notification"
      }, "×")
    ])
  ]);
}

// Helper function to get action text based on notification type
function getActionText(type) {
  switch (type) {
    case 'like': return 'liked your post';
    case 'comment': return 'commented on your post';
    case 'reply': return 'replied to your comment';
    case 'follow': return 'started following you';
    case 'mention': return 'mentioned you';
    default: return 'interacted with your content';
  }
}