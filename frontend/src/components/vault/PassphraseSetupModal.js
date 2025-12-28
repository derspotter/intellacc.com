// frontend/src/components/vault/PassphraseSetupModal.js
// Modal for first-time vault passphrase setup

import van from 'vanjs-core';
import vaultStore from '../../stores/vaultStore.js';
import vaultService from '../../services/vaultService.js';

const { div, h2, p, form, input, button, label, span, ul, li } = van.tags;

/**
 * Modal for setting up the vault passphrase for the first time
 */
export default function PassphraseSetupModal() {
    const passphrase = van.state('');
    const confirmPassphrase = van.state('');
    const loading = van.state(false);
    const showPassword = van.state(false);

    // Bridge VanX store to VanJS reactivity
    const showModal = van.derive(() => vaultStore.showSetupModal);
    const setupError = van.derive(() => vaultStore.setupError);

    // Password strength indicators
    const hasMinLength = van.derive(() => passphrase.val.length >= 8);
    const hasUppercase = van.derive(() => /[A-Z]/.test(passphrase.val));
    const hasLowercase = van.derive(() => /[a-z]/.test(passphrase.val));
    const hasNumber = van.derive(() => /[0-9]/.test(passphrase.val));
    const passwordsMatch = van.derive(() =>
        passphrase.val && confirmPassphrase.val && passphrase.val === confirmPassphrase.val
    );
    const isStrong = van.derive(() =>
        hasMinLength.val && hasUppercase.val && hasLowercase.val && hasNumber.val
    );

    const handleSubmit = async (e) => {
        e.preventDefault();
        if (loading.val) return;

        if (!isStrong.val) {
            vaultStore.setSetupError('Please use a stronger passphrase');
            return;
        }

        if (!passwordsMatch.val) {
            vaultStore.setSetupError('Passphrases do not match');
            return;
        }

        loading.val = true;
        vaultStore.setSetupError('');

        try {
            await vaultService.setupVault(passphrase.val);
            passphrase.val = '';
            confirmPassphrase.val = '';
        } catch (error) {
            console.error('[PassphraseSetup] Setup failed:', error);
            vaultStore.setSetupError(error.message || 'Failed to set up vault');
        } finally {
            loading.val = false;
        }
    };

    const toggleShowPassword = () => {
        showPassword.val = !showPassword.val;
    };

    return () => {
        if (!showModal.val) return div({ class: 'setup-modal-wrapper' });

        return div({ class: 'vault-modal-overlay' },
            div({ class: 'vault-modal vault-modal-setup' },
                div({ class: 'vault-modal-header' },
                    span({ class: 'vault-icon' }, '\uD83D\uDD10'),
                    h2('Secure Your Messages')
                ),
                p({ class: 'vault-modal-description' },
                    'Create a passphrase to encrypt your messages. This protects your data if someone accesses your device.'
                ),
                div({ class: 'vault-warning' },
                    span({ class: 'warning-icon' }, '\u26A0\uFE0F'),
                    span('Remember this passphrase! It cannot be recovered if lost.')
                ),
                form({ class: 'vault-form', onsubmit: handleSubmit },
                    div({ class: 'form-group' },
                        label({ for: 'setup-passphrase' }, 'Passphrase'),
                        div({ class: 'password-input-wrapper' },
                            input({
                                type: () => showPassword.val ? 'text' : 'password',
                                id: 'setup-passphrase',
                                value: passphrase,
                                oninput: (e) => { passphrase.val = e.target.value; },
                                placeholder: 'Create a strong passphrase',
                                required: true,
                                disabled: () => loading.val,
                                autofocus: true
                            }),
                            button({
                                type: 'button',
                                class: 'toggle-password-btn',
                                onclick: toggleShowPassword,
                                'aria-label': 'Toggle password visibility'
                            }, () => showPassword.val ? '\uD83D\uDC41\uFE0F' : '\uD83D\uDC41')
                        ),
                        ul({ class: 'password-requirements' },
                            li({ class: () => hasMinLength.val ? 'met' : '' },
                                () => hasMinLength.val ? '\u2713' : '\u2717', ' At least 8 characters'
                            ),
                            li({ class: () => hasUppercase.val ? 'met' : '' },
                                () => hasUppercase.val ? '\u2713' : '\u2717', ' One uppercase letter'
                            ),
                            li({ class: () => hasLowercase.val ? 'met' : '' },
                                () => hasLowercase.val ? '\u2713' : '\u2717', ' One lowercase letter'
                            ),
                            li({ class: () => hasNumber.val ? 'met' : '' },
                                () => hasNumber.val ? '\u2713' : '\u2717', ' One number'
                            )
                        )
                    ),
                    div({ class: 'form-group' },
                        label({ for: 'confirm-passphrase' }, 'Confirm Passphrase'),
                        input({
                            type: () => showPassword.val ? 'text' : 'password',
                            id: 'confirm-passphrase',
                            value: confirmPassphrase,
                            oninput: (e) => { confirmPassphrase.val = e.target.value; },
                            placeholder: 'Confirm your passphrase',
                            required: true,
                            disabled: () => loading.val
                        }),
                        () => confirmPassphrase.val && !passwordsMatch.val
                            ? div({ class: 'field-error' }, 'Passphrases do not match')
                            : null
                    ),
                    () => setupError.val
                        ? div({ class: 'vault-error' }, setupError.val)
                        : null,
                    div({ class: 'vault-actions' },
                        button({
                            type: 'submit',
                            class: 'button button-primary',
                            disabled: () => loading.val || !isStrong.val || !passwordsMatch.val
                        }, () => loading.val ? 'Setting up...' : 'Create Vault')
                    )
                )
            )
        );
    };
}
