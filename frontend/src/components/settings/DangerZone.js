import van from 'vanjs-core';
import api from '../../services/api.js';
import { clearToken } from '../../services/tokenService.js';

const { div, h3, p, input, button } = van.tags;

export default function DangerZone() {
  const password = van.state('');
  const confirmText = van.state('');
  const isSubmitting = van.state(false);
  const error = van.state('');

  const handleDelete = async () => {
    if (!password.val) {
      error.val = 'Password is required.';
      return;
    }
    if (confirmText.val.trim() !== 'DELETE') {
      error.val = 'Type DELETE to confirm.';
      return;
    }

    isSubmitting.val = true;
    error.val = '';

    try {
      await api.users.deleteAccount(password.val);
      clearToken();
      window.location.hash = 'login';
      window.location.reload();
    } catch (err) {
      error.val = err?.message || 'Failed to delete account';
    } finally {
      isSubmitting.val = false;
    }
  };

  return div({ class: 'danger-zone' }, [
    h3('Danger Zone'),
    p('Delete your account. This cannot be undone. Your profile will be anonymized and access revoked immediately.'),
    div({ class: 'form-group' }, [
      input({
        type: 'password',
        placeholder: 'Confirm your password',
        value: password,
        oninput: (e) => { password.val = e.target.value; },
        disabled: isSubmitting
      })
    ]),
    div({ class: 'form-group' }, [
      input({
        type: 'text',
        placeholder: 'Type DELETE to confirm',
        value: confirmText,
        oninput: (e) => { confirmText.val = e.target.value; },
        disabled: isSubmitting
      })
    ]),
    () => error.val ? div({ class: 'error-message' }, error.val) : null,
    button({
      class: 'button button-danger',
      onclick: handleDelete,
      disabled: () => isSubmitting.val
    }, () => isSubmitting.val ? 'Deleting…' : 'Delete Account')
  ]);
}
