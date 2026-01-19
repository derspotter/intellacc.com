// src/components/auth/LoginForm.js
// Staged Login Flow: Email -> Device Verification (if needed) -> Password
// This eliminates the need to store passwords in memory during device approval.

import van from 'vanjs-core';
import PasskeyButton from './PasskeyButton';
const { div, h1, h2, form, label, input, button, p, a, span } = van.tags;
import auth from '../../services/auth';
import { api } from '../../services/api';

// Preload WASM module in background while user types credentials
let wasmPreloaded = false;
function preloadWasm() {
  if (wasmPreloaded) return;
  wasmPreloaded = true;
  import('openmls-wasm').catch(() => {});
}

// Get device fingerprint from localStorage
function getDeviceFingerprint() {
  return localStorage.getItem('device_public_id') || localStorage.getItem('device_id') || null;
}

/**
 * Staged Login Form Component
 * Flow: Email -> Device Check -> Verification (if needed) -> Password
 *
 * IMPORTANT: All form elements are created ONCE and shown/hidden via CSS.
 * This prevents VanJS from recreating input elements and losing focus.
 */
const LoginForm = () => {
  preloadWasm();

  // Stage: 'email' | 'checking' | 'verification' | 'password' | 'logging_in'
  const stage = van.state('email');
  const error = van.state('');

  // Session state for device verification
  const sessionToken = van.state(null);
  const verificationCode = van.state('');
  const expiresAt = van.state(null);

  // Store email for display (not bound to input)
  const emailDisplay = van.state('');

  // Polling interval reference
  let pollInterval = null;

  // Input refs - we'll read values directly from DOM
  let emailInputRef = null;
  let passwordInputRef = null;

  // Cleanup polling on component unmount
  const cleanupPolling = () => {
    if (pollInterval) {
      clearInterval(pollInterval);
      pollInterval = null;
    }
  };

  // Stage 1: Email submission
  const handleEmailSubmit = async (e) => {
    e.preventDefault();
    const emailValue = emailInputRef.value.trim();
    if (!emailValue) return;

    error.val = '';
    emailDisplay.val = emailValue;
    stage.val = 'checking';

    try {
      const deviceFingerprint = getDeviceFingerprint();
      const result = await api.auth.checkDeviceStatus(emailValue, deviceFingerprint);
      sessionToken.val = result.sessionToken;

      if (result.requiresVerification) {
        // Start device linking
        const linkResult = await api.auth.startPreLoginLink(
          result.sessionToken,
          emailValue,
          deviceFingerprint
        );
        verificationCode.val = linkResult.verificationCode;
        expiresAt.val = new Date(linkResult.expiresAt);
        stage.val = 'verification';
        startPolling();
      } else {
        // Device already verified, go straight to password
        stage.val = 'password';
        setTimeout(() => passwordInputRef?.focus(), 50);
      }
    } catch (err) {
      error.val = err.message || 'Failed to check device status';
      stage.val = 'email';
    }
  };

  // Stage 2: Poll for verification approval
  const startPolling = () => {
    cleanupPolling();
    pollInterval = setInterval(async () => {
      try {
        const status = await api.auth.getPreLoginLinkStatus(sessionToken.val);

        if (status.status === 'approved') {
          cleanupPolling();
          if (status.devicePublicId) {
            localStorage.setItem('device_public_id', status.devicePublicId);
          }
          stage.val = 'password';
          setTimeout(() => passwordInputRef?.focus(), 50);
        } else if (status.status === 'expired' || status.status === 'not_found') {
          cleanupPolling();
          error.val = 'Verification expired. Please try again.';
          stage.val = 'email';
        }
      } catch (err) {
        console.error('[LoginForm] Polling error:', err);
      }
    }, 2000);

    // Auto-cleanup after expiry
    setTimeout(() => {
      if (stage.val === 'verification') {
        cleanupPolling();
        error.val = 'Verification timed out. Please try again.';
        stage.val = 'email';
      }
    }, 5 * 60 * 1000 + 10000);
  };

  // Stage 3: Password submission
  const handlePasswordSubmit = async (e) => {
    e.preventDefault();
    const passwordValue = passwordInputRef.value;
    if (!passwordValue) return;

    error.val = '';
    stage.val = 'logging_in';

    try {
      const result = await auth.login(emailDisplay.val, passwordValue);

      if (result.success) {
        window.location.hash = '#';
      } else {
        error.val = result.error || 'Login failed';
        stage.val = 'password';
      }
    } catch (err) {
      error.val = err.message || 'Login failed';
      stage.val = 'password';
    }
  };

  // Cancel verification / go back
  const handleCancel = () => {
    cleanupPolling();
    error.val = '';
    if (passwordInputRef) passwordInputRef.value = '';
    stage.val = 'email';
    setTimeout(() => emailInputRef?.focus(), 50);
  };

  // Helper to show/hide based on stage
  const showWhen = (...stages) => () =>
    stages.includes(stage.val) ? 'block' : 'none';

  const showWhenFlex = (...stages) => () =>
    stages.includes(stage.val) ? 'flex' : 'none';

  // Build all forms ONCE - show/hide with CSS
  return div({ class: 'login-page' },
    div({ class: 'login-container' },
      h1('Sign In'),

      // Error message (reactive)
      () => error.val ? div({ class: 'error-message' }, error.val) : null,

      // === EMAIL STAGE ===
      form({
        onsubmit: handleEmailSubmit,
        style: () => `display: ${stage.val === 'email' ? 'block' : 'none'}`
      },
        div({ class: 'form-group' },
          label({ for: 'email' }, 'Email'),
          emailInputRef = input({
            id: 'email',
            type: 'email',
            required: true,
            placeholder: 'Enter your email',
            autofocus: true
          })
        ),
        div({ class: 'form-actions' },
          button({ type: 'submit', class: 'btn-primary' }, 'Continue'),
          div({ style: 'width: 100%; margin-top: 1rem;' },
            PasskeyButton({
              email: { val: '' }, // PasskeyButton will read from its own input
              onSuccess: () => window.location.hash = '#',
              onError: (err) => { error.val = err.message || 'Passkey login failed'; }
            })
          ),
          p({ class: 'register-link' },
            "Don't have an account? ",
            a({ href: '#signup' }, 'Register here')
          )
        )
      ),

      // === CHECKING STAGE ===
      div({
        class: 'verification-stage',
        style: () => `display: ${stage.val === 'checking' ? 'block' : 'none'}`
      },
        div({ class: 'loading-spinner' }),
        p('Checking device status...')
      ),

      // === VERIFICATION STAGE ===
      div({
        class: 'verification-stage',
        style: () => `display: ${stage.val === 'verification' ? 'block' : 'none'}`
      },
        h2('Verify this device'),
        p('Enter this code on a device that is already logged in:'),
        div({ class: 'verification-code-display' }, () => verificationCode.val),
        p({ class: 'verification-hint' },
          'Go to Settings ',
          span({ class: 'arrow' }, '\u2192'),
          ' Devices ',
          span({ class: 'arrow' }, '\u2192'),
          ' Approve New Device'
        ),
        () => expiresAt.val ? p({ class: 'verification-expires' },
          `Code expires at ${expiresAt.val.toLocaleTimeString()}`
        ) : null,
        div({ class: 'form-actions' },
          button({
            type: 'button',
            class: 'btn-secondary',
            onclick: handleCancel
          }, 'Cancel')
        )
      ),

      // === PASSWORD STAGE ===
      form({
        onsubmit: handlePasswordSubmit,
        style: () => `display: ${stage.val === 'password' ? 'block' : 'none'}`
      },
        div({ class: 'email-display' },
          span({ class: 'email-label' }, 'Logging in as: '),
          span({ class: 'email-value' }, () => emailDisplay.val)
        ),
        div({ class: 'form-group' },
          label({ for: 'password' }, 'Password'),
          passwordInputRef = input({
            id: 'password',
            type: 'password',
            required: true,
            placeholder: 'Enter your password'
          })
        ),
        div({ class: 'form-actions' },
          button({ type: 'submit', class: 'btn-primary' }, 'Sign In'),
          button({
            type: 'button',
            class: 'btn-link',
            onclick: handleCancel
          }, 'Use a different email')
        ),
        div({ class: 'auth-links' },
          a({ href: '#forgot-password' }, 'Forgot password?')
        )
      ),

      // === LOGGING IN STAGE ===
      div({
        class: 'verification-stage',
        style: () => `display: ${stage.val === 'logging_in' ? 'block' : 'none'}`
      },
        div({ class: 'loading-spinner' }),
        p('Signing in...')
      )
    )
  );
};

export default LoginForm;
