import { Show, createSignal, onMount } from 'solid-js';
import vaultService from '../../../../services/mls/vaultService';
import vaultStore from '../../../../store/vaultStore';
import { configureIdleAutoLock, loadIdleLockConfig } from '../../../../services/idleLock';
import { clearToken } from '../../../../services/tokenService';
import { resetE2ee } from '../../../../services/mls/e2eeReset';
import PasswordSection from './PasswordSection';

export default function VaultSection() {
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

  const [resetPw, setResetPw] = createSignal('');
  const [resetBusy, setResetBusy] = createSignal(false);
  const [resetError, setResetError] = createSignal('');

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

  const handleResetE2ee = async (event) => {
    event.preventDefault();
    if (resetBusy() || !resetPw()) return;
    setResetBusy(true);
    setResetError('');
    try {
      await resetE2ee(resetPw());
      // reloads on success
    } catch (err) {
      setResetError(err?.data?.error || err?.message || 'RESET FAILED');
      setResetBusy(false);
    }
  };

  const handlePanicWipe = async () => {
    if (!canWipe()) return;
    setWipeBusy(true);
    setWipeError('');
    try {
      await vaultService.panicWipe();
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

      <div class="border-t border-market-down/40 pt-3">
        <div class="text-market-down uppercase font-bold mb-2">E2EE RESET</div>
        <form onSubmit={handleResetE2ee} class="flex flex-col gap-2 max-w-sm">
          <p class="text-bb-muted">
            LOST VAULT OR LOCKED OUT EVERYWHERE? DELETES ENCRYPTED MESSAGE
            HISTORY + KEYS ON ALL DEVICES AND STARTS FRESH. PEERS SEE A NEW
            SAFETY NUMBER. CANNOT BE UNDONE.
          </p>
          <input
            type="password"
            placeholder="ACCOUNT PASSWORD TO CONFIRM"
            value={resetPw()}
            onInput={(e) => setResetPw(e.currentTarget.value)}
            disabled={resetBusy()}
            class="bg-bb-bg border border-market-down/60 px-2 py-1 text-bb-text focus:outline-none focus:border-market-down"
          />
          <div class="flex items-center gap-3">
            <button
              type="submit"
              disabled={resetBusy() || !resetPw()}
              class="px-3 py-1 border border-market-down text-market-down hover:bg-market-down/20 disabled:opacity-40 uppercase font-bold"
            >
              {resetBusy() ? '[RESETTING...]' : '[RESET E2EE]'}
            </button>
            <Show when={resetError()}>
              <span class="text-market-down">ERROR // {String(resetError()).toUpperCase()}</span>
            </Show>
          </div>
        </form>
      </div>
    </div>
  );
}
