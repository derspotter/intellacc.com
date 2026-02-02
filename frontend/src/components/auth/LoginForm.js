// src/components/auth/LoginForm.js
// Login Flow: Email + Password

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

  // Stage: 'idle' | 'logging_in'
  const stage = van.state('idle');
  const error = van.state('');

  // Input refs - we'll read values directly from DOM
  let emailInputRef = null;
  let passwordInputRef = null;

  const handleSubmit = async (e) => {
    e.preventDefault();
    const emailValue = emailInputRef.value.trim();
    const passwordValue = passwordInputRef.value;
    if (!emailValue || !passwordValue) return;

    error.val = '';
    stage.val = 'logging_in';

    try {
      const result = await auth.login(emailValue, passwordValue);

      if (result.success) {
        window.location.hash = '#';
      } else {
        error.val = result.error || 'Login failed';
        stage.val = 'idle';
      }
    } catch (err) {
      error.val = err.message || 'Login failed';
      stage.val = 'idle';
    }
  };

  // Build form once - show/hide with CSS
  return div({ class: 'login-page' },
    div({ class: 'login-container' },
      h1('Sign In'),

      // Error message (reactive)
      () => error.val ? div({ class: 'error-message' }, error.val) : null,

      // === LOGIN FORM ===
      form({
        onsubmit: handleSubmit,
        style: () => `display: ${stage.val === 'logging_in' ? 'none' : 'block'}`
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
