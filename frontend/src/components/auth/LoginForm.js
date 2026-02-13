// src/components/auth/LoginForm.js
// Login Flow: Email + Password + Social OAuth

import van from 'vanjs-core';
import PasskeyButton from './PasskeyButton';
const { div, h1, form, label, input, button, p, a } = van.tags;
import auth from '../../services/auth';

// Preload WASM module in background while user types credentials
let wasmPreloaded = false;
function preloadWasm() {
  if (wasmPreloaded) return;
  wasmPreloaded = true;
  import('openmls-wasm').catch(() => {});
}

const getLoginHashParams = () => {
  const hash = String(window.location.hash || '').replace(/^#/, '');
  const [page, queryString = ''] = hash.split('?');
  if (page !== 'login') {
    return new URLSearchParams();
  }
  return new URLSearchParams(queryString);
};

/**
 * Login Form Component
 *
 * IMPORTANT: All form elements are created ONCE and shown/hidden via CSS.
 * This prevents VanJS from recreating input elements and losing focus.
 */
const LoginForm = () => {
  preloadWasm();

  // Stage: 'idle' | 'logging_in'
  const stage = van.state('idle');
  const error = van.state('');

  // Input refs - values are read directly from DOM
  let emailInputRef = null;
  let passwordInputRef = null;
  let blueskyInputRef = null;
  let mastodonInputRef = null;
  let socialCallbackHandled = false;

  const handleSubmit = async (e) => {
    e.preventDefault();
    const emailValue = emailInputRef.value.trim();
    const passwordValue = passwordInputRef.value;
    if (!emailValue || !passwordValue) return;

    error.val = '';
    stage.val = 'logging_in';

    try {
      const result = await auth.login(emailValue, passwordValue);

      if (!result.success) {
        error.val = result.error || 'Login failed';
        stage.val = 'idle';
      }
    } catch (err) {
      error.val = err.message || 'Login failed';
      stage.val = 'idle';
    }
  };

  const startAtproto = async () => {
    const identifier = String(blueskyInputRef?.value || '').trim();
    if (!identifier) {
      error.val = 'Enter your Bluesky handle (for example: you.bsky.social)';
      return;
    }

    error.val = '';
    stage.val = 'logging_in';

    const result = await auth.startAtprotoLogin(identifier);
    if (!result.success) {
      error.val = result.error || 'Unable to start Bluesky login';
      stage.val = 'idle';
    }
  };

  const startMastodon = async () => {
    const instance = String(mastodonInputRef?.value || '').trim();
    if (!instance) {
      error.val = 'Enter your Mastodon instance (for example: mastodon.social)';
      return;
    }

    error.val = '';
    stage.val = 'logging_in';

    const result = await auth.startMastodonLogin(instance);
    if (!result.success) {
      error.val = result.error || 'Unable to start Mastodon login';
      stage.val = 'idle';
    }
  };

  const maybeHandleSocialCallback = async () => {
    if (socialCallbackHandled) return;

    const params = getLoginHashParams();
    const socialToken = String(params.get('socialToken') || '').trim();
    if (!socialToken) return;

    socialCallbackHandled = true;
    error.val = '';
    stage.val = 'logging_in';

    const result = await auth.completeSocialLogin(socialToken);
    if (!result.success) {
      error.val = result.error || 'Social login failed';
      stage.val = 'idle';
      socialCallbackHandled = false;
      window.location.hash = 'login';
    }
  };

  // Run once after render to support backend redirect callback.
  setTimeout(() => {
    maybeHandleSocialCallback().catch((err) => {
      error.val = err.message || 'Social login failed';
      stage.val = 'idle';
    });
  }, 0);

  // Build form once - show/hide with CSS
  return div({ class: 'login-page' },
    div({ class: 'login-container' },
      h1('Sign In'),

      () => error.val ? div({ class: 'error-message' }, error.val) : null,

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
              email: { val: '' },
              onSuccess: null,
              onError: (err) => { error.val = err.message || 'Passkey login failed'; }
            })
          ),
          div({ class: 'social-auth-section' },
            p({ class: 'social-auth-title' }, 'or continue with'),
            div({ class: 'social-auth-provider' },
              label({ for: 'bluesky-identifier' }, 'Bluesky handle'),
              blueskyInputRef = input({
                id: 'bluesky-identifier',
                type: 'text',
                placeholder: 'you.bsky.social'
              }),
              button({
                type: 'button',
                class: 'button social-auth-button',
                onclick: startAtproto
              }, 'Continue with Bluesky')
            ),
            div({ class: 'social-auth-provider' },
              label({ for: 'mastodon-instance' }, 'Mastodon instance'),
              mastodonInputRef = input({
                id: 'mastodon-instance',
                type: 'text',
                placeholder: 'mastodon.social'
              }),
              button({
                type: 'button',
                class: 'button social-auth-button',
                onclick: startMastodon
              }, 'Continue with Mastodon')
            )
          ),
        ),
        div({ class: 'auth-links' },
          a({ href: '#forgot-password' }, 'Forgot password?')
        )
      ),

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
