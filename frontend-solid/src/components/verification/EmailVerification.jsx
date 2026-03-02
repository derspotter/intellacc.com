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
    <section class="email-verification" style="text-align: left; padding: 1rem 0;">
      <div class="verification-icon" style="font-size: 2rem; margin-bottom: 0.5rem;">📧</div>
      <h3 style="margin-top: 0; margin-bottom: 0.5rem;">Verify your email</h3>
      <Show when={status() === 'sent'}>
        <div class="success-state" style="text-align: left; padding: 1rem 0;">
          <div class="success-icon" style="display: inline-flex; align-items: center; justify-content: center; width: 32px; height: 32px; background: var(--success-color); color: white; border-radius: 50%; margin-bottom: 0.5rem;">✓</div>
          <p class="success-message" style="margin-bottom: 0.5rem;">
            Verification email sent to {userEmail || 'your email'}.
          </p>
          <p class="instructions" style="margin-bottom: 0.5rem;">Check your inbox and click the verification link.</p>
          <p class="spam-note">
            Didn&apos;t receive it? Check spam or {cooldown() > 0 ? `wait ${cooldown()}s` : <button type="button" class="btn-link" style="padding: 0; margin: 0; border: none; background: none; color: var(--primary-color); cursor: pointer; text-decoration: underline;" onClick={send}>resend</button>}
          </p>
        </div>
      </Show>
      <Show when={status() === 'sending'}>
        <div class="loading-state" style="text-align: left;">
          <div class="spinner" style="margin-bottom: 0.5rem;" />
          <p style="margin: 0;">Sending verification email...</p>
        </div>
      </Show>
      <Show when={status() === 'error'}>
        <div class="error-state" style="text-align: left;">
          <p class="error-message" style="margin-bottom: 1rem;">{error()}</p>
          <button type="button" class="button button-primary" onClick={send} disabled={cooldown() > 0}>
            {cooldown() > 0 ? `Wait ${cooldown()}s` : 'Try again'}
          </button>
        </div>
      </Show>
      <Show when={status() === 'idle'}>
        <div class="idle-state" style="text-align: left;">
          <p class="description" style="margin-bottom: 0.5rem;">Verify your email address to unlock posting, commenting, and messaging.</p>
          <Show when={userEmail}>
            <p class="email-display" style="margin-bottom: 1.5rem;">We&apos;ll send it to <strong>{userEmail}</strong></p>
          </Show>
          <button type="button" class="button button-primary" onClick={send}>
            Send verification email
          </button>
        </div>
      </Show>
    </section>
  );
}
