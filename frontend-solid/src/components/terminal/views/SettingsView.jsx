import { For, Show, createSignal, onMount } from 'solid-js';
import { getActiveSkin, setSkin, VALID_SKINS } from '../../../services/skinProvider';
import { api, getFeedWeights, saveFeedWeights, updateUiPreferences } from '../../../services/api';
import { KEYS, redistribute } from '../../../lib/feedRanking';
import { isAuthenticated } from '../../../services/auth';
import {
  getPreferences,
  getSubscriptionState,
  isPushSupported,
  subscribeToPush,
  unsubscribeFromPush,
  updatePreferences
} from '../../../services/pushService';

// `LABEL` is not exported from lib/feedRanking — define the display strings locally.
const LABELS = { accuracy: 'ACCURACY', followers: 'FOLLOWERS', likes: 'LIKES', views: 'VIEWS' };
const DEFAULT_WEIGHTS = { accuracy: 25, followers: 25, likes: 25, views: 25 };

function Section(props) {
  return (
    <div class="border-b border-bb-border/60">
      <div class="px-3 py-1.5 bg-bb-panel text-bb-accent font-bold uppercase text-xs border-b border-bb-border/40">
        [{props.title}]
      </div>
      <div class="p-3">
        {props.children}
      </div>
    </div>
  );
}

function SkinSection() {
  const active = getActiveSkin;

  const choose = (skin) => {
    setSkin(skin);
    if (isAuthenticated()) {
      updateUiPreferences(skin).catch(() => { /* local switch already applied */ });
    }
  };

  return (
    <div class="flex gap-2 text-xs">
      <For each={VALID_SKINS}>
        {(skin) => (
          <button
            type="button"
            data-testid={`settings-skin-${skin}`}
            onClick={() => choose(skin)}
            class={`px-3 py-1 border uppercase font-bold ${
              active() === skin
                ? 'bg-bb-accent/15 text-bb-accent border-bb-accent'
                : 'border-bb-border text-bb-muted hover:text-bb-text hover:border-bb-text'
            }`}
          >
            [{skin.toUpperCase()}]
          </button>
        )}
      </For>
    </div>
  );
}

function FeedMixSection() {
  const [weights, setWeights] = createSignal({ ...DEFAULT_WEIGHTS });
  const [locks, setLocks] = createSignal({});
  const [saving, setSaving] = createSignal(false);
  const [saved, setSaved] = createSignal(false);
  const [error, setError] = createSignal('');

  onMount(() => {
    getFeedWeights()
      .then((res) => {
        const w = res?.weights;
        if (w && KEYS.every((k) => typeof w[k] === 'number')) setWeights({ ...w });
      })
      .catch(() => { /* keep defaults */ });
  });

  const onSlide = (key, value) => {
    setSaved(false);
    setWeights((w) => redistribute(w, locks(), key, Number(value)));
  };

  const toggleLock = (key) => setLocks((l) => ({ ...l, [key]: !l[key] }));

  const save = async () => {
    setSaving(true);
    setError('');
    setSaved(false);
    try {
      await saveFeedWeights(weights());
      setSaved(true);
    } catch (e) {
      setError(e?.message || 'FAILED TO SAVE FEED MIX');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div class="text-xs">
      <For each={KEYS}>
        {(key) => (
          <div class="flex items-center gap-3 py-1.5">
            <div class="w-24 shrink-0 uppercase text-bb-muted">{LABELS[key]}</div>
            <input
              type="range"
              min="0"
              max="100"
              value={weights()[key]}
              disabled={locks()[key]}
              onInput={(e) => onSlide(key, e.currentTarget.value)}
              class="flex-1 accent-bb-accent disabled:opacity-40"
            />
            <div class="w-10 text-right font-bold text-bb-text">{weights()[key]}</div>
            <button
              type="button"
              onClick={() => toggleLock(key)}
              class={`px-2 py-0.5 border uppercase font-bold ${
                locks()[key] ? 'border-bb-accent text-bb-accent' : 'border-bb-border text-bb-muted hover:text-bb-text'
              }`}
            >
              [LOCK]
            </button>
          </div>
        )}
      </For>
      <div class="flex items-center gap-3 mt-2">
        <button
          type="button"
          data-testid="settings-feedmix-save"
          disabled={saving()}
          onClick={save}
          class="px-3 py-1 border border-bb-accent text-bb-accent hover:bg-bb-accent/20 disabled:opacity-50 uppercase font-bold"
        >
          {saving() ? '[SAVING...]' : '[SAVE]'}
        </button>
        <Show when={saved()}>
          <span class="text-market-up">SAVED // FEED MIX</span>
        </Show>
        <Show when={error()}>
          <span class="text-market-down">ERROR // {error().toUpperCase()}</span>
        </Show>
      </div>
    </div>
  );
}

function NotificationsSection() {
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
      <Show when={supported}>
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

function VerificationSection() {
  const [status, setStatus] = createSignal(null);
  const [sent, setSent] = createSignal(false);
  const [error, setError] = createSignal('');

  onMount(() => {
    api.verification.getStatus()
      .then((s) => setStatus(s || {}))
      .catch((e) => setError(e?.message || 'FAILED TO LOAD VERIFICATION STATUS'));
  });

  const sendVerification = async () => {
    setError('');
    try {
      await api.verification.sendEmailVerification();
      setSent(true);
    } catch (e) {
      setError(e?.message || 'FAILED TO SEND VERIFICATION EMAIL');
    }
  };

  return (
    <div class="text-xs">
      <Show when={status()} fallback={<div class="text-bb-muted animate-pulse">RUNNING QUERY...</div>}>
        <div class="text-bb-text">TIER: {status().current_tier ?? 0}</div>
        <Show when={(status().current_tier ?? 0) === 0}>
          <button
            type="button"
            onClick={sendVerification}
            class="mt-2 text-bb-accent hover:underline uppercase font-bold"
          >
            [VERIFY EMAIL]
          </button>
          <Show when={sent()}>
            <span class="ml-2 text-market-up">VERIFICATION EMAIL SENT</span>
          </Show>
        </Show>
      </Show>
      <Show when={error()}>
        <div class="mt-2 text-market-down">ERROR // {error().toUpperCase()}</div>
      </Show>
    </div>
  );
}

function PasswordSection() {
  const [oldPw, setOldPw] = createSignal('');
  const [newPw, setNewPw] = createSignal('');
  const [busy, setBusy] = createSignal(false);
  const [message, setMessage] = createSignal('');
  const [error, setError] = createSignal('');

  const submit = async () => {
    setBusy(true);
    setMessage('');
    setError('');
    try {
      await api.users.changePassword(oldPw(), newPw());
      setOldPw('');
      setNewPw('');
      setMessage('PASSWORD CHANGED');
    } catch (e) {
      setError(e?.message || 'FAILED TO CHANGE PASSWORD');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="text-xs flex flex-col gap-2 max-w-sm">
      <input
        type="password"
        placeholder="CURRENT PASSWORD"
        value={oldPw()}
        onInput={(e) => setOldPw(e.currentTarget.value)}
        class="bg-bb-bg border border-bb-border px-2 py-1 text-bb-text focus:outline-none focus:border-bb-accent"
      />
      <input
        type="password"
        placeholder="NEW PASSWORD"
        value={newPw()}
        onInput={(e) => setNewPw(e.currentTarget.value)}
        class="bg-bb-bg border border-bb-border px-2 py-1 text-bb-text focus:outline-none focus:border-bb-accent"
      />
      <div class="flex items-center gap-3">
        <button
          type="button"
          disabled={busy() || !oldPw() || !newPw()}
          onClick={submit}
          class="px-3 py-1 border border-bb-border text-bb-text hover:border-bb-accent hover:text-bb-accent disabled:opacity-50 uppercase font-bold"
        >
          [CHANGE PASSWORD]
        </button>
        <Show when={message()}>
          <span class="text-market-up">{message()}</span>
        </Show>
        <Show when={error()}>
          <span class="text-market-down">ERROR // {error().toUpperCase()}</span>
        </Show>
      </div>
    </div>
  );
}

function DangerZoneSection() {
  const [confirmText, setConfirmText] = createSignal('');
  const [password, setPassword] = createSignal('');
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal('');

  const canDelete = () => confirmText() === 'DELETE' && password().length > 0 && !busy();

  const submit = async () => {
    if (!canDelete()) return;
    setBusy(true);
    setError('');
    try {
      await api.users.deleteAccount(password());
      const tokenService = await import('../../../services/tokenService');
      tokenService.clearToken();
      window.location.hash = '#home';
    } catch (e) {
      setError(e?.message || 'FAILED TO DELETE ACCOUNT');
      setBusy(false);
    }
  };

  return (
    <div class="border border-market-down/60 bg-market-down/5 p-3 text-xs flex flex-col gap-2 max-w-sm">
      <div class="text-market-down">
        THIS PERMANENTLY DELETES YOUR ACCOUNT. TYPE "DELETE" TO CONFIRM.
      </div>
      <input
        type="text"
        placeholder="TYPE DELETE TO CONFIRM"
        value={confirmText()}
        onInput={(e) => setConfirmText(e.currentTarget.value)}
        class="bg-bb-bg border border-market-down/60 px-2 py-1 text-bb-text focus:outline-none focus:border-market-down"
      />
      <input
        type="password"
        placeholder="PASSWORD"
        value={password()}
        onInput={(e) => setPassword(e.currentTarget.value)}
        class="bg-bb-bg border border-market-down/60 px-2 py-1 text-bb-text focus:outline-none focus:border-market-down"
      />
      <div class="flex items-center gap-3">
        <button
          type="button"
          disabled={!canDelete()}
          onClick={submit}
          class="px-3 py-1 border border-market-down text-market-down hover:bg-market-down/20 disabled:opacity-40 uppercase font-bold"
        >
          [DELETE ACCOUNT]
        </button>
        <Show when={error()}>
          <span class="text-market-down">ERROR // {error().toUpperCase()}</span>
        </Show>
      </div>
    </div>
  );
}

export default function SettingsView() {
  return (
    <div class="font-mono text-sm">
      <Section title="SKIN"><SkinSection /></Section>
      <Section title="FEED MIX"><FeedMixSection /></Section>
      <Section title="NOTIFICATIONS"><NotificationsSection /></Section>
      <Section title="VERIFICATION"><VerificationSection /></Section>
      <Section title="PASSWORD"><PasswordSection /></Section>
      <Section title="DANGER ZONE"><DangerZoneSection /></Section>
      <div class="px-3 py-2 text-bb-muted text-xxs uppercase">
        [PASSKEYS / DEVICES / VAULT / API KEYS] // AVAILABLE IN VAN SETTINGS UNTIL PHASE 4
      </div>
    </div>
  );
}
