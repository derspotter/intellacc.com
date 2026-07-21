import { Show, createSignal } from 'solid-js';
import { api } from '../../../../services/api';

export default function DangerZoneSection() {
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
      const tokenService = await import('../../../../services/tokenService');
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
