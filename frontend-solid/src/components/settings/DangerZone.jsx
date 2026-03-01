import { createSignal, Show } from 'solid-js';
import { clearToken } from '../../services/auth';
import { isAuthenticated } from '../../services/auth';
import { api } from '../../services/api';

export default function DangerZone() {
  const [password, setPassword] = createSignal('');
  const [confirmText, setConfirmText] = createSignal('');
  const [submitting, setSubmitting] = createSignal(false);
  const [error, setError] = createSignal('');

  const handleDelete = async () => {
    if (!password()) {
      setError('Password is required.');
      return;
    }
    if (confirmText().trim() !== 'DELETE') {
      setError('Type DELETE to confirm.');
      return;
    }

    setSubmitting(true);
    setError('');

    try {
      await api.users.deleteAccount(password());
      clearToken();
      window.location.hash = 'login';
      window.location.reload();
    } catch (err) {
      setError(err?.message || 'Failed to delete account');
      setSubmitting(false);
    }
  };

  return (
    <section class="settings-section danger-zone">
      <h3 class="settings-section-title">
        <span class="section-icon">☠️</span>
        Danger Zone
      </h3>
      <p>Delete your account. This cannot be undone. Your profile will be anonymized immediately.</p>
      <Show when={isAuthenticated()}>
        <div class="form-group">
          <input
            type="password"
            class="form-input"
            placeholder="Confirm your password"
            value={password()}
            onInput={(event) => setPassword(event.target.value)}
            disabled={submitting()}
          />
        </div>

        <div class="form-group">
          <input
            type="text"
            class="form-input"
            placeholder="Type DELETE to confirm"
            value={confirmText()}
            onInput={(event) => setConfirmText(event.target.value)}
            disabled={submitting()}
          />
        </div>

        <Show when={error()}>
          <p class="error-message">{error()}</p>
        </Show>

        <button
          type="button"
          class="button button-danger"
          onClick={handleDelete}
          disabled={submitting()}
        >
          {submitting() ? 'Deleting…' : 'Delete Account'}
        </button>
      </Show>
    </section>
  );
}
