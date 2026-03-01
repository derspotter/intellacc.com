import {
  createSignal,
  Show,
  onMount
} from 'solid-js';
import {
  getPreferences,
  getSubscriptionState,
  isPushSupported,
  setDismissed,
  subscribeToPush,
  unsubscribeFromPush,
  updatePreferences
} from '../../services/pushService';

export default function NotificationSettings() {
  const [loading, setLoading] = createSignal(true);
  const [saving, setSaving] = createSignal(false);
  const [error, setError] = createSignal('');
  const [success, setSuccess] = createSignal('');

  const [supported, setSupported] = createSignal(isPushSupported());
  const [subscribed, setSubscribed] = createSignal(false);
  const [permission, setPermission] = createSignal('default');

  const [pushReplies, setPushReplies] = createSignal(true);
  const [pushFollows, setPushFollows] = createSignal(true);
  const [pushMessages, setPushMessages] = createSignal(true);

  const loadState = async () => {
    setLoading(true);
    setError('');
    try {
      const state = await getSubscriptionState();
      setSupported(state.supported);
      setSubscribed(state.subscribed);
      setPermission(state.permission);

      if (state.subscribed) {
        const prefs = await getPreferences();
        setPushReplies(prefs.push_replies !== false);
        setPushFollows(prefs.push_follows !== false);
        setPushMessages(prefs.push_messages !== false);
      }
    } catch (err) {
      setError('Failed to load notification settings');
    } finally {
      setLoading(false);
    }
  };

  const savePref = async (key, nextValue) => {
    setSaving(true);
    setError('');
    setSuccess('');

    const prefs = {
      push_replies: pushReplies(),
      push_follows: pushFollows(),
      push_messages: pushMessages(),
      [key]: nextValue
    };

    try {
      await updatePreferences(prefs);
      if (key === 'push_replies') {
        setPushReplies(nextValue);
      }
      if (key === 'push_follows') {
        setPushFollows(nextValue);
      }
      if (key === 'push_messages') {
        setPushMessages(nextValue);
      }
      setSuccess('Preferences saved');
      setTimeout(() => setSuccess(''), 1200);
    } catch (err) {
      setError(err?.message || 'Failed to save preferences.');
    } finally {
      setSaving(false);
    }
  };

  const enable = async () => {
    setSaving(true);
    setError('');
    setSuccess('');

    try {
      await subscribeToPush();
      setSubscribed(true);
      setPermission('granted');
      setDismissed(false);
      setSuccess('Push notifications enabled');

      const prefs = await getPreferences();
      setPushReplies(prefs.push_replies !== false);
      setPushFollows(prefs.push_follows !== false);
      setPushMessages(prefs.push_messages !== false);
    } catch (err) {
      if (err?.message?.includes('denied')) {
        setError('Permission denied. Enable notifications in your browser settings.');
        setPermission('denied');
      } else {
        setError(err?.message || 'Failed to enable notifications');
      }
    } finally {
      setSaving(false);
    }
  };

  const disable = async () => {
    setSaving(true);
    setError('');
    setSuccess('');

    try {
      await unsubscribeFromPush();
      setSubscribed(false);
      setSuccess('Push notifications disabled');
    } catch (err) {
      setError(err?.message || 'Failed to disable notifications');
    } finally {
      setSaving(false);
    }
  };

  onMount(loadState);

  return (
    <section class="notification-settings">
      <h2>Push Notifications</h2>

      <Show when={loading()}>
        <p>Loading…</p>
      </Show>

      <Show when={!loading() && !supported()}>
        <p class="notification-settings-unsupported">
          Push notifications are not supported in this browser.
        </p>
      </Show>

      <Show when={!loading() && supported() && permission() === 'denied'}>
        <p class="notification-settings-denied">
          Notifications are blocked. Update your browser permissions to enable them.
        </p>
      </Show>

      <Show when={!loading() && supported() && permission() !== 'denied'}>
        <div class="notification-settings-toggle">
          {subscribed() ? (
            <button
              type="button"
              class="btn btn-secondary"
              onClick={disable}
              disabled={saving()}
            >
              {saving() ? 'Disabling…' : 'Disable Push Notifications'}
            </button>
          ) : (
            <button
              type="button"
              class="btn btn-primary"
              onClick={enable}
              disabled={saving()}
            >
              {saving() ? 'Enabling…' : 'Enable Push Notifications'}
            </button>
          )}
        </div>
      </Show>

      <Show when={!loading() && subscribed()}>
        <div class="notification-settings-preferences">
          <h2>Notification Types</h2>
          <p class="notification-settings-hint">Choose what you want to receive.</p>

          <div class="preference-item">
            <label>
              <input
                type="checkbox"
                checked={pushReplies()}
                disabled={saving()}
                onChange={(event) => savePref('push_replies', event.target.checked)}
              />
              Replies to your posts and comments
            </label>
          </div>

          <div class="preference-item">
            <label>
              <input
                type="checkbox"
                checked={pushFollows()}
                disabled={saving()}
                onChange={(event) => savePref('push_follows', event.target.checked)}
              />
              New followers
            </label>
          </div>

          <div class="preference-item">
            <label>
              <input
                type="checkbox"
                checked={pushMessages()}
                disabled={saving()}
                onChange={(event) => savePref('push_messages', event.target.checked)}
              />
              New messages
            </label>
          </div>
        </div>
      </Show>

      <Show when={error()}>
        <p class="notification-settings-error">{error()}</p>
      </Show>
      <Show when={success()}>
        <p class="notification-settings-success">{success()}</p>
      </Show>
    </section>
  );
}
