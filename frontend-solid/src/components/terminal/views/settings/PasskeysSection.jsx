import { For, Show, createSignal, onMount } from 'solid-js';
import webauthnService from '../../../../services/webauthn';
import vaultService from '../../../../services/mls/vaultService';
import useConfirmTimer from '../../lib/useConfirmTimer';

export default function PasskeysSection() {
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
  const confirmTimer = useConfirmTimer();

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
    if (!confirmTimer.confirm(id)) return;
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
                      onBlur={() => confirmTimer.disarm(c.id)}
                      class="px-2 py-0.5 border border-market-down text-market-down hover:bg-market-down/20 uppercase font-bold"
                    >
                      {confirmTimer.isArmed(c.id) ? '[CONFIRM?]' : '[REMOVE]'}
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
