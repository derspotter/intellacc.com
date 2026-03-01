import { createSignal, Show } from 'solid-js';
import { clearToken } from '../services/auth';
import { resetPassword } from '../services/api';

const getTokenFromHash = () => {
  const hash = window.location.hash.replace(/^#/, '');
  const [, queryString = ''] = hash.split('?');
  const params = new URLSearchParams(queryString);
  return params.get('token');
};

export default function ResetPasswordPage() {
  const token = getTokenFromHash();
  const [error, setError] = createSignal('');
  const [stage, setStage] = createSignal(token ? 'warning' : 'invalid');
  const [acknowledged, setAcknowledged] = createSignal(false);
  const [newPassword, setNewPassword] = createSignal('');
  const [confirmPassword, setConfirmPassword] = createSignal('');
  const [pending, setPending] = createSignal(false);
  const [message, setMessage] = createSignal('');
  const [executeAfter, setExecuteAfter] = createSignal('');

  const handleContinue = () => {
    if (!acknowledged()) {
      setError('Please confirm you understand the impact before continuing.');
      return;
    }
    setError('');
    setStage('form');
  };

  const clearLocalResetState = () => {
    clearToken();
    if (typeof indexedDB !== 'undefined') {
      try {
        indexedDB.deleteDatabase('intellacc_keystore');
      } catch (err) {
        console.warn('Failed to clear keystore database:', err);
      }
    }
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (pending()) {
      return;
    }

    if (!token) {
      setError('Reset token is missing.');
      return;
    }
    if (!acknowledged()) {
      setError('Acknowledgment is required.');
      return;
    }

    if (newPassword().length < 6) {
      setError('Password must be at least 6 characters long.');
      return;
    }

    if (newPassword() !== confirmPassword()) {
      setError('Passwords do not match.');
      return;
    }

    setError('');
    setMessage('');
    setPending(true);
    setStage('resetting');
    try {
      const result = await resetPassword(token, newPassword(), acknowledged());
      clearToken();

      if (result?.status === 'pending') {
        if (result.executeAfter) {
          setExecuteAfter(new Date(result.executeAfter).toLocaleString());
        }
        setMessage('Your password reset is pending and will complete after the security delay.');
        setStage('pending');
        return;
      }

      setMessage('Password reset complete. Sign in again.');
      clearLocalResetState();
      setStage('success');
    } catch (err) {
      setError(err?.message || 'Failed to reset password.');
      setStage('invalid');
      return;
    } finally {
      setPending(false);
    }
  };

  return (
    <section class="login-page">
      <div class="login-container">
        <h1>Reset Password</h1>

      <Show when={stage() === 'invalid'}>
        <p class="error-message">This reset link is invalid or has expired.</p>
        <div class="auth-links">
          <a href="#forgot-password">Request a new link</a>
        </div>
      </Show>

      <Show when={stage() === 'warning'}>
        <div class="reset-warning">
          <p>WARNING: Resetting your password will permanently remove your access to encrypted data.</p>
          <p>By resetting, you will lose:</p>
          <ul>
            <li>Encrypted messages in your conversations</li>
            <li>Your MLS keys and group memberships</li>
            <li>Access to encrypted conversations until re-invited</li>
          </ul>
          <p>This cannot be undone. Your account and public posts remain intact.</p>
          <div class="reset-checkbox">
            <input
              type="checkbox"
              id="reset-warning-checkbox"
              checked={acknowledged()}
              onChange={(event) => setAcknowledged(event.target.checked)}
            />
            <label for="reset-warning-checkbox">I understand and want to continue.</label>
          </div>
          <div class="form-actions">
            <button type="button" class="btn-primary" onClick={handleContinue}>
              Continue
            </button>
          </div>
          <div class="auth-links">
            <a href="#forgot-password">Back</a>
          </div>
        </div>
      </Show>

      <Show when={stage() === 'form'}>
        <form class="auth-form" onSubmit={handleSubmit}>
          <div class="form-group">
            <label for="new-password">New password</label>
            <input
              id="new-password"
              type="password"
              value={newPassword()}
              onInput={(event) => setNewPassword(event.target.value)}
              placeholder="Enter new password"
              autocomplete="new-password"
              required
              disabled={pending()}
            />
          </div>
          <div class="form-group">
            <label for="confirm-password">Confirm password</label>
            <input
              id="confirm-password"
              type="password"
              value={confirmPassword()}
              onInput={(event) => setConfirmPassword(event.target.value)}
              placeholder="Re-enter new password"
              autocomplete="new-password"
              required
              disabled={pending()}
            />
          </div>
          <div class="form-group">
            <div class="reset-checkbox">
              <input
                type="checkbox"
                id="reset-confirm-checkbox"
                checked={acknowledged()}
                onChange={(event) => setAcknowledged(event.target.checked)}
              />
              <label for="reset-confirm-checkbox">I understand the encrypted data will be removed.</label>
            </div>
          </div>
          <div class="form-actions">
            <button type="submit" class="btn-primary" disabled={pending()}>
              {pending() ? 'Resetting…' : 'Reset password'}
            </button>
          </div>
        </form>
      </Show>

      <Show when={stage() === 'pending'}>
        <p class="success">{message()}</p>
        <Show when={executeAfter()}>
          <p>Completes after: {executeAfter()}</p>
        </Show>
        <div class="auth-links">
          <a href="#login">Back to sign in</a>
        </div>
      </Show>

      <Show when={stage() === 'success'}>
        <p class="success">{message()}</p>
        <div class="auth-links">
          <a href="#login">Go to sign in</a>
        </div>
      </Show>

      <Show when={stage() === 'resetting'}>
        <p class="reset-note">Applying reset...</p>
      </Show>

      <Show when={error()}>
        <p class="error-message">{error()}</p>
      </Show>
      </div>
    </section>
  );
}
