import van from 'vanjs-core';
import { api } from '../../services/api';

const { div, h1, form, label, input, button, p, a } = van.tags;

const ForgotPasswordPage = () => {
  const stage = van.state('form');
  const error = van.state('');
  let emailInputRef = null;
  const lastSubmitTime = van.state(0);

  const handleSubmit = async (e) => {
    e.preventDefault();

    if (stage.val === 'sending') {
      return;
    }

    const now = Date.now();
    if (now - lastSubmitTime.val < 3000) {
      return;
    }

    const emailValue = emailInputRef?.value?.trim();
    if (!emailValue) return;

    error.val = '';
    stage.val = 'sending';
    lastSubmitTime.val = now;

    try {
      await api.auth.requestPasswordReset(emailValue);
      stage.val = 'sent';
    } catch (err) {
      error.val = err.message || 'Failed to send reset email';
      stage.val = 'form';
    }
  };

  return div({ class: 'login-page' },
    div({ class: 'login-container' },
      h1('Reset Password'),
      p('Enter your email to receive a password reset link.'),
      () => error.val ? div({ class: 'error-message' }, error.val) : null,
      form({
        onsubmit: handleSubmit,
        style: () => `display: ${stage.val === 'form' || stage.val === 'sending' ? 'block' : 'none'}`
      },
        div({ class: 'form-group' },
          label({ for: 'email' }, 'Email'),
          emailInputRef = input({
            id: 'email',
            type: 'email',
            required: true,
            placeholder: 'Enter your email',
            autofocus: true,
            disabled: () => stage.val === 'sending'
          })
        ),
        div({ class: 'form-actions' },
          button({ type: 'submit', class: 'btn-primary', disabled: () => stage.val === 'sending' },
            () => stage.val === 'sending' ? 'Sending...' : 'Send reset link'
          )
        )
      ),
      () => stage.val === 'sent'
        ? div({ class: 'reset-note' },
            p('If an account exists for that email, a reset link has been sent.'),
            p('Check your inbox and spam folder.')
          )
        : null,
      div({ class: 'auth-links' },
        a({ href: '#login' }, 'Back to sign in')
      )
    )
  );
};

export default ForgotPasswordPage;
