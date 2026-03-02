import { createSignal, Show } from 'solid-js';
import { api } from '../../services/api';

export default function PhoneVerification({ onSuccess } = {}) {
  const [stage, setStage] = createSignal('idle');
  const [phoneNumber, setPhoneNumber] = createSignal('');
  const [code, setCode] = createSignal('');
  const [error, setError] = createSignal('');
  const [devCode, setDevCode] = createSignal('');

  const sendCode = async () => {
    if (!phoneNumber().trim()) {
      setError('Enter a phone number first');
      return;
    }

    setStage('sending');
    setError('');
    setDevCode('');

    try {
      const result = await api.verification.startPhoneVerification(phoneNumber().trim());
      setStage('code_sent');
      setCode('');
      if (result?.dev_code) {
        setDevCode(result.dev_code);
      }
    } catch (err) {
      setStage('idle');
      setError(err?.data?.error || err?.message || 'Failed to send verification code');
    }
  };

  const verifyCode = async () => {
    if (!code().trim()) {
      setError('Enter the verification code');
      return;
    }

    setStage('verifying');
    setError('');
    try {
      await api.verification.confirmPhoneVerification(phoneNumber().trim(), code().trim());
      setStage('success');
      onSuccess?.();
    } catch (err) {
      setStage('code_sent');
      setError(err?.data?.error || err?.message || 'Verification failed');
    }
  };

  return (
    <section class="phone-verification" style="text-align: left; padding: 1rem 0;">
      <div class="verification-icon" style="font-size: 2rem; margin-bottom: 0.5rem;">📱</div>
      <h3 style="margin-top: 0; margin-bottom: 0.5rem;">Verify your phone</h3>
      <Show when={stage() === 'sending'}>
        <div class="loading-state" style="text-align: left;">
          <div class="spinner" style="margin-bottom: 0.5rem;" />
          <p style="margin: 0;">Sending verification code...</p>
        </div>
      </Show>
      <Show when={stage() === 'verifying'}>
        <div class="loading-state" style="text-align: left;">
          <div class="spinner" style="margin-bottom: 0.5rem;" />
          <p style="margin: 0;">Verifying your code...</p>
        </div>
      </Show>
      <Show when={stage() === 'success'}>
        <div class="success-state" style="text-align: left; padding: 1rem 0;">
          <div class="success-icon" style="display: inline-flex; align-items: center; justify-content: center; width: 32px; height: 32px; background: var(--success-color); color: white; border-radius: 50%; margin-bottom: 0.5rem;">✓</div>
          <p class="success-message" style="margin-bottom: 0.5rem;">Phone verified.</p>
        </div>
      </Show>
      <Show when={stage() === 'idle' || stage() === 'code_sent'}>
        <p class="description" style="margin-bottom: 0.5rem;">Verify a phone number to unlock prediction market participation.</p>
        <div class="form-group" style="margin-bottom: 1rem;">
          <input
            type="tel"
            class="form-input"
            style="width: 100%; box-sizing: border-box;"
            placeholder="+1 555 123 4567"
            value={phoneNumber()}
            onInput={(event) => setPhoneNumber(event.target.value)}
            disabled={stage() === 'code_sent' || stage() === 'verifying' || stage() === 'success'}
          />
        </div>
      </Show>

      <Show when={stage() === 'code_sent'}>
        <div class="code-section" style="margin-bottom: 1rem;">
          <input
            type="text"
            class="form-input"
            style="width: 100%; box-sizing: border-box; margin-bottom: 0.5rem;"
            placeholder="Verification code"
            value={code()}
            onInput={(event) => setCode(event.target.value)}
          />
          <button type="button" class="button button-primary" onClick={verifyCode}>
            Verify Code
          </button>
        </div>
      </Show>

      <Show when={stage() === 'idle'}>
        <button
          type="button"
          class="button button-primary"
          onClick={sendCode}
          disabled={stage() === 'sending' || stage() === 'verifying'}
        >
          Send Verification Code
        </button>
      </Show>

      <Show when={stage() === 'code_sent'}>
        <div style="display:flex; gap:0.6rem; align-items:center; margin-top:0.5rem">
          <button
            type="button"
            class="btn-link"
            style="padding: 0; margin: 0; border: none; background: none; color: var(--primary-color); cursor: pointer; text-decoration: underline;"
            onClick={sendCode}
          >
            Resend code
          </button>
        </div>
      </Show>

      <Show when={devCode()}>
        <p class="dev-code" style="margin-top: 0.5rem; font-size: 0.9em; color: var(--secondary-text);">Dev code: {devCode()}</p>
      </Show>
      <Show when={error()}>
        <p class="error-message" style="margin-top: 0.5rem;">{error()}</p>
      </Show>
    </section>
  );
}
