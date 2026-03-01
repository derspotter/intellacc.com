import { createSignal, Show } from 'solid-js';
import { api } from '../../services/api';

export default function PasswordResetCancel() {
  const [status, setStatus] = createSignal('');
  const [error, setError] = createSignal('');
  const [submitting, setSubmitting] = createSignal(false);

  const handleCancel = async () => {
    setStatus('');
    setError('');
    setSubmitting(true);

    try {
      const result = await api.auth.cancelPasswordReset();
      setStatus(result?.cancelled ? 'Pending password reset cancelled.' : 'No pending password reset found.');
    } catch (err) {
      setError(err?.message || 'Failed to cancel password reset.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section class="settings-section password-reset-cancel">
      <h3 class="settings-section-title">
        <span class="section-icon">🔐</span>
        Password Reset
      </h3>
      <p>Cancel an in-progress password reset request if you still have access to this device.</p>
      <button
        type="button"
        class="button button-secondary"
        onClick={handleCancel}
        disabled={submitting()}
      >
        {submitting() ? 'Cancelling…' : 'Cancel pending reset'}
      </button>
      <Show when={status()}>
        <p class="success-message">{status()}</p>
      </Show>
      <Show when={error()}>
        <p class="error-message">{error()}</p>
      </Show>
    </section>
  );
}

