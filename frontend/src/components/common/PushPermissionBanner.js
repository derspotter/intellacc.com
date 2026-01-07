// frontend/src/components/common/PushPermissionBanner.js
import van from 'vanjs-core';
import {
  isPushSupported,
  shouldShowPrompt,
  subscribeToPush,
  setDismissed
} from '../../services/pushService.js';

const { div, p, button, span } = van.tags;

/**
 * Banner component that prompts users to enable push notifications
 * Shows after login if push is supported but not enabled
 */
export default function PushPermissionBanner() {
  const visible = van.state(shouldShowPrompt());
  const loading = van.state(false);
  const error = van.state(null);

  const handleEnable = async () => {
    loading.val = true;
    error.val = null;

    try {
      await subscribeToPush();
      visible.val = false;
    } catch (err) {
      console.error('[Push] Enable error:', err);
      if (err.message.includes('denied')) {
        error.val = 'Permission denied. You can enable notifications in your browser settings.';
      } else {
        error.val = 'Failed to enable notifications. Please try again.';
      }
    } finally {
      loading.val = false;
    }
  };

  const handleDismiss = () => {
    setDismissed(true);
    visible.val = false;
  };

  // Don't render if not visible
  return () => {
    if (!visible.val) return div();

    return div({ class: 'push-permission-banner' },
      div({ class: 'push-permission-content' },
        span({ class: 'push-permission-icon' }, '🔔'),
        div({ class: 'push-permission-text' },
          p({ class: 'push-permission-title' }, 'Enable notifications'),
          p({ class: 'push-permission-description' },
            'Get notified when someone replies to you, follows you, or sends you a message.'
          ),
          error.val ? p({ class: 'push-permission-error' }, error.val) : null
        ),
        div({ class: 'push-permission-actions' },
          button({
            class: 'push-permission-enable',
            onclick: handleEnable,
            disabled: loading.val
          }, loading.val ? 'Enabling...' : 'Enable'),
          button({
            class: 'push-permission-dismiss',
            onclick: handleDismiss,
            disabled: loading.val
          }, 'Not now')
        )
      )
    );
  };
}
