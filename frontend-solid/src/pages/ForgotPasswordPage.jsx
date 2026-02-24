import { createSignal, Show } from 'solid-js';
import { forgotPassword } from '../services/api';

export default function ForgotPasswordPage() {
  const [email, setEmail] = createSignal('');
  const [error, setError] = createSignal('');
  const [message, setMessage] = createSignal('');
  const [sending, setSending] = createSignal(false);
  const [sent, setSent] = createSignal(false);

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (sending()) {
      return;
    }

    const value = email().trim();
    if (!value) {
      setError('Email is required.');
      return;
    }

    setError('');
    setMessage('');
    setSending(true);
    try {
      const response = await forgotPassword(value);
      setSent(true);
      setMessage(response?.message || 'If an account exists for that email, a reset link was sent.');
    } catch (err) {
      setError(err?.message || 'Failed to request reset link.');
    } finally {
      setSending(false);
    }
  };

  return (
    <section class="login-page">
      <div class="login-container">
        <h1>Reset Password</h1>
        <p>Enter your email address to receive a password reset link.</p>

        <Show when={!sent()}>
          <form class="auth-form" onSubmit={handleSubmit}>
            <div class="form-group">
              <label class="field">
                <span>Email</span>
                <input
                  type="email"
                  value={email()}
                  onInput={(event) => setEmail(event.target.value)}
                  placeholder="you@example.com"
                  autocomplete="email"
                  required
                  disabled={sending()}
                />
              </label>
            </div>
            <div class="form-actions">
              <button type="submit" disabled={sending()}>
                {sending() ? 'Sending…' : 'Send reset link'}
              </button>
            </div>
          </form>
        </Show>

        <Show when={error()}>
          <p class="error-message">{error()}</p>
        </Show>
        <Show when={message()}>
          <p class="success">{message()}</p>
        </Show>

        <Show when={sent()}>
          <div class="reset-note">
            <p>Check your inbox and spam folder for the reset link.</p>
          </div>
        </Show>

        <div class="auth-links">
          <a href="#login">Back to sign in</a>
        </div>
      </div>
    </section>
  );
}
