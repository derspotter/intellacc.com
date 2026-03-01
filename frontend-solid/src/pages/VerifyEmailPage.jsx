import { createEffect, createSignal, Show } from 'solid-js';
import { confirmEmailVerification } from '../services/api';

const parseTokenFromHash = () => {
  const hash = window.location.hash;
  const match = hash.match(/[?&]token=([^&]+)/);
  if (!match) {
    return null;
  }

  try {
    return decodeURIComponent(match[1]);
  } catch (error) {
    console.warn('[VerifyEmail] Failed to decode token:', error);
    return match[1];
  }
};

export default function VerifyEmailPage() {
  const [status, setStatus] = createSignal('verifying');
  const [message, setMessage] = createSignal('');

  const verifyEmail = async () => {
    const token = parseTokenFromHash();
    if (!token) {
      setStatus('error');
      setMessage('No verification token found. Use the link from your email.');
      return;
    }

    try {
      await confirmEmailVerification(token);
      setStatus('success');
      setMessage('Your email has been verified successfully.');
    } catch (error) {
      setStatus('error');
      setMessage(error?.data?.message || error?.message || 'Email verification failed');
    }
  };

  createEffect(() => {
    verifyEmail();
  });

  return (
    <section class="verify-email-page">
      <div class="verification-card">
        <Show when={status() === 'verifying'}>
          <div class="verifying-state">
            <div class="spinner large" />
            <h2>Verifying your email...</h2>
            <p>Please wait while we confirm your email address.</p>
          </div>
        </Show>

        <Show when={status() === 'success'}>
          <div class="success-state">
            <div class="success-icon large">✓</div>
            <h1>Email Verified!</h1>
            <p class="success-message">{message()}</p>
            <div class="actions">
              <a href="#home" class="btn btn-primary">
                Go to Home
              </a>
              <a href="#settings" class="btn btn-secondary">
                View Settings
              </a>
            </div>
          </div>
        </Show>

        <Show when={status() === 'error'}>
          <div class="error-state">
            <div class="error-icon large">✗</div>
            <h1>Verification Failed</h1>
            <p class="error-message">{message() || 'No verification token found. Please use the link from your email.'}</p>
            <div class="error-help">
              <p>This can happen if:</p>
              <div class="error-reasons">
                <p>• The link has expired (links are valid for 24 hours)</p>
                <p>• The link was already used</p>
                <p>• The link was copied incorrectly</p>
              </div>
            </div>
            <div class="actions">
              <a href="#settings/verification" class="btn btn-primary">
                Request New Link
              </a>
              <a href="#home" class="btn btn-secondary">
                Go to Home
              </a>
            </div>
          </div>
        </Show>
      </div>
    </section>
  );
}
