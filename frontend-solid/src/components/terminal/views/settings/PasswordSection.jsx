import { Show, createSignal } from 'solid-js';
import { api } from '../../../../services/api';
import vaultService from '../../../../services/mls/vaultService';
import vaultStore from '../../../../store/vaultStore';

export default function PasswordSection() {
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
