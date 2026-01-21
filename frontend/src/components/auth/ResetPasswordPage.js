import van from 'vanjs-core';
import { api } from '../../services/api';
import { clearToken } from '../../services/tokenService';

const { div, h1, form, label, input, button, p, a, ul, li } = van.tags;

const getTokenFromHash = () => {
  const hash = window.location.hash.slice(1);
  const query = hash.split('?')[1] || '';
  const params = new URLSearchParams(query);
  return params.get('token');
};

const clearLocalResetState = () => {
  clearToken();
  if (typeof indexedDB !== 'undefined') {
    try {
      indexedDB.deleteDatabase('intellacc_keystore');
    } catch (err) {
      console.warn('Failed to clear keystore database:', err);
    }
  }
};

const ResetPasswordPage = () => {
  const token = getTokenFromHash();
  const stage = van.state(token ? 'warning' : 'invalid');
  const error = van.state('');
  const acknowledged = van.state(false);
  const executeAfter = van.state(null);

  let passwordInputRef = null;
  let confirmInputRef = null;

  const handleContinue = () => {
    if (!acknowledged.val) {
      error.val = 'Please acknowledge the warning to continue.';
      return;
    }
    error.val = '';
    stage.val = 'form';
  };

  const handleSubmit = async (e) => {
    e.preventDefault();

    if (!token) {
      error.val = 'Reset token is missing.';
      stage.val = 'invalid';
      return;
    }

    if (!acknowledged.val) {
      error.val = 'Acknowledgment is required.';
      return;
    }

    const passwordValue = passwordInputRef?.value || '';
    const confirmValue = confirmInputRef?.value || '';

    if (passwordValue.length < 6) {
      error.val = 'Password must be at least 6 characters long.';
      return;
    }

    if (passwordValue !== confirmValue) {
      error.val = 'Passwords do not match.';
      return;
    }

    error.val = '';
    stage.val = 'resetting';

    try {
      const result = await api.auth.resetPassword(token, passwordValue, acknowledged.val, null);

      if (result?.status === 'pending') {
        executeAfter.val = result.executeAfter ? new Date(result.executeAfter) : null;
        stage.val = 'pending';
        return;
      }

      clearLocalResetState();
      stage.val = 'success';
    } catch (err) {
      error.val = err.message || 'Failed to reset password';
      stage.val = 'form';
    }
  };

  return div({ class: 'login-page' },
    div({ class: 'login-container' },
      h1('Reset Password'),
      () => error.val ? div({ class: 'error-message' }, error.val) : null,

      // Invalid token stage
      () => stage.val === 'invalid'
        ? div({ class: 'reset-note' },
            p('This reset link is invalid or missing.'),
            div({ class: 'auth-links' },
              a({ href: '#forgot-password' }, 'Request a new link')
            )
          )
        : null,

      // Warning stage
      () => stage.val === 'warning'
        ? div({ class: 'reset-warning' },
            p('WARNING: Resetting your password will permanently remove your access to encrypted data.'),
            p('By resetting, you will lose:'),
            ul(
              li('Encrypted messages in your conversations'),
              li('Your MLS keys and group memberships'),
              li('You will need to be re-invited to encrypted conversations')
            ),
            p('This cannot be undone. Your account and public posts remain intact.'),
            div({ class: 'reset-checkbox' },
              input({
                type: 'checkbox',
                id: 'acknowledge',
                checked: () => acknowledged.val,
                onchange: (e) => { acknowledged.val = e.target.checked; }
              }),
              label({ for: 'acknowledge' }, 'I understand and want to continue.')
            ),
            div({ class: 'form-actions' },
              button({ type: 'button', class: 'btn-primary', onclick: handleContinue }, 'Continue')
            ),
            div({ class: 'auth-links' },
              a({ href: '#login' }, 'Back to sign in')
            )
          )
        : null,

      // Reset form stage
      form({
        onsubmit: handleSubmit,
        style: () => `display: ${stage.val === 'form' ? 'block' : 'none'}`
      },
        div({ class: 'form-group' },
          label({ for: 'new-password' }, 'New password'),
          passwordInputRef = input({
            id: 'new-password',
            type: 'password',
            required: true,
            placeholder: 'Enter a new password'
          })
        ),
        div({ class: 'form-group' },
          label({ for: 'confirm-password' }, 'Confirm password'),
          confirmInputRef = input({
            id: 'confirm-password',
            type: 'password',
            required: true,
            placeholder: 'Re-enter your new password'
          })
        ),
        div({ class: 'reset-checkbox' },
          input({
            type: 'checkbox',
            id: 'acknowledge-again',
            checked: () => acknowledged.val,
            onchange: (e) => { acknowledged.val = e.target.checked; }
          }),
          label({ for: 'acknowledge-again' }, 'I understand the encrypted data will be removed.')
        ),
        div({ class: 'form-actions' },
          button({ type: 'submit', class: 'btn-primary' }, 'Reset password')
        )
      ),

      // Resetting stage
      () => stage.val === 'resetting'
        ? div({ class: 'reset-note' },
            p('Resetting your password...')
          )
        : null,

      // Pending stage
      () => stage.val === 'pending'
        ? div({ class: 'reset-note' },
            p('Your reset request is pending for security.'),
            () => executeAfter.val
              ? p(`It will complete after ${executeAfter.val.toLocaleString()}.`)
              : null,
            p('If this was not you, cancel from a logged-in device.'),
            div({ class: 'auth-links' },
              a({ href: '#login' }, 'Back to sign in')
            )
          )
        : null,

      // Success stage
      () => stage.val === 'success'
        ? div({ class: 'reset-note' },
            p('Password reset complete. Please sign in again.'),
            div({ class: 'auth-links' },
              a({ href: '#login' }, 'Go to sign in')
            )
          )
        : null
    )
  );
};

export default ResetPasswordPage;
