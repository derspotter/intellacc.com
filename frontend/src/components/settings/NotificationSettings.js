// frontend/src/components/settings/NotificationSettings.js
import van from 'vanjs-core';
import {
  isPushSupported,
  getSubscriptionState,
  subscribeToPush,
  unsubscribeFromPush,
  getPreferences,
  updatePreferences,
  setDismissed
} from '../../services/pushService.js';

const { div, h2, p, button, label, input, span } = van.tags;

/**
 * Notification settings component for the settings page
 * Allows users to manage push notification subscription and preferences
 */
export default function NotificationSettings() {
  // State
  const loading = van.state(true);
  const saving = van.state(false);
  const error = van.state(null);
  const success = van.state(null);

  const supported = van.state(isPushSupported());
  const subscribed = van.state(false);
  const permission = van.state('default');

  const pushReplies = van.state(true);
  const pushFollows = van.state(true);
  const pushMessages = van.state(true);

  // Load current state
  const loadState = async () => {
    loading.val = true;
    error.val = null;

    try {
      // Get subscription state
      const state = await getSubscriptionState();
      supported.val = state.supported;
      subscribed.val = state.subscribed;
      permission.val = state.permission;

      // Get preferences if subscribed
      if (state.subscribed) {
        const prefs = await getPreferences();
        pushReplies.val = prefs.push_replies !== false;
        pushFollows.val = prefs.push_follows !== false;
        pushMessages.val = prefs.push_messages !== false;
      }
    } catch (err) {
      console.error('[NotificationSettings] Load error:', err);
      error.val = 'Failed to load notification settings';
    } finally {
      loading.val = false;
    }
  };

  // Enable push notifications
  const handleEnable = async () => {
    saving.val = true;
    error.val = null;
    success.val = null;

    try {
      await subscribeToPush();
      subscribed.val = true;
      permission.val = 'granted';
      setDismissed(false);
      success.val = 'Push notifications enabled';

      // Load preferences
      const prefs = await getPreferences();
      pushReplies.val = prefs.push_replies !== false;
      pushFollows.val = prefs.push_follows !== false;
      pushMessages.val = prefs.push_messages !== false;
    } catch (err) {
      console.error('[NotificationSettings] Enable error:', err);
      if (err.message.includes('denied')) {
        error.val = 'Permission denied. Enable notifications in your browser settings.';
        permission.val = 'denied';
      } else {
        error.val = err.message || 'Failed to enable notifications';
      }
    } finally {
      saving.val = false;
    }
  };

  // Disable push notifications
  const handleDisable = async () => {
    saving.val = true;
    error.val = null;
    success.val = null;

    try {
      await unsubscribeFromPush();
      subscribed.val = false;
      success.val = 'Push notifications disabled';
    } catch (err) {
      console.error('[NotificationSettings] Disable error:', err);
      error.val = err.message || 'Failed to disable notifications';
    } finally {
      saving.val = false;
    }
  };

  // Update preferences
  const handlePreferenceChange = async (key, value) => {
    saving.val = true;
    error.val = null;
    success.val = null;

    const prefs = {
      push_replies: pushReplies.val,
      push_follows: pushFollows.val,
      push_messages: pushMessages.val,
      [key]: value
    };

    try {
      await updatePreferences(prefs);

      // Update local state
      if (key === 'push_replies') pushReplies.val = value;
      if (key === 'push_follows') pushFollows.val = value;
      if (key === 'push_messages') pushMessages.val = value;

      success.val = 'Preferences saved';
    } catch (err) {
      console.error('[NotificationSettings] Save error:', err);
      error.val = 'Failed to save preferences';
    } finally {
      saving.val = false;
    }
  };

  // Load state on mount
  loadState();

  // Clear messages after 3 seconds
  van.derive(() => {
    if (success.val) {
      setTimeout(() => { success.val = null; }, 3000);
    }
  });

  return div({ class: 'notification-settings' },
    h2('Push Notifications'),

    // Loading state
    () => loading.val ? p({ class: 'loading' }, 'Loading...') : null,

    // Not supported message
    () => !loading.val && !supported.val ?
      p({ class: 'notification-settings-unsupported' },
        'Push notifications are not supported in this browser.'
      ) : null,

    // Permission denied message
    () => !loading.val && supported.val && permission.val === 'denied' ?
      p({ class: 'notification-settings-denied' },
        'Notifications are blocked. To enable them, update your browser settings for this site.'
      ) : null,

    // Enable/Disable toggle
    () => !loading.val && supported.val && permission.val !== 'denied' ?
      div({ class: 'notification-settings-toggle' },
        subscribed.val ?
          button({
            class: 'btn btn-secondary',
            onclick: handleDisable,
            disabled: saving.val
          }, saving.val ? 'Disabling...' : 'Disable Push Notifications')
          :
          button({
            class: 'btn btn-primary',
            onclick: handleEnable,
            disabled: saving.val
          }, saving.val ? 'Enabling...' : 'Enable Push Notifications')
      ) : null,

    // Preferences (only shown when subscribed)
    () => !loading.val && subscribed.val ?
      div({ class: 'notification-settings-preferences' },
        h2('Notification Types'),
        p({ class: 'notification-settings-hint' },
          'Choose which notifications you want to receive:'
        ),

        div({ class: 'preference-item' },
          label(
            input({
              type: 'checkbox',
              checked: pushReplies,
              disabled: saving,
              onchange: (e) => handlePreferenceChange('push_replies', e.target.checked)
            }),
            ' Replies to your posts and comments'
          )
        ),

        div({ class: 'preference-item' },
          label(
            input({
              type: 'checkbox',
              checked: pushFollows,
              disabled: saving,
              onchange: (e) => handlePreferenceChange('push_follows', e.target.checked)
            }),
            ' New followers'
          )
        ),

        div({ class: 'preference-item' },
          label(
            input({
              type: 'checkbox',
              checked: pushMessages,
              disabled: saving,
              onchange: (e) => handlePreferenceChange('push_messages', e.target.checked)
            }),
            ' New messages'
          )
        )
      ) : null,

    // Error message
    () => error.val ?
      p({ class: 'notification-settings-error' }, error.val) : null,

    // Success message
    () => success.val ?
      p({ class: 'notification-settings-success' }, success.val) : null
  );
}
