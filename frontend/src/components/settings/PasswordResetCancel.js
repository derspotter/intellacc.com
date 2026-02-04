import van from 'vanjs-core';
import { api } from '../../services/api';

const { div, h3, p, button, span } = van.tags;

export default function PasswordResetCancel() {
  const status = van.state('');
  const error = van.state('');
  const isSubmitting = van.state(false);

  const handleCancel = async () => {
    error.val = '';
    status.val = '';
    isSubmitting.val = true;
    try {
      const result = await api.auth.cancelPasswordReset();
      if (result?.cancelled) {
        status.val = 'Pending password reset cancelled.';
      } else {
        status.val = 'No pending password reset found.';
      }
    } catch (err) {
      error.val = err.message || 'Failed to cancel password reset.';
    } finally {
      isSubmitting.val = false;
    }
  };

  return div({ class: 'settings-section password-reset-cancel' },
    h3({ class: 'settings-section-title' },
      span({ class: 'section-icon' }, '🔐'),
      'Password Reset'
    ),
    p('If you requested a password reset and still have access to this device, you can cancel it here.'),
    button({
      class: 'button button-secondary',
      onclick: handleCancel,
      disabled: () => isSubmitting.val
    }, () => isSubmitting.val ? 'Cancelling...' : 'Cancel pending reset'),
    p({
      class: 'success-message',
      style: () => status.val ? '' : 'display: none;'
    }, () => status.val),
    p({
      class: 'error-message',
      style: () => error.val ? '' : 'display: none;'
    }, () => error.val)
  );
}
