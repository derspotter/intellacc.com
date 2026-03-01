import { createSignal } from 'solid-js';
import { api } from '../../services/api';

const getNotificationIcon = (type) => {
  switch (type) {
    case 'like':
      return '❤️';
    case 'comment':
      return '💬';
    case 'reply':
      return '↩️';
    case 'follow':
      return '👤';
    case 'mention':
      return '@';
    default:
      return '🔔';
  }
};

const getActionText = (type) => {
  switch (type) {
    case 'like':
      return 'liked your post';
    case 'comment':
      return 'commented on your post';
    case 'reply':
      return 'replied to your comment';
    case 'follow':
      return 'started following you';
    case 'mention':
      return 'mentioned you';
    default:
      return 'interacted with your content';
  }
};

const getTimeAgo = (createdAt) => {
  if (!createdAt) {
    return '';
  }

  const now = new Date();
  const created = new Date(createdAt);
  const diffMs = now - created;
  if (Number.isNaN(diffMs)) {
    return '';
  }

  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffMins < 1) {
    return 'Just now';
  }
  if (diffMins < 60) {
    return `${diffMins}m ago`;
  }
  if (diffHours < 24) {
    return `${diffHours}h ago`;
  }
  if (diffDays < 7) {
    return `${diffDays}d ago`;
  }

  return created.toLocaleDateString();
};

export default function NotificationItem(props) {
  const [processing, setProcessing] = createSignal(false);

  const handleMarkAsRead = async () => {
    if (props.notification.read || processing()) {
      return;
    }

    try {
      setProcessing(true);
      await api.notifications.markAsRead(props.notification.id);
      props.onMarkAsRead?.(props.notification.id);
    } finally {
      setProcessing(false);
    }
  };

  const handleDelete = async () => {
    if (processing()) {
      return;
    }

    try {
      setProcessing(true);
      await api.notifications.delete(props.notification.id);
      props.onDelete?.(props.notification.id);
    } finally {
      setProcessing(false);
    }
  };

  const handleClick = async () => {
    if (!props.notification.read) {
      await handleMarkAsRead();
    }

    const targetType = props.notification.target_type;
    const targetId = props.notification.target_id;
    if (targetType === 'post' && targetId) {
      window.location.hash = `#post/${targetId}`;
      return;
    }
    if (targetType === 'comment' && targetId) {
      window.location.hash = `#post/${targetId}`;
      return;
    }
    if (targetType === 'user' && props.notification.actor_id) {
      window.location.hash = `#user/${props.notification.actor_id}`;
    }
  };

  return (
    <div
      classList={{
        'notification-item': true,
        unread: !props.notification.read,
        processing: processing()
      }}
      onclick={handleClick}
    >
      <div class="notification-content">
        <span class="notification-icon">{getNotificationIcon(props.notification.type)}</span>
        <div class="notification-text">
          <div class="notification-message">
            <span class="actor-name">{props.notification.actor_username || 'Someone'}</span>
            <span class="action-text"> {getActionText(props.notification.type)}</span>
          </div>
          {props.notification.target_content ? (
            <p class="target-content">
              {props.notification.target_content.length > 120
                ? `${props.notification.target_content.substring(0, 120)}...`
                : props.notification.target_content}
            </p>
          ) : null}
          <span class="notification-time">{getTimeAgo(props.notification.created_at)}</span>
        </div>
      </div>

      <div class="notification-actions">
        {!props.notification.read ? (
          <button
            type="button"
            class="mark-read-btn"
            disabled={processing()}
            title="Mark as read"
            onclick={(event) => {
              event.stopPropagation();
              void handleMarkAsRead();
            }}
          >
            ✓
          </button>
        ) : null}
        <button
          type="button"
          class="delete-btn"
          disabled={processing()}
          title="Delete notification"
          onclick={(event) => {
            event.stopPropagation();
            void handleDelete();
          }}
        >
          ×
        </button>
      </div>
    </div>
  );
}
