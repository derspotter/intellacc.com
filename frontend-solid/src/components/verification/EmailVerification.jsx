import { createSignal, Show } from 'solid-js';
import { api } from '../../services/api';

export default function EmailVerification({ onSuccess, userEmail }) {
  const [status, setStatus] = createSignal('idle');
  const [error, setError] = createSignal('');
  const [cooldown, setCooldown] = createSignal(0);
  let timer = null;

  const clearTimer = () => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  };

  const startCooldown = (seconds) => {
    clearTimer();
    let remaining = seconds;
    setCooldown(remaining);
    timer = window.setInterval(() => {
      remaining = Math.max(0, remaining - 1);
      setCooldown(remaining);
      if (remaining === 0) {
        clearTimer();
      }
    }, 1000);
  };

  const send = async () => {
    if (cooldown() > 0) return;
    setStatus('sending');
    setError('');

    try {
      await api.verification.sendEmailVerification();
      setStatus('sent');
      startCooldown(60);
      onSuccess?.();
    } catch (err) {
      setStatus('error');
      setError(err?.data?.error || err?.message || 'Failed to send verification email');
      if (err?.status === 429) {
        startCooldown(err?.data?.retryAfter || 60);
      }
    }
  };

  return (
    <section class="email-verification">
      <div class="verification-icon">📧</div>
      <h3>Verify your email</h3>
      <Show when={status() === 'sent'}>
        <div class="success-state">
          <div class="success-icon">✓</div>
          <p class="success-message">
            Verification email sent to {userEmail || 'your email'}.
          </p>
          <p class="instructions">Check your inbox and click the verification link.</p>
          <p class="spam-note">
            Didn&apos;t receive it? Check spam or {cooldown() > 0 ? `wait ${cooldown()}s` : <button type="button" class="btn-link" onClick={send}>resend</button>}
          </p>
        </div>
      </Show>
      <Show when={status() === 'sending'}>
        <div class="loading-state">
          <div class="spinner" />
          <p>Sending verification email...</p>
        </div>
      </Show>
      <Show when={status() === 'error'}>
        <div class="error-state">
          <p class="error-message">{error()}</p>
          <button type="button" class="btn btn-primary" onClick={send} disabled={cooldown() > 0}>
            {cooldown() > 0 ? `Wait ${cooldown()}s` : 'Try again'}
          </button>
        </div>
      </Show>
      <Show when={status() === 'idle'}>
        <p class="description">Verify your email address to unlock posting, commenting, and messaging.</p>
        <Show when={userEmail}>
          <p class="email-display">We&apos;ll send it to {userEmail}</p>
        </Show>
        <button type="button" class="btn btn-primary" onClick={send}>
          Send verification email
        </button>
      </Show>
    </section>
  );
}
