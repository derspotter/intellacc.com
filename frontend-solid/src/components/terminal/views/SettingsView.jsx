import { For, Show, createSignal, onMount, onCleanup } from 'solid-js';
import { getActiveSkin, setSkin, VALID_SKINS } from '../../../services/skinProvider';
import { api, ApiError, getFeedWeights, saveFeedWeights, updateUiPreferences } from '../../../services/api';
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
import webauthnService from '../../../services/webauthn';
import vaultService from '../../../services/mls/vaultService';
import vaultStore from '../../../store/vaultStore';
import { configureIdleAutoLock, loadIdleLockConfig } from '../../../services/idleLock';
import { clearToken } from '../../../services/tokenService';

// `LABEL` is not exported from lib/feedRanking — define the display strings locally.
const LABELS = { accuracy: 'ACCURACY', followers: 'FOLLOWERS', likes: 'LIKES', views: 'VIEWS' };
const DEFAULT_WEIGHTS = { accuracy: 25, followers: 25, likes: 25, views: 25 };

// Engineering-panel module: hairline box, header strip with a sheet code.
// Sections pack into a masonry column grid so no screen width is wasted.
function Section(props) {
  const danger = props.tone === 'danger';
  return (
    <div
      class={`break-inside-avoid mb-px border bg-bb-bg ${
        danger ? 'border-market-down/60' : 'border-bb-border'
      }`}
    >
      <div
        class={`px-2 py-1 flex items-baseline justify-between bg-bb-panel font-bold uppercase text-xs border-b ${
          danger ? 'border-market-down/60 text-market-down' : 'border-bb-border text-bb-accent'
        }`}
      >
        <span>[{props.title}]</span>
        <span class="text-bb-muted font-normal text-[10px] tracking-widest">{props.code}</span>
      </div>
      <div class="p-2">
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

function TopicsSection() {
  const [topics, setTopics] = createSignal([]);
  const [selected, setSelected] = createSignal(new Set());
  const [loading, setLoading] = createSignal(true);
  const [saving, setSaving] = createSignal(false);
  const [saved, setSaved] = createSignal(false);
  const [error, setError] = createSignal('');

  onMount(async () => {
    try {
      const [listRes, mineRes] = await Promise.all([
        api.topics.list(),
        api.topics.getMine()
      ]);
      setTopics(listRes?.topics || []);
      setSelected(new Set(mineRes?.topicIds || []));
    } catch (e) {
      setError(e?.message || 'FAILED TO LOAD TOPICS');
    } finally {
      setLoading(false);
    }
  });

  const toggle = (id) => {
    setSaved(false);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const save = async () => {
    setSaving(true);
    setError('');
    setSaved(false);
    try {
      await api.topics.setMine([...selected()]);
      setSaved(true);
    } catch (e) {
      setError(e?.message || 'FAILED TO SAVE TOPICS');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div class="text-xs">
      <Show when={loading()}>
        <div class="text-bb-muted animate-pulse">RUNNING QUERY...</div>
      </Show>
      <Show when={!loading()}>
        <Show when={topics().length > 0} fallback={<div class="text-bb-muted">NO TOPICS AVAILABLE</div>}>
          <div class="flex flex-wrap gap-2 mb-3">
            <For each={topics()}>
              {(topic) => (
                <button
                  type="button"
                  data-testid="topic-chip"
                  onClick={() => toggle(topic.id)}
                  class={`px-2 py-1 border uppercase font-bold ${
                    selected().has(topic.id)
                      ? 'bg-bb-accent/15 text-bb-accent border-bb-accent'
                      : 'border-bb-border text-bb-muted hover:text-bb-text hover:border-bb-text'
                  }`}
                >
                  [{topic.name}]
                </button>
              )}
            </For>
          </div>
          <div class="flex items-center gap-3">
            <button
              type="button"
              data-testid="topics-save"
              disabled={saving()}
              onClick={save}
              class="px-3 py-1 border border-bb-accent text-bb-accent hover:bg-bb-accent/20 disabled:opacity-50 uppercase font-bold"
            >
              {saving() ? '[SAVING...]' : '[SAVE TOPICS]'}
            </button>
            <Show when={saved()}>
              <span class="text-market-up">SAVED // TOPICS</span>
            </Show>
            <Show when={error()}>
              <span class="text-market-down">ERROR // {error().toUpperCase()}</span>
            </Show>
          </div>
        </Show>
      </Show>
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
  const [confirmPw, setConfirmPw] = createSignal('');
  const [busy, setBusy] = createSignal(false);
  const [message, setMessage] = createSignal('');
  const [error, setError] = createSignal('');

  // Two-step vault re-wrap only applies once the vault exists AND is unlocked
  // (vaultService.changePassphrase requires the in-memory local key).
  const vaultActive = () => vaultStore.vaultExists && !vaultStore.isLocked;

  const submit = async () => {
    setBusy(true);
    setMessage('');
    setError('');
    try {
      if (vaultActive()) {
        if (newPw() !== confirmPw()) {
          throw new Error('NEW PASSWORDS DO NOT MATCH');
        }
        if (newPw().length < 6) {
          throw new Error('PASSWORD MUST BE AT LEAST 6 CHARACTERS');
        }
        // Sequential: abort the account-password update if the vault re-wrap fails.
        await vaultService.changePassphrase(oldPw(), newPw());
        await api.users.changePassword(oldPw(), newPw());
      } else {
        await api.users.changePassword(oldPw(), newPw());
      }
      setOldPw('');
      setNewPw('');
      setConfirmPw('');
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
        data-testid="password-current"
        placeholder="CURRENT PASSWORD"
        value={oldPw()}
        onInput={(e) => setOldPw(e.currentTarget.value)}
        class="bg-bb-bg border border-bb-border px-2 py-1 text-bb-text focus:outline-none focus:border-bb-accent"
      />
      <input
        type="password"
        data-testid="password-new"
        placeholder="NEW PASSWORD"
        value={newPw()}
        onInput={(e) => setNewPw(e.currentTarget.value)}
        class="bg-bb-bg border border-bb-border px-2 py-1 text-bb-text focus:outline-none focus:border-bb-accent"
      />
      <Show when={vaultActive()}>
        <input
          type="password"
          data-testid="password-confirm"
          placeholder="CONFIRM NEW PASSWORD"
          value={confirmPw()}
          onInput={(e) => setConfirmPw(e.currentTarget.value)}
          class="bg-bb-bg border border-bb-border px-2 py-1 text-bb-text focus:outline-none focus:border-bb-accent"
        />
      </Show>
      <div class="flex items-center gap-3">
        <button
          type="button"
          data-testid="password-submit"
          disabled={busy() || !oldPw() || !newPw() || (vaultActive() && !confirmPw())}
          onClick={submit}
          class="px-3 py-1 border border-bb-border text-bb-text hover:border-bb-accent hover:text-bb-accent disabled:opacity-50 uppercase font-bold"
        >
          {busy() ? '[CHANGING...]' : '[CHANGE PASSWORD]'}
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

function VaultSection() {
  const status = () => {
    if (!vaultStore.vaultExists) return 'NO VAULT';
    return vaultStore.isLocked ? 'LOCKED' : 'UNLOCKED';
  };
  const statusColor = () => {
    if (status() === 'UNLOCKED') return 'text-market-up';
    if (status() === 'LOCKED') return 'text-market-down';
    return 'text-bb-muted';
  };

  const [unlockPw, setUnlockPw] = createSignal('');
  const [unlockBusy, setUnlockBusy] = createSignal(false);
  const [unlockError, setUnlockError] = createSignal('');

  const [wipeText, setWipeText] = createSignal('');
  const [wipeBusy, setWipeBusy] = createSignal(false);
  const [wipeError, setWipeError] = createSignal('');
  const canWipe = () => wipeText() === 'WIPE' && !wipeBusy();

  onMount(() => {
    loadIdleLockConfig();
  });

  const handleUnlock = async (event) => {
    event.preventDefault();
    setUnlockBusy(true);
    setUnlockError('');
    try {
      await vaultService.unlockWithPassword(unlockPw());
      setUnlockPw('');
    } catch (err) {
      setUnlockError(err?.message || 'INCORRECT PASSWORD');
    } finally {
      setUnlockBusy(false);
    }
  };

  const handleAutoLockChange = (event) => {
    configureIdleAutoLock(parseInt(event.target.value, 10));
  };

  const handleLockNow = async () => {
    await vaultService.lockKeys();
    window.location.hash = '#home';
  };

  const handlePanicWipe = async () => {
    if (!canWipe()) return;
    setWipeBusy(true);
    setWipeError('');
    try {
      if (typeof vaultService.panicWipe === 'function') {
        await vaultService.panicWipe();
      } else {
        await vaultService.lockKeys();
      }
      clearToken();
      window.location.hash = '#home';
    } catch (err) {
      setWipeError(err?.message || 'FAILED TO WIPE VAULT');
      setWipeBusy(false);
    }
  };

  return (
    <div class="text-xs flex flex-col gap-4">
      <div class="flex items-center gap-2" data-testid="vault-status">
        <span class="uppercase text-bb-muted">STATUS:</span>
        <span class={`font-bold uppercase ${statusColor()}`}>{status()}</span>
      </div>

      <Show when={vaultStore.vaultExists && vaultStore.isLocked}>
        <form onSubmit={handleUnlock} class="flex flex-col gap-2 max-w-sm">
          <input
            type="password"
            placeholder="PASSWORD"
            value={unlockPw()}
            onInput={(e) => setUnlockPw(e.currentTarget.value)}
            disabled={unlockBusy()}
            class="bg-bb-bg border border-bb-border px-2 py-1 text-bb-text focus:outline-none focus:border-bb-accent"
          />
          <div class="flex items-center gap-3">
            <button
              type="submit"
              disabled={unlockBusy()}
              class="px-3 py-1 border border-bb-accent text-bb-accent hover:bg-bb-accent/20 disabled:opacity-50 uppercase font-bold"
            >
              {unlockBusy() ? '[UNLOCKING...]' : '[UNLOCK VAULT]'}
            </button>
            <Show when={unlockError()}>
              <span class="text-market-down">ERROR // {unlockError().toUpperCase()}</span>
            </Show>
          </div>
        </form>
      </Show>

      <Show when={vaultStore.vaultExists && !vaultStore.isLocked}>
        <div class="flex items-center gap-3 flex-wrap">
          <label class="uppercase text-bb-muted" for="vault-autolock">AUTO-LOCK:</label>
          <select
            id="vault-autolock"
            value={String(vaultStore.autoLockMinutes)}
            onChange={handleAutoLockChange}
            class="bg-bb-bg border border-bb-border px-2 py-1 text-bb-text"
          >
            <option value="0">NEVER</option>
            <option value="5">5 MINUTES</option>
            <option value="15">15 MINUTES</option>
            <option value="30">30 MINUTES</option>
            <option value="60">1 HOUR</option>
          </select>
          <button
            type="button"
            onClick={handleLockNow}
            class="px-3 py-1 border border-bb-border text-bb-text hover:border-bb-accent hover:text-bb-accent uppercase font-bold"
          >
            [LOCK NOW]
          </button>
        </div>
      </Show>

      <div class="border-t border-bb-border/40 pt-3">
        <div class="text-bb-muted uppercase font-bold mb-2">CHANGE PASSWORD</div>
        <PasswordSection />
      </div>

      <div class="border-t border-market-down/40 pt-3">
        <div class="text-market-down uppercase font-bold mb-2">PANIC WIPE</div>
        <div class="flex flex-col gap-2 max-w-sm">
          <p class="text-bb-muted">TYPE "WIPE" TO PERMANENTLY ERASE LOCAL VAULT DATA AND MESSAGES.</p>
          <input
            type="text"
            placeholder="TYPE WIPE TO CONFIRM"
            value={wipeText()}
            onInput={(e) => setWipeText(e.currentTarget.value)}
            class="bg-bb-bg border border-market-down/60 px-2 py-1 text-bb-text focus:outline-none focus:border-market-down"
          />
          <div class="flex items-center gap-3">
            <button
              type="button"
              disabled={!canWipe()}
              onClick={handlePanicWipe}
              class="px-3 py-1 border border-market-down text-market-down hover:bg-market-down/20 disabled:opacity-40 uppercase font-bold"
            >
              {wipeBusy() ? '[WIPING...]' : '[WIPE VAULT]'}
            </button>
            <Show when={wipeError()}>
              <span class="text-market-down">ERROR // {wipeError().toUpperCase()}</span>
            </Show>
          </div>
        </div>
      </div>
    </div>
  );
}

function DevicesSection() {
  const [devices, setDevices] = createSignal([]);
  const [loading, setLoading] = createSignal(true);
  const [pending, setPending] = createSignal([]);
  const [pendingLoading, setPendingLoading] = createSignal(true);
  const [error, setError] = createSignal('');

  const [linkToken, setLinkToken] = createSignal(null);
  const [polling, setPolling] = createSignal(false);
  const [linkError, setLinkError] = createSignal('');

  const [approveToken, setApproveToken] = createSignal('');
  const [approverPassword, setApproverPassword] = createSignal('');
  const [approving, setApproving] = createSignal(false);
  const [approveError, setApproveError] = createSignal('');
  const [approveMessage, setApproveMessage] = createSignal('');

  const [confirmId, setConfirmId] = createSignal(null);
  let confirmTimer;
  let pollTimer;
  let pendingTimer;

  const requiresVaultAuth = () => vaultStore.isLocked || !vaultStore.vaultExists;

  const loadDevices = async () => {
    try {
      const rows = await api.devices.list();
      setDevices(rows || []);
    } catch (e) {
      setDevices([]);
    } finally {
      setLoading(false);
    }
  };

  const loadPending = async () => {
    try {
      setPending(await api.devices.listPendingLinkRequests());
    } catch (e) {
      setPending([]);
    } finally {
      setPendingLoading(false);
    }
  };

  const stopPolling = () => {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    setPolling(false);
  };

  const pollLinkStatus = async () => {
    const token = linkToken();
    if (!token) return;
    try {
      const status = await api.devices.getLinkingStatus(token);
      if (status?.approved) {
        stopPolling();
        setLinkToken(null);
        await loadDevices();
        await loadPending();
      }
    } catch (e) { /* keep polling */ }
  };

  const startLinking = async () => {
    if (pollTimer) return;
    setLinkError('');
    try {
      const deviceId = vaultService.getDeviceId();
      const name = `${navigator.platform || 'Web'} - ${navigator.userAgent.split('/')[0]}`;
      const result = await api.devices.startLinking(deviceId, name);
      setLinkToken(result?.token || null);
      setPolling(true);
      pollLinkStatus();
      pollTimer = window.setInterval(() => { void pollLinkStatus(); }, 3000);
      await loadPending();
    } catch (e) {
      setLinkError(e?.message || 'FAILED TO START LINKING');
    }
  };

  const clearConfirm = () => {
    if (confirmTimer) clearTimeout(confirmTimer);
    confirmTimer = null;
    setConfirmId(null);
  };

  const revokeClick = async (id) => {
    if (confirmId() !== id) {
      if (confirmTimer) clearTimeout(confirmTimer);
      setConfirmId(id);
      confirmTimer = setTimeout(() => setConfirmId((cur) => (cur === id ? null : cur)), 4000);
      return;
    }
    clearConfirm();
    setError('');
    try {
      await api.devices.revoke(id);
      setDevices((prev) => prev.filter((d) => d.id !== id));
    } catch (e) {
      setError(e?.message || 'FAILED TO REVOKE DEVICE');
    }
  };

  const handleApprove = async () => {
    const token = approveToken().trim();
    setApproveError('');
    setApproveMessage('');
    if (!token) {
      setApproveError('TOKEN IS REQUIRED');
      return;
    }
    if (!approverPassword().trim()) {
      setApproveError('APPROVER PASSWORD IS REQUIRED');
      return;
    }
    setApproving(true);
    try {
      await api.devices.approveLinking(token, approverPassword());
      setApproveToken('');
      setApproverPassword('');
      setApproveMessage('DEVICE APPROVED');
      await loadDevices();
      await loadPending();
    } catch (e) {
      setApproveError(e?.message || 'APPROVAL FAILED');
    } finally {
      setApproving(false);
    }
  };

  onMount(() => {
    void loadDevices();
    void loadPending();
    pendingTimer = window.setInterval(() => { void loadPending(); }, 15000);
  });

  onCleanup(() => {
    if (confirmTimer) clearTimeout(confirmTimer);
    if (pendingTimer) clearInterval(pendingTimer);
    stopPolling();
  });

  return (
    <div class="text-xs flex flex-col gap-3">
      <Show when={requiresVaultAuth()}>
        <div data-testid="devices-gate" class="text-bb-muted">
          UNLOCK VAULT TO MANAGE DEVICES // SEE [VAULT] SECTION ABOVE
        </div>
      </Show>

      <Show when={!requiresVaultAuth()}>
        <Show when={loading()}>
          <div class="text-bb-muted animate-pulse">RUNNING QUERY...</div>
        </Show>
        <Show when={!loading()}>
          <Show when={devices().length > 0} fallback={<div class="text-bb-muted">NO DEVICES YET</div>}>
            <div class="flex flex-col gap-1">
              <For each={devices()}>
                {(device) => (
                  <div data-testid="device-row" class="flex items-center gap-3 py-1 border-b border-bb-border/30">
                    <span class="flex-1 text-bb-text">
                      {device.name || 'UNKNOWN DEVICE'}
                      {device.is_primary ? <span class="ml-2 text-bb-accent">[PRIMARY]</span> : null}
                      {vaultService.getDeviceId() === device.device_public_id ? <span class="ml-2 text-bb-muted">[THIS DEVICE]</span> : null}
                    </span>
                    <span class="text-bb-muted">
                      {device.created_at ? new Date(device.created_at).toLocaleDateString() : 'UNKNOWN'}
                    </span>
                    <Show when={!device.is_primary && vaultService.getDeviceId() !== device.device_public_id}>
                      <button
                        type="button"
                        data-testid="device-revoke"
                        onClick={() => revokeClick(device.id)}
                        onBlur={() => { if (confirmId() === device.id) clearConfirm(); }}
                        class="px-2 py-0.5 border border-market-down text-market-down hover:bg-market-down/20 uppercase font-bold"
                      >
                        {confirmId() === device.id ? '[CONFIRM?]' : '[REVOKE]'}
                      </button>
                    </Show>
                  </div>
                )}
              </For>
            </div>
          </Show>

          <div class="border-t border-bb-border/40 pt-3 mt-2">
            <div class="text-bb-muted uppercase font-bold mb-2">PENDING LINK REQUESTS</div>
            <Show when={pendingLoading()}>
              <div class="text-bb-muted animate-pulse">RUNNING QUERY...</div>
            </Show>
            <Show when={!pendingLoading()}>
              <Show when={pending().length > 0} fallback={<div class="text-bb-muted">NO PENDING REQUESTS</div>}>
                <div class="flex flex-col gap-1">
                  <For each={pending()}>
                    {(request) => (
                      <div data-testid="device-pending-row" class="flex items-center gap-3 py-1 border-b border-bb-border/30">
                        <span class="flex-1 text-bb-text">{request.device_name || 'NEW DEVICE'}</span>
                        <span class="text-bb-muted">
                          EXPIRES: {request.expires_at ? new Date(request.expires_at).toLocaleDateString() : 'UNKNOWN'}
                        </span>
                      </div>
                    )}
                  </For>
                </div>
              </Show>
            </Show>

            <div class="flex items-center gap-3 mt-3">
              <button
                type="button"
                data-testid="device-link-start"
                disabled={Boolean(linkToken()) || Boolean(polling())}
                onClick={startLinking}
                class="px-3 py-1 border border-bb-accent text-bb-accent hover:bg-bb-accent/20 disabled:opacity-50 uppercase font-bold"
              >
                [LINK NEW DEVICE]
              </button>
              <Show when={polling()}>
                <span class="text-bb-muted">WAITING FOR APPROVAL...</span>
              </Show>
              <Show when={linkError()}>
                <span class="text-market-down">ERROR // {linkError().toUpperCase()}</span>
              </Show>
            </div>
            <Show when={linkToken()}>
              <div data-testid="device-link-token" class="mt-2 break-all text-bb-text">
                TOKEN: {linkToken()}
              </div>
            </Show>
          </div>

          <div class="border-t border-bb-border/40 pt-3 mt-2">
            <div class="text-bb-muted uppercase font-bold mb-2">APPROVE LINK REQUEST</div>
            <div class="flex flex-col gap-2 max-w-sm">
              <input
                type="text"
                data-testid="device-approve-token"
                placeholder="LINKING TOKEN"
                value={approveToken()}
                onInput={(e) => setApproveToken(e.currentTarget.value)}
                class="bg-bb-bg border border-bb-border px-2 py-1 text-bb-text focus:outline-none focus:border-bb-accent"
              />
              <input
                type="password"
                data-testid="device-approve-password"
                placeholder="APPROVER PASSWORD"
                value={approverPassword()}
                onInput={(e) => setApproverPassword(e.currentTarget.value)}
                class="bg-bb-bg border border-bb-border px-2 py-1 text-bb-text focus:outline-none focus:border-bb-accent"
              />
              <div class="flex items-center gap-3">
                <button
                  type="button"
                  data-testid="device-approve-submit"
                  disabled={approving()}
                  onClick={handleApprove}
                  class="px-3 py-1 border border-bb-border text-bb-text hover:border-bb-accent hover:text-bb-accent disabled:opacity-50 uppercase font-bold"
                >
                  {approving() ? '[APPROVING...]' : '[APPROVE]'}
                </button>
                <Show when={approveMessage()}>
                  <span class="text-market-up">{approveMessage()}</span>
                </Show>
                <Show when={approveError()}>
                  <span class="text-market-down">ERROR // {approveError().toUpperCase()}</span>
                </Show>
              </div>
            </div>
          </div>
        </Show>
      </Show>

      <Show when={error()}>
        <div class="text-market-down">ERROR // {error().toUpperCase()}</div>
      </Show>
    </div>
  );
}

function ApiKeysSection() {
  const [keys, setKeys] = createSignal([]);
  const [loading, setLoading] = createSignal(true);
  const [needsVerification, setNeedsVerification] = createSignal(false);
  const [error, setError] = createSignal('');
  const [creating, setCreating] = createSignal(false);
  const [newKey, setNewKey] = createSignal(null);
  const [name, setName] = createSignal('');
  const [isBot, setIsBot] = createSignal(false);
  const [confirmId, setConfirmId] = createSignal(null);
  let confirmTimer;

  const isVerificationError = (e) => e instanceof ApiError && (e.status === 403 || e.message === 'Forbidden');

  const loadKeys = async () => {
    setLoading(true);
    setError('');
    try {
      const res = await api.users.getApiKeys();
      setKeys(res?.keys || []);
      setNeedsVerification(false);
    } catch (e) {
      if (isVerificationError(e)) {
        setNeedsVerification(true);
      } else {
        setError(e?.message || 'FAILED TO LOAD API KEYS');
      }
    } finally {
      setLoading(false);
    }
  };

  onMount(loadKeys);

  onCleanup(() => { if (confirmTimer) clearTimeout(confirmTimer); });

  const clearConfirm = () => {
    if (confirmTimer) clearTimeout(confirmTimer);
    confirmTimer = null;
    setConfirmId(null);
  };

  const create = async () => {
    const trimmed = name().trim();
    if (!trimmed) {
      setError('KEY NAME IS REQUIRED');
      return;
    }
    setCreating(true);
    setError('');
    setNewKey(null);
    try {
      const res = await api.users.createApiKey(trimmed, isBot());
      if (res?.apiKey) {
        setNewKey(res.apiKey);
        setName('');
        setIsBot(false);
        await loadKeys();
      }
    } catch (e) {
      if (isVerificationError(e)) {
        setNeedsVerification(true);
      } else {
        setError(e?.message || 'FAILED TO CREATE KEY');
      }
    } finally {
      setCreating(false);
    }
  };

  const revokeClick = async (id) => {
    if (confirmId() !== id) {
      if (confirmTimer) clearTimeout(confirmTimer);
      setConfirmId(id);
      confirmTimer = setTimeout(() => setConfirmId((cur) => (cur === id ? null : cur)), 4000);
      return;
    }
    clearConfirm();
    setError('');
    try {
      await api.users.revokeApiKey(id);
      setKeys((prev) => prev.filter((k) => k.id !== id));
    } catch (e) {
      setError(e?.message || 'FAILED TO REVOKE KEY');
    }
  };

  return (
    <div class="text-xs">
      <Show when={loading()}>
        <div class="text-bb-muted animate-pulse">RUNNING QUERY...</div>
      </Show>
      <Show when={!loading()}>
        <Show
          when={!needsVerification()}
          fallback={<div class="text-market-down">NEEDS EMAIL + PHONE VERIFICATION</div>}
        >
          <div class="flex items-center gap-2 mb-3 max-w-md">
            <input
              type="text"
              data-testid="apikey-name"
              placeholder="KEY NAME"
              value={name()}
              onInput={(e) => setName(e.currentTarget.value)}
              class="bg-bb-bg border border-bb-border px-2 py-1 text-bb-text flex-1 focus:outline-none focus:border-bb-accent"
            />
            <button
              type="button"
              onClick={() => setIsBot((b) => !b)}
              class={`px-2 py-1 border uppercase font-bold ${
                isBot() ? 'border-bb-accent text-bb-accent' : 'border-bb-border text-bb-muted hover:text-bb-text'
              }`}
            >
              [BOT]
            </button>
            <button
              type="button"
              data-testid="apikey-create"
              disabled={creating()}
              onClick={create}
              class="px-3 py-1 border border-bb-accent text-bb-accent hover:bg-bb-accent/20 disabled:opacity-50 uppercase font-bold"
            >
              {creating() ? '[CREATING...]' : '[CREATE KEY]'}
            </button>
          </div>

          <Show when={newKey()}>
            <div data-testid="apikey-reveal" class="mb-3 border border-market-up bg-market-up/10 p-2 max-w-md">
              <div class="text-market-up font-bold">COPY IT NOW // SHOWN ONCE</div>
              <div class="mt-1 break-all text-bb-text">{newKey()}</div>
            </div>
          </Show>

          <Show when={keys().length > 0} fallback={<div class="text-bb-muted">NO API KEYS ACTIVE</div>}>
            <div class="flex flex-col gap-1">
              <For each={keys()}>
                {(k) => (
                  <div data-testid="apikey-row" class="flex items-center gap-3 py-1 border-b border-bb-border/30">
                    <span class="flex-1 text-bb-text">{k.name}</span>
                    <span class="text-bb-muted uppercase">{k.is_bot ? 'BOT' : 'CLI'}</span>
                    <span class="text-bb-muted">
                      {k.last_used_at ? new Date(k.last_used_at).toLocaleDateString() : 'NEVER'}
                    </span>
                    <button
                      type="button"
                      data-testid="apikey-revoke"
                      onClick={() => revokeClick(k.id)}
                      onBlur={() => { if (confirmId() === k.id) clearConfirm(); }}
                      class="px-2 py-0.5 border border-market-down text-market-down hover:bg-market-down/20 uppercase font-bold"
                    >
                      {confirmId() === k.id ? '[CONFIRM?]' : '[REVOKE]'}
                    </button>
                  </div>
                )}
              </For>
            </div>
          </Show>
        </Show>
      </Show>
      <Show when={error()}>
        <div class="mt-2 text-market-down">ERROR // {error().toUpperCase()}</div>
      </Show>
    </div>
  );
}

function PasskeysSection() {
  const [checked, setChecked] = createSignal(false);
  const [available, setAvailable] = createSignal(false);
  const [credentials, setCredentials] = createSignal([]);
  const [loading, setLoading] = createSignal(true);
  const [showForm, setShowForm] = createSignal(false);
  const [registering, setRegistering] = createSignal(false);
  const [newName, setNewName] = createSignal('');
  const [currentPassword, setCurrentPassword] = createSignal('');
  const [error, setError] = createSignal('');
  const [warning, setWarning] = createSignal('');
  const [confirmId, setConfirmId] = createSignal(null);
  let confirmTimer;

  const loadCredentials = async () => {
    try {
      setCredentials(await webauthnService.getCredentials());
    } catch {
      setCredentials([]);
    } finally {
      setLoading(false);
    }
  };

  onMount(async () => {
    setAvailable(await webauthnService.isAvailable());
    setChecked(true);
    loadCredentials();
  });

  onCleanup(() => { if (confirmTimer) clearTimeout(confirmTimer); });

  const clearConfirm = () => {
    if (confirmTimer) clearTimeout(confirmTimer);
    confirmTimer = null;
    setConfirmId(null);
  };

  const register = async (e) => {
    e.preventDefault();
    const preferred = newName().trim() || 'MY PASSKEY';
    setRegistering(true);
    setError('');
    setWarning('');
    try {
      const prfInput = vaultService.isUnlocked() ? await vaultService.getPrfInput() : null;
      const passwordForPrf = vaultService.isUnlocked() ? currentPassword() : null;
      if (vaultService.isUnlocked() && !passwordForPrf) {
        throw new Error('CURRENT PASSWORD IS REQUIRED TO UPDATE VAULT PASSKEY UNLOCK');
      }
      const result = await webauthnService.register(preferred, prfInput);
      const credentialId = result?.credentialID || result?.credentialId || result?.id;
      if (result?.prfOutput && vaultService.isUnlocked()) {
        try {
          await vaultService.setupPrfWrapping(result.prfOutput, credentialId, result.prfInput, passwordForPrf);
        } catch (err) {
          setWarning(err?.message || 'PRF SETUP SKIPPED');
        }
      }
      if (credentialId) await loadCredentials();
      setShowForm(false);
      setNewName('');
      setCurrentPassword('');
    } catch (err) {
      setError(err?.message || 'FAILED TO REGISTER PASSKEY');
    } finally {
      setRegistering(false);
    }
  };

  const confirmDelete = async (id) => {
    if (confirmId() !== id) {
      if (confirmTimer) clearTimeout(confirmTimer);
      setConfirmId(id);
      confirmTimer = setTimeout(() => setConfirmId((cur) => (cur === id ? null : cur)), 4000);
      return;
    }
    clearConfirm();
    setError('');
    try {
      await webauthnService.deleteCredential(id);
      await loadCredentials();
    } catch (e) {
      setError(e?.message || 'FAILED TO DELETE PASSKEY');
    }
  };

  return (
    <div class="text-xs">
      <Show when={checked() && !available()}>
        <div class="text-bb-muted">WEBAUTHN NOT SUPPORTED</div>
      </Show>
      <Show when={available()}>
        <Show when={loading()}>
          <div class="text-bb-muted animate-pulse">RUNNING QUERY...</div>
        </Show>
        <Show when={!loading()}>
          <Show when={credentials().length > 0} fallback={<div class="text-bb-muted mb-2">NO PASSKEYS REGISTERED</div>}>
            <div class="flex flex-col gap-1 mb-2">
              <For each={credentials()}>
                {(c) => (
                  <div data-testid="passkey-row" class="flex items-center gap-3 py-1 border-b border-bb-border/30">
                    <span class="flex-1 text-bb-text">{c.name || 'PASSKEY'}</span>
                    <span class="text-bb-muted">
                      USED: {c.last_used_at ? new Date(c.last_used_at).toLocaleDateString() : 'NEVER'}
                    </span>
                    <button
                      type="button"
                      data-testid="passkey-delete"
                      onClick={() => confirmDelete(c.id)}
                      onBlur={() => { if (confirmId() === c.id) clearConfirm(); }}
                      class="px-2 py-0.5 border border-market-down text-market-down hover:bg-market-down/20 uppercase font-bold"
                    >
                      {confirmId() === c.id ? '[CONFIRM?]' : '[REMOVE]'}
                    </button>
                  </div>
                )}
              </For>
            </div>
          </Show>

          <Show when={!showForm()}>
            <button
              type="button"
              onClick={() => setShowForm(true)}
              class="px-3 py-1 border border-bb-border text-bb-text hover:border-bb-accent hover:text-bb-accent uppercase font-bold"
            >
              [ADD PASSKEY]
            </button>
          </Show>

          <Show when={showForm()}>
            <form onSubmit={register} class="flex flex-col gap-2 max-w-sm">
              <input
                type="text"
                placeholder="PASSKEY NAME"
                value={newName()}
                disabled={registering()}
                onInput={(e) => setNewName(e.currentTarget.value)}
                class="bg-bb-bg border border-bb-border px-2 py-1 text-bb-text focus:outline-none focus:border-bb-accent"
              />
              <Show when={vaultService.isUnlocked()}>
                <input
                  type="password"
                  placeholder="CURRENT PASSWORD"
                  value={currentPassword()}
                  disabled={registering()}
                  onInput={(e) => setCurrentPassword(e.currentTarget.value)}
                  class="bg-bb-bg border border-bb-border px-2 py-1 text-bb-text focus:outline-none focus:border-bb-accent"
                />
              </Show>
              <div class="flex items-center gap-3">
                <button
                  type="button"
                  disabled={registering()}
                  onClick={() => { setShowForm(false); setNewName(''); setCurrentPassword(''); }}
                  class="px-3 py-1 border border-bb-border text-bb-muted hover:text-bb-text uppercase font-bold"
                >
                  [CANCEL]
                </button>
                <button
                  type="submit"
                  disabled={registering()}
                  class="px-3 py-1 border border-bb-accent text-bb-accent hover:bg-bb-accent/20 disabled:opacity-50 uppercase font-bold"
                >
                  {registering() ? '[REGISTERING...]' : '[CONTINUE]'}
                </button>
              </div>
            </form>
          </Show>

          <Show when={warning()}>
            <div class="mt-2 text-market-down">WARNING // {warning().toUpperCase()}</div>
          </Show>
          <Show when={error()}>
            <div class="mt-2 text-market-down">ERROR // {error().toUpperCase()}</div>
          </Show>
        </Show>
      </Show>
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
    <div class="font-mono text-sm p-px columns-1 md:columns-2 xl:columns-3 gap-px">
      <Section title="SKIN" code="SET·01"><SkinSection /></Section>
      <Section title="FEED MIX" code="SET·02"><FeedMixSection /></Section>
      <Section title="TOPICS" code="SET·03"><TopicsSection /></Section>
      <Section title="NOTIFICATIONS" code="SET·04"><NotificationsSection /></Section>
      <Section title="VERIFICATION" code="SET·05"><VerificationSection /></Section>
      <Section title="API KEYS" code="SET·06"><ApiKeysSection /></Section>
      <Section title="PASSKEYS" code="SET·07"><PasskeysSection /></Section>
      <Section title="VAULT" code="SET·08"><VaultSection /></Section>
      <Section title="DEVICES" code="SET·09"><DevicesSection /></Section>
      <Section title="DANGER ZONE" code="SET·10" tone="danger"><DangerZoneSection /></Section>
    </div>
  );
}
