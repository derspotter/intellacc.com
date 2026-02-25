// frontend/src/components/vault/VaultSettings.js
// Vault settings panel for the Settings page

import van from 'vanjs-core';
import vaultStore from '../../stores/vaultStore.js';
import vaultService from '../../services/vaultService.js';
import coreCryptoClient from '../../services/mls/coreCryptoClient.js';
import { api } from '../../services/api.js';

const { div, h3, p, button, label, select, option, span, input, form } = van.tags;

/**
 * Vault settings component for the Settings page
 */
export default function VaultSettings() {
    const showChangePassphrase = van.state(false);

    // Change Password States
    const oldPassword = van.state('');
    const newPassword = van.state('');
    const confirmPassword = van.state('');
    const changeError = van.state('');
    const changeSuccess = van.state('');
    const isChanging = van.state(false);

    // Key Rotation State
    const isRotatingKeys = van.state(false);
    const rotationError = van.state('');
    const rotationSuccess = van.state(false);

    // Unlock State
    const unlockPassword = van.state('');
    const unlockError = van.state('');
    const isUnlocking = van.state(false);

    const handleAutoLockChange = (e) => {
        const minutes = parseInt(e.target.value, 10);
        vaultStore.setAutoLockMinutes(minutes);
        // Persist to localStorage
        try {
            localStorage.setItem('vault_autolock_minutes', String(minutes));
        } catch { }
    };

    const handleLockNow = async () => {
        await vaultService.lockKeys();
        window.location.hash = 'login';
    };

    const handleUnlock = async (e) => {
        e.preventDefault();
        isUnlocking.val = true;
        unlockError.val = '';
        try {
            await vaultService.unlockWithPassword(unlockPassword.val);
            unlockPassword.val = '';
        } catch (err) {
            unlockError.val = 'Incorrect password';
        } finally {
            isUnlocking.val = false;
        }
    };

    const handlePanicWipe = async () => {
        const confirmed = confirm(
            'WARNING: This will permanently delete all your encrypted messages and cryptographic keys.\n\n' +
            'This action CANNOT be undone.\n\n' +
            'Are you sure you want to continue?'
        );

        if (confirmed) {
            const doubleConfirmed = confirm(
                'FINAL WARNING: All your secure messages will be lost forever.\n\n' +
                'Type "DELETE" in the next prompt to confirm.'
            );

            if (doubleConfirmed) {
                const typed = prompt('Type DELETE to confirm:');
                if (typed === 'DELETE') {
                    await vaultService.panicWipe();
                    window.location.href = '/login';
                }
            }
        }
    };

    const handleChangePassword = async (e) => {
        e.preventDefault();
        changeError.val = '';
        changeSuccess.val = '';

        if (newPassword.val !== confirmPassword.val) {
            changeError.val = 'New passwords do not match';
            return;
        }

        if (newPassword.val.length < 6) {
            changeError.val = 'Password must be at least 6 characters';
            return;
        }

        isChanging.val = true;

        try {
            // 1. Re-wrap vault key (Client side)
            // This verifies old password against the vault as well
            await vaultService.changePassphrase(oldPassword.val, newPassword.val);

            // 2. Change account password (Server side)
            await api.users.changePassword(oldPassword.val, newPassword.val);

            changeSuccess.val = 'Password changed successfully.';
            oldPassword.val = '';
            newPassword.val = '';
            confirmPassword.val = '';

            // Close form after a short delay
            setTimeout(() => {
                showChangePassphrase.val = false;
                changeSuccess.val = '';
            }, 2000);

        } catch (err) {
            console.error(err);
            changeError.val = err.message || 'Failed to change password. Ensure old password is correct.';
        } finally {
            isChanging.val = false;
        }
    };

    const handleRotateKeys = async () => {
        if (isRotatingKeys.val) return;
        isRotatingKeys.val = true;
        rotationError.val = '';
        rotationSuccess.val = false;

        try {
            await coreCryptoClient.rotateKeysAllGroups();
            rotationSuccess.val = true;
            setTimeout(() => { rotationSuccess.val = false; }, 3000);
        } catch (err) {
            console.error('[VaultSettings] Key rotation error:', err);
            rotationError.val = err.message || 'Failed to rotate keys for some conversations.';
        } finally {
            isRotatingKeys.val = false;
        }
    };

    // Load saved auto-lock setting
    van.derive(() => {
        try {
            const saved = localStorage.getItem('vault_autolock_minutes');
            if (saved) {
                vaultStore.setAutoLockMinutes(parseInt(saved, 10));
            }
        } catch { }
    });

    return div({ class: 'settings-section vault-settings' },
        h3({ class: 'settings-section-title' },
            span({ class: 'section-icon' }, '\uD83D\uDD12'),
            'Encryption Vault & Security'
        ),

        () => !vaultStore.vaultExists
            ? div({ class: 'vault-not-setup' },
                p('Your vault has not been set up yet. Log out and log back in to set it up automatically.'),
            )
            : div({ class: 'vault-settings-content' },
                // Status indicator
                div({ class: 'vault-status' },
                    span({ class: () => `status-indicator ${vaultStore.isLocked ? 'locked' : 'unlocked'}` }),
                    span({ class: 'status-text' },
                        () => vaultStore.isLocked ? 'Vault is locked' : 'Vault is unlocked'
                    )
                ),

                // Unlock Form (Only if locked)
                () => vaultStore.isLocked ? div({ class: 'unlock-form-container' },
                    p('Enter your password to unlock the vault and access encrypted messages.'),
                    form({ onsubmit: handleUnlock, class: 'settings-form' },
                        div({ class: 'form-group' },
                            input({
                                type: 'password',
                                placeholder: 'Password',
                                value: unlockPassword,
                                oninput: e => unlockPassword.val = e.target.value,
                                class: 'form-input'
                            })
                        ),
                        button({
                            class: 'button button-primary',
                            type: 'submit',
                            disabled: isUnlocking
                        }, isUnlocking.val ? 'Unlocking...' : 'Unlock Vault'),
                        () => unlockError.val ? p({ class: 'error-message' }, unlockError.val) : null
                    )
                ) : div([
                    // Settings available ONLY when unlocked

                    // Auto-lock setting
                    div({ class: 'setting-row' },
                        label({ for: 'auto-lock-select' }, 'Auto-lock after inactivity'),
                        select({
                            id: 'auto-lock-select',
                            value: () => String(vaultStore.autoLockMinutes),
                            onchange: handleAutoLockChange
                        },
                            option({ value: '0' }, 'Never'),
                            option({ value: '5' }, '5 minutes'),
                            option({ value: '15' }, '15 minutes'),
                            option({ value: '30' }, '30 minutes'),
                            option({ value: '60' }, '1 hour')
                        )
                    ),

                    // Change Password Section
                    div({ class: 'setting-row' },
                        button({
                            class: 'button button-secondary',
                            onclick: () => showChangePassphrase.val = !showChangePassphrase.val,
                        }, () => showChangePassphrase.val ? 'Cancel Password Change' : 'Change Account Password'),
                    ),

                    () => showChangePassphrase.val ? div({ class: 'change-password-form' },
                        form({ onsubmit: handleChangePassword, class: 'settings-form' },
                            div({ class: 'form-group' },
                                label('Current Password'),
                                input({ type: 'password', value: oldPassword, oninput: e => oldPassword.val = e.target.value, required: true, class: 'form-input' })
                            ),
                            div({ class: 'form-group' },
                                label('New Password'),
                                input({ type: 'password', value: newPassword, oninput: e => newPassword.val = e.target.value, required: true, minlength: 6, class: 'form-input' })
                            ),
                            div({ class: 'form-group' },
                                label('Confirm New Password'),
                                input({ type: 'password', value: confirmPassword, oninput: e => confirmPassword.val = e.target.value, required: true, class: 'form-input' })
                            ),
                            div({ class: 'form-actions' },
                                button({ class: 'button button-primary', type: 'submit', disabled: isChanging },
                                    () => isChanging.val ? 'Changing...' : 'Update Password'
                                )
                            ),
                            () => changeError.val ? p({ class: 'error-message' }, changeError.val) : null,
                            () => changeSuccess.val ? p({ class: 'success-message' }, changeSuccess.val) : null
                        )
                    ) : null,

                    // Key Rotation Section
                    div({ class: 'setting-row vault-rotation-section', style: 'margin-bottom: 20px; align-items: start; flex-direction: column; gap: 10px;' },
                        div({ class: 'settings-description' },
                            p(van.tags.strong('Post-Compromise Security')),
                            p({ style: 'color: #888; font-size: 0.9em; margin-top: 4px;' }, 'Refresh your encryption keys to ensure forward and backward secrecy across all your conversations.')
                        ),
                        button({
                            class: 'button button-primary',
                            onclick: handleRotateKeys,
                            disabled: isRotatingKeys
                        }, () => isRotatingKeys.val ? 'Rotating Keys...' : 'Refresh Encryption Keys'),
                        () => rotationError.val ? p({ class: 'error-message' }, rotationError.val) : null,
                        () => rotationSuccess.val ? p({ class: 'success-message' }, 'Keys refreshed successfully.') : null
                    ),

                    // Lock now button
                    div({ class: 'setting-row' },
                        button({
                            class: 'button button-secondary',
                            onclick: handleLockNow,
                        }, '\uD83D\uDD12 Lock Now')
                    )
                ]),

                // Danger zone (Always visible)
                div({ class: 'danger-zone' },
                    h3('Danger Zone'),
                    p({ class: 'danger-description' },
                        'These actions are irreversible and will permanently delete your encrypted data.'
                    ),
                    button({
                        class: 'button button-danger',
                        onclick: handlePanicWipe
                    }, '\uD83D\uDEA8 Emergency Wipe Vault')
                )
            )
    );
}
