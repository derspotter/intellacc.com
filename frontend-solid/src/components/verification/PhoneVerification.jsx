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
    <section class="phone-verification">
      <div class="verification-icon">📞</div>
      <h3>Verify your phone</h3>
      <Show when={stage() === 'sending'}>
        <div class="loading-state">
          <div class="spinner" />
          <p>Sending verification code...</p>
        </div>
      </Show>
      <Show when={stage() === 'verifying'}>
        <div class="loading-state">
          <div class="spinner" />
          <p>Verifying your code...</p>
        </div>
      </Show>
      <Show when={stage() === 'success'}>
        <div class="success-state">
          <div class="success-icon">✓</div>
          <p class="success-message">Phone verified.</p>
        </div>
      </Show>
      <Show when={stage() === 'idle' || stage() === 'code_sent'}>
        <p class="description">Verify a phone number to unlock prediction market participation.</p>
        <div class="form-group">
          <input
            type="tel"
            class="form-input"
            placeholder="+1 555 123 4567"
            value={phoneNumber()}
            onInput={(event) => setPhoneNumber(event.target.value)}
            disabled={stage() === 'code_sent' || stage() === 'verifying' || stage() === 'success'}
          />
        </div>
      </Show>

      <Show when={stage() === 'code_sent'}>
        <div class="code-section">
          <input
            type="text"
            class="form-input"
            placeholder="Verification code"
            value={code()}
            onInput={(event) => setCode(event.target.value)}
          />
          <button type="button" class="btn btn-primary" onClick={verifyCode}>
            Verify Code
          </button>
        </div>
      </Show>

      <Show when={stage() === 'idle'}>
        <button
          type="button"
          class="btn btn-primary"
          onClick={sendCode}
          disabled={stage() === 'sending' || stage() === 'verifying'}
        >
          Send Verification Code
        </button>
      </Show>

      <Show when={stage() === 'code_sent'}>
        <div style="display:flex; gap:0.6rem; align-items:center; margin-top:0.4rem">
          <button
            type="button"
            class="btn-link"
            onClick={sendCode}
          >
            Resend code
          </button>
        </div>
      </Show>

      <Show when={devCode()}>
        <p class="dev-code">Dev code: {devCode()}</p>
      </Show>
      <Show when={error()}>
        <p class="error-message">{error()}</p>
      </Show>
    </section>
  );
}
