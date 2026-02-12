// src/components/auth/SignUpForm.js
import van from 'vanjs-core';
const { div, h1, form, label, input, button, p, a } = van.tags;
import auth from '../../services/auth';

/**
 * Sign up form component.
 * Uses direct input refs on submit so browser autofill/password-manager writes
 * are always captured, even when input events are not emitted.
 */
const SignUpForm = () => {
  const submitting = van.state(false);
  const error = van.state('');
  const validationErrors = van.state({});

  let usernameInputRef = null;
  let emailInputRef = null;
  let passwordInputRef = null;
  let confirmPasswordInputRef = null;

  const clearFieldValidationError = (fieldName) => {
    if (!validationErrors.val[fieldName]) return;
    const errors = { ...validationErrors.val };
    delete errors[fieldName];
    validationErrors.val = errors;
  };

  const validateForm = ({ username, email, password, confirmPassword }) => {
    const errors = {};

    if (!username) {
      errors.username = 'Username is required';
    } else if (username.length < 3) {
      errors.username = 'Username must be at least 3 characters';
    }

    if (!email) {
      errors.email = 'Email is required';
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      errors.email = 'Please enter a valid email address';
    }

    if (!password) {
      errors.password = 'Password is required';
    } else if (password.length < 6) {
      errors.password = 'Password must be at least 6 characters';
    }

    if (!confirmPassword) {
      errors.confirmPassword = 'Please confirm your password';
    } else if (password !== confirmPassword) {
      errors.confirmPassword = 'Passwords do not match';
    }

    validationErrors.val = errors;
    return Object.keys(errors).length === 0;
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (submitting.val) return;

    const username = (usernameInputRef?.value || '').trim();
    const email = (emailInputRef?.value || '').trim();
    const password = passwordInputRef?.value || '';
    const confirmPassword = confirmPasswordInputRef?.value || '';

    error.val = '';

    if (!validateForm({ username, email, password, confirmPassword })) {
      return;
    }

    submitting.val = true;

    try {
      const result = await auth.register(username, email, password);
      if (!result.success) {
        error.val = result.error || 'Registration failed';
      }
    } catch (err) {
      console.error('Registration error:', err);
      error.val = err.message || 'Registration failed';
    } finally {
      submitting.val = false;
    }
  };

  return div({ class: 'signup-page' },
    div({ class: 'signup-container' }, [
      h1('Create Account'),

      () => error.val ?
        div({ class: 'error-message' }, error.val) : null,

      form({ onsubmit: handleSubmit, autocomplete: 'on' }, [
        div({ class: 'form-group' }, [
          label({ for: 'signup-username' }, 'Username'),
          usernameInputRef = input({
            id: 'signup-username',
            name: 'username',
            type: 'text',
            oninput: () => clearFieldValidationError('username'),
            disabled: () => submitting.val,
            required: true,
            placeholder: 'Choose a username',
            autocomplete: 'username',
            autocapitalize: 'off',
            spellcheck: 'false'
          }),
          () => validationErrors.val.username ?
            div({ class: 'field-error' }, validationErrors.val.username) : null
        ]),

        div({ class: 'form-group' }, [
          label({ for: 'signup-email' }, 'Email'),
          emailInputRef = input({
            id: 'signup-email',
            name: 'email',
            type: 'email',
            oninput: () => clearFieldValidationError('email'),
            disabled: () => submitting.val,
            required: true,
            placeholder: 'Enter your email',
            autocomplete: 'email',
            inputmode: 'email',
            autocapitalize: 'off',
            spellcheck: 'false'
          }),
          () => validationErrors.val.email ?
            div({ class: 'field-error' }, validationErrors.val.email) : null
        ]),

        div({ class: 'form-group' }, [
          label({ for: 'signup-password' }, 'Password'),
          passwordInputRef = input({
            id: 'signup-password',
            name: 'password',
            type: 'password',
            oninput: () => clearFieldValidationError('password'),
            disabled: () => submitting.val,
            required: true,
            placeholder: 'Choose a password',
            autocomplete: 'new-password'
          }),
          () => validationErrors.val.password ?
            div({ class: 'field-error' }, validationErrors.val.password) : null
        ]),

        div({ class: 'form-group' }, [
          label({ for: 'signup-confirm-password' }, 'Confirm Password'),
          confirmPasswordInputRef = input({
            id: 'signup-confirm-password',
            name: 'confirmPassword',
            type: 'password',
            oninput: () => clearFieldValidationError('confirmPassword'),
            disabled: () => submitting.val,
            required: true,
            placeholder: 'Confirm your password',
            autocomplete: 'new-password'
          }),
          () => validationErrors.val.confirmPassword ?
            div({ class: 'field-error' }, validationErrors.val.confirmPassword) : null
        ]),

        div({ class: 'form-actions' }, [
          button({
            type: 'submit',
            disabled: () => submitting.val,
            class: 'btn-primary'
          }, () => submitting.val ? 'Creating Account...' : 'Create Account'),

          p({ class: 'login-link' }, [
            'Already have an account? ',
            a({ href: '#login' }, 'Sign in here')
          ])
        ])
      ])
    ])
  );
};

export default SignUpForm;
