import {
  createEffect,
  createSignal,
  Show
} from 'solid-js';
import { confirmEmailVerification } from '../services/api';

const parseTokenFromHash = () => {
  if (typeof window === 'undefined') {
    return null;
  }

  const tokenMatch = window.location.hash.match(/[?&]token=([^&]+)/);
  if (!tokenMatch) {
    return null;
  }

  try {
    return decodeURIComponent(tokenMatch[1]);
  } catch (error) {
    console.warn('[VerifyEmail] Failed to decode token:', error);
    return tokenMatch[1];
  }
};

export default function VerifyEmailPage() {
  const [status, setStatus] = createSignal('verifying');
  const [message, setMessage] = createSignal('');

  const runVerification = async () => {
    const token = parseTokenFromHash();
    if (!token) {
      setStatus('error');
      setMessage('No verification token found. Use the link from your email.');
      return;
    }

    try {
      await confirmEmailVerification(token);
      setStatus('success');
      setMessage('Your email has been verified.');
    } catch (error) {
      setStatus('error');
      setMessage(error?.data?.message || error?.message || 'Email verification failed.');
    }
  };

  createEffect(() => {
    runVerification();
  });

  return (
    <section class="verify-email-page">
      <div class="verify-card">
        <Show when={status() === 'verifying'}>
          <h1>Verifying email</h1>
          <p>Checking your verification token. Please wait…</p>
        </Show>

        <Show when={status() === 'success'}>
          <h1>Email verified</h1>
          <p class="success">{message()}</p>
          <div class="auth-links">
            <a href="#login">Go to login</a>
            <a href="#home">Go to home</a>
          </div>
        </Show>

        <Show when={status() === 'error'}>
          <h1>Verification failed</h1>
          <p class="error-message">{message()}</p>
          <div class="auth-links">
            <a href="#home">Go to home</a>
            <a href="#settings">Open settings</a>
          </div>
        </Show>
      </div>
    </section>
  );
}
