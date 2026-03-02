/**
 * Phone Verification Component
 * Handles SMS verification flow
 */
import van from 'vanjs-core';
import api from '../../services/api.js';

const { div, h3, p, input, button, span } = van.tags;

export default function PhoneVerification({ onSuccess } = {}) {
  const stage = van.state('idle'); // idle | sending | code_sent | verifying | success
  const phoneNumber = van.state('');
  const code = van.state('');
  const error = van.state('');
  const devCode = van.state('');

  const sendCode = async () => {
    if (!phoneNumber.val.trim()) {
      error.val = 'Enter a phone number to continue';
      stage.val = 'idle';
      return;
    }

    stage.val = 'sending';
    error.val = '';
    devCode.val = '';

    try {
      const result = await api.verification.startPhoneVerification(phoneNumber.val.trim());
      stage.val = 'code_sent';
      code.val = '';
      if (result.dev_code) {
        devCode.val = result.dev_code;
      }
    } catch (err) {
      console.error('[PhoneVerification] Start error:', err);
      stage.val = 'idle';
      error.val = err.data?.error || err.message || 'Failed to send verification code';
    }
  };

  const confirmCode = async () => {
    if (!code.val.trim()) {
      error.val = 'Enter the verification code';
      stage.val = 'code_sent';
      return;
    }

    stage.val = 'verifying';
    error.val = '';

    try {
      await api.verification.confirmPhoneVerification(phoneNumber.val.trim(), code.val.trim());
      stage.val = 'success';
      if (onSuccess) onSuccess();
    } catch (err) {
      console.error('[PhoneVerification] Confirm error:', err);
      stage.val = 'code_sent';
      error.val = err.data?.error || err.message || 'Verification failed';
    }
  };

  return div({ class: 'phone-verification', style: 'text-align: left; padding: 1rem 0;' },
    div({ class: 'verification-icon', style: 'font-size: 2rem; margin-bottom: 0.5rem;' }, '📱'),
    h3({ style: 'margin-top: 0; margin-bottom: 0.5rem;' }, 'Verify Your Phone'),

    () => {
      if (stage.val === 'sending') {
        return div({ class: 'loading-state', style: 'text-align: left;' },
          div({ class: 'spinner', style: 'margin-bottom: 0.5rem;' }),
          p({ style: 'margin: 0;' }, 'Sending verification code...')
        );
      }

      if (stage.val === 'verifying') {
        return div({ class: 'loading-state', style: 'text-align: left;' },
          div({ class: 'spinner', style: 'margin-bottom: 0.5rem;' }),
          p({ style: 'margin: 0;' }, 'Verifying your code...')
        );
      }

      if (stage.val === 'success') {
        return div({ class: 'success-state', style: 'text-align: left; padding: 1rem 0;' },
          div({ class: 'success-icon', style: 'display: inline-flex; align-items: center; justify-content: center; width: 32px; height: 32px; background: var(--success-color); color: white; border-radius: 50%; margin-bottom: 0.5rem;' }, '✓'),
          p({ class: 'success-message', style: 'margin-bottom: 0.5rem;' }, 'Phone verified successfully!'),
          p({ class: 'instructions', style: 'margin-bottom: 0;' }, 'You now have access to prediction markets.')
        );
      }

      return div({ class: 'phone-form', style: 'text-align: left;' },
        p({ class: 'description', style: 'margin-bottom: 0.5rem;' },
          'Verify a phone number to unlock prediction markets. We only store a hashed version.'
        ),
        div({ class: 'form-group', style: 'margin-bottom: 1rem;' },
          input({
            type: 'tel',
            placeholder: '+1 555 123 4567',
            value: phoneNumber,
            oninput: (e) => phoneNumber.val = e.target.value,
            class: 'form-input',
            style: 'width: 100%; box-sizing: border-box;',
            autocomplete: 'tel',
            disabled: stage.val === 'code_sent' || stage.val === 'verifying' || stage.val === 'success'
          })
        ),
        stage.val === 'code_sent' ? div({ class: 'code-section', style: 'margin-bottom: 1rem;' },
          input({
            type: 'text',
            placeholder: 'Verification code',
            value: code,
            oninput: (e) => code.val = e.target.value,
            class: 'form-input',
            style: 'width: 100%; box-sizing: border-box; margin-bottom: 0.5rem;',
            inputmode: 'numeric',
            autocomplete: 'one-time-code'
          }),
          button({
            type: 'button',
            class: 'button button-primary',
            onclick: confirmCode
          }, 'Verify Code')
        ) : button({
          type: 'button',
          class: 'button button-primary',
          onclick: sendCode,
          disabled: stage.val === 'sending' || stage.val === 'verifying'
        }, 'Send Verification Code'),
        () => devCode.val ? p({ class: 'dev-code', style: 'margin-top: 0.5rem; font-size: 0.9em; color: var(--secondary-text);' }, `Dev code: ${devCode.val}`) : null,
        () => error.val ? p({ class: 'error-message', style: 'margin-top: 0.5rem;' }, error.val) : null,
        () => stage.val === 'code_sent' ? button({
          type: 'button',
          class: 'btn-link resend-link',
          style: 'padding: 0; margin-top: 0.5rem; border: none; background: none; color: var(--primary-color); cursor: pointer; text-decoration: underline;',
          onclick: sendCode
        }, 'Resend code') : null
      );
    }
  );
}
