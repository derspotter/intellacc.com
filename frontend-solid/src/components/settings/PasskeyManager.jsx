import {
  For,
  Show,
  createSignal,
  onMount
} from 'solid-js';
import vaultService from '../../services/mls/vaultService';
import webauthnService from '../../services/webauthn';

const formatDate = (value) => {
  if (!value) {
    return 'Never';
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return 'Never';
  }
  return date.toLocaleDateString();
};

export default function PasskeyManager() {
  const [credentials, setCredentials] = createSignal([]);
  const [loading, setLoading] = createSignal(true);
  const [registering, setRegistering] = createSignal(false);
  const [errorMessage, setErrorMessage] = createSignal('');
  const [newName, setNewName] = createSignal('');
  const [showForm, setShowForm] = createSignal(false);
  const [webauthnAvailable, setWebauthnAvailable] = createSignal(false);

  const loadCredentials = async () => {
    try {
      setCredentials(await webauthnService.getCredentials());
    } catch (err) {
      setCredentials([]);
      console.error('[PasskeyManager] Load credentials failed:', err);
    } finally {
      setLoading(false);
    }
  };

  onMount(async () => {
    setWebauthnAvailable(await webauthnService.isAvailable());
    loadCredentials();
  });

  const handleAdd = async (event) => {
    event.preventDefault();
    const preferred = newName().trim() || 'My Passkey';

    setRegistering(true);
    setErrorMessage('');

    try {
      const prfInput = vaultService.isUnlocked() ? await vaultService.getPrfInput() : null;
      const result = await webauthnService.register(preferred, prfInput);
      const credentialId = result?.credentialID || result?.credentialId || result?.id;
      if (result?.prfOutput) {
        if (vaultService.isUnlocked()) {
          try {
            await vaultService.setupPrfWrapping(
              result.prfOutput,
              credentialId,
              result.prfInput
            );
          } catch (err) {
            console.warn('[PasskeyManager] PRF setup skipped:', err);
          }
        } else {
          console.info('[PasskeyManager] Vault locked; PRF wrapping will be prepared when unlocked.');
        }
      }

      if (credentialId) {
        await loadCredentials();
      }

      setShowForm(false);
      setNewName('');
    } catch (err) {
      setErrorMessage(err?.message || 'Failed to register passkey.');
    } finally {
      setRegistering(false);
    }
  };

  const handleDelete = async (id) => {
    if (!window.confirm('Are you sure you want to remove this passkey?')) {
      return;
    }

    try {
      await webauthnService.deleteCredential(id);
      await loadCredentials();
    } catch (err) {
      window.alert(err?.message || 'Failed to delete passkey');
    }
  };

  return (
    <section class="settings-section passkey-manager">
      <h3 class="settings-section-title">
        <span class="section-icon">🔑</span>
        Passkeys
      </h3>

      <Show when={!webauthnAvailable()}>
        <p>Passkeys are not supported in this browser.</p>
      </Show>

      <Show when={webauthnAvailable()}>
        <div class="passkey-content">
          <p>Passkeys let you sign in securely without a password.</p>

          <Show when={loading()}>
            <p>Loading…</p>
          </Show>

          <Show when={!loading()}>
            <Show when={credentials().length === 0}>
              <p class="muted">No passkeys registered.</p>
            </Show>

            <ul class="passkey-list">
              <For each={credentials()}>
                {(credential) => (
                  <li class="passkey-item">
                    <div class="passkey-info">
                      <span class="passkey-name">{credential.name || 'Passkey'}</span>
                      <span class="passkey-date">
                        Used: {formatDate(credential.last_used_at)}
                      </span>
                    </div>
                    <button
                      type="button"
                      class="button button-danger button-sm"
                      onClick={() => handleDelete(credential.id)}
                    >
                      Remove
                    </button>
                  </li>
                )}
              </For>
            </ul>
          </Show>

          <Show when={!showForm()}>
            <button
              type="button"
              class="button button-primary"
              onClick={() => setShowForm(true)}
            >
              Add Passkey
            </button>
          </Show>

          <Show when={showForm()}>
            <form class="settings-form" onSubmit={handleAdd}>
              <div class="form-group">
                <input
                  type="text"
                  placeholder="Passkey name (for example, MacBook Pro)"
                  class="form-input"
                  value={newName()}
                  onInput={(event) => setNewName(event.target.value)}
                  required
                  disabled={registering()}
                />
              </div>
              <div class="form-actions">
                <button
                  type="button"
                  class="button button-secondary"
                  onClick={() => {
                    setShowForm(false);
                    setNewName('');
                  }}
                  disabled={registering()}
                >
                  Cancel
                </button>
                <button type="submit" class="button button-primary" disabled={registering()}>
                  {registering() ? 'Registering…' : 'Continue'}
                </button>
              </div>
              <Show when={errorMessage()}>
                <p class="error-message">{errorMessage()}</p>
              </Show>
            </form>
          </Show>
        </div>
      </Show>
    </section>
  );
}
