import { For, Show, createSignal, onMount } from 'solid-js';
import {
  getPreferences,
  getSubscriptionState,
  isPushSupported,
  subscribeToPush,
  unsubscribeFromPush,
  updatePreferences
} from '../../../../services/pushService';

export default function NotificationsSection() {
  const supported = isPushSupported();
  const [subscribed, setSubscribed] = createSignal(false);
  const [permission, setPermission] = createSignal('default');
  const [prefs, setPrefs] = createSignal({ push_replies: true, push_follows: true, push_messages: true });
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal('');

  const loadPrefs = async () => {
    const p = await getPreferences();
    setPrefs({
      push_replies: p?.push_replies !== false,
      push_follows: p?.push_follows !== false,
      push_messages: p?.push_messages !== false
    });
  };

  onMount(async () => {
    if (!supported) return;
    try {
      const state = await getSubscriptionState();
      setSubscribed(Boolean(state?.subscribed));
      setPermission(state?.permission || 'default');
      if (state?.subscribed) await loadPrefs();
    } catch { /* leave defaults */ }
  });

  const enable = async () => {
    setBusy(true);
    setError('');
    try {
      await subscribeToPush();
      setSubscribed(true);
      setPermission('granted');
      await loadPrefs();
    } catch (e) {
      setError(e?.message || 'FAILED TO ENABLE PUSH');
    } finally {
      setBusy(false);
    }
  };

  const disable = async () => {
    setBusy(true);
    setError('');
    try {
      await unsubscribeFromPush();
      setSubscribed(false);
    } catch (e) {
      setError(e?.message || 'FAILED TO DISABLE PUSH');
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (key) => {
    const next = { ...prefs(), [key]: !prefs()[key] };
    setPrefs(next);
    setBusy(true);
    setError('');
    try {
      await updatePreferences(next);
    } catch (e) {
      setError(e?.message || 'FAILED TO SAVE PREFERENCE');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="text-xs">
      <Show when={!supported}>
        <div class="text-bb-muted">PUSH NOT SUPPORTED IN THIS BROWSER</div>
      </Show>
      <Show when={supported && permission() === 'denied'}>
        <div class="text-bb-muted">PUSH BLOCKED // NOTIFICATIONS ARE DENIED IN YOUR BROWSER SETTINGS</div>
      </Show>
      <Show when={supported && permission() !== 'denied'}>
        <div class="flex items-center gap-3">
          <span class="text-bb-muted">
            STATUS: {subscribed() ? 'SUBSCRIBED' : 'NOT SUBSCRIBED'} // PERMISSION: {permission().toUpperCase()}
          </span>
          <button
            type="button"
            disabled={busy()}
            onClick={subscribed() ? disable : enable}
            class="px-2 py-1 border border-bb-border text-bb-text hover:border-bb-accent hover:text-bb-accent disabled:opacity-50 uppercase font-bold"
          >
            {subscribed() ? '[DISABLE PUSH]' : '[ENABLE PUSH]'}
          </button>
        </div>
        <Show when={subscribed()}>
          <div class="flex flex-col gap-1 mt-3">
            <For each={[['push_replies', 'REPLIES'], ['push_follows', 'FOLLOWS'], ['push_messages', 'MESSAGES']]}>
              {([key, label]) => (
                <label class="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" checked={prefs()[key]} disabled={busy()} onChange={() => toggle(key)} />
                  <span class="uppercase text-bb-muted">{label}</span>
                </label>
              )}
            </For>
          </div>
        </Show>
        <Show when={error()}>
          <div class="mt-2 text-market-down">ERROR // {error().toUpperCase()}</div>
        </Show>
      </Show>
    </div>
  );
}
