// src/components/auth/LoginForm.js
// Login Flow: Email -> Password

import van from 'vanjs-core';
import PasskeyButton from './PasskeyButton';
const { div, h1, form, label, input, button, p, a, span } = van.tags;
import auth from '../../services/auth';

// Preload WASM module in background while user types credentials
let wasmPreloaded = false;
function preloadWasm() {
  if (wasmPreloaded) return;
  wasmPreloaded = true;
  import('openmls-wasm').catch(() => {});
}


/**
 * Login Form Component
 * Flow: Email -> Password
 *
 * IMPORTANT: All form elements are created ONCE and shown/hidden via CSS.
 * This prevents VanJS from recreating input elements and losing focus.
 */
const LoginForm = () => {
  preloadWasm();

  // Stage: 'email' | 'password' | 'logging_in'
  const stage = van.state('email');
  const error = van.state('');

  // Store email for display (not bound to input)
  const emailDisplay = van.state('');

  // Input refs - we'll read values directly from DOM
  let emailInputRef = null;
  let passwordInputRef = null;

  // Stage 1: Email submission
  const handleEmailSubmit = async (e) => {
    e.preventDefault();
    const emailValue = emailInputRef.value.trim();
    if (!emailValue) return;

    error.val = '';
    emailDisplay.val = emailValue;
    stage.val = 'password';
    setTimeout(() => passwordInputRef?.focus(), 50);
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

  // Cancel / go back
  const handleCancel = () => {
    error.val = '';
    if (passwordInputRef) passwordInputRef.value = '';
    stage.val = 'email';
    setTimeout(() => emailInputRef?.focus(), 50);
  };

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
