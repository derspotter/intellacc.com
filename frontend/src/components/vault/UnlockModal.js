// frontend/src/components/vault/UnlockModal.js
// Modal for entering passphrase to unlock the vault

import van from 'vanjs-core';
import vaultStore from '../../stores/vaultStore.js';
import vaultService from '../../services/vaultService.js';

const { div, h2, p, form, input, button, label, span } = van.tags;

/**
 * Modal for unlocking the vault with passphrase
 */
export default function UnlockModal() {
    const passphrase = van.state('');
    const loading = van.state(false);
    const showPassword = van.state(false);

    const handleSubmit = async (e) => {
        e.preventDefault();
        if (loading.val || !passphrase.val) return;

        loading.val = true;
        vaultStore.setUnlockError('');

        try {
            await vaultService.unlock(passphrase.val);
            passphrase.val = '';
        } catch (error) {
            console.error('[UnlockModal] Unlock failed:', error);
            vaultStore.setUnlockError(error.message || 'Failed to unlock vault');
        } finally {
            loading.val = false;
        }
    };

    const toggleShowPassword = () => {
        showPassword.val = !showPassword.val;
    };

    return () => {
        if (!vaultStore.showUnlockModal) return null;

        return div({ class: 'vault-modal-overlay' },
            div({ class: 'vault-modal' },
                div({ class: 'vault-modal-header' },
                    span({ class: 'vault-icon' }, '\uD83D\uDD12'),
                    h2('Unlock Vault')
                ),
                p({ class: 'vault-modal-description' },
                    'Enter your passphrase to access your encrypted messages.'
                ),
                form({ class: 'vault-form', onsubmit: handleSubmit },
                    div({ class: 'form-group' },
                        label({ for: 'unlock-passphrase' }, 'Passphrase'),
                        div({ class: 'password-input-wrapper' },
                            input({
                                type: () => showPassword.val ? 'text' : 'password',
                                id: 'unlock-passphrase',
                                value: passphrase,
                                oninput: (e) => { passphrase.val = e.target.value; },
                                placeholder: 'Enter your passphrase',
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
                        )
                    ),
                    () => vaultStore.unlockError
                        ? div({ class: 'vault-error' }, vaultStore.unlockError)
                        : null,
                    div({ class: 'vault-actions' },
                        button({
                            type: 'submit',
                            class: 'button button-primary',
                            disabled: () => loading.val || !passphrase.val
                        }, () => loading.val ? 'Unlocking...' : 'Unlock')
                    )
                ),
                p({ class: 'vault-modal-footer' },
                    'Forgot passphrase? Your encrypted data cannot be recovered.',
                    button({
                        type: 'button',
                        class: 'link-button danger',
                        onclick: async () => {
                            if (confirm('This will permanently delete all your encrypted messages. Continue?')) {
                                await vaultService.panicWipe();
                                window.location.href = '/login';
                            }
                        }
                    }, 'Reset vault')
                )
            )
        );
    };
}
