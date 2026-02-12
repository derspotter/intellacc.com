import van from 'vanjs-core';
import vaultStore from '../../stores/vaultStore.js';
import vaultService from '../../services/vaultService.js';
import { isLinkRequiredError } from '../../services/auth.js';

const { div, h2, p, form, input, button } = van.tags;

const UNLOCK_MODE = 'unlock';
const SETUP_MODE = 'setup';

/**
 * Modal to unlock or set up the device keystore using a local vault passphrase.
 */
export default function UnlockKeystoreModal() {
    const password = van.state('');
    const confirmPassword = van.state('');
    const mode = van.state(UNLOCK_MODE);
    const isLoading = van.state(false);
    const error = van.state('');
    const setupPassphraseLocked = van.state(false);

    const resetState = () => {
        password.val = '';
        confirmPassword.val = '';
        mode.val = vaultStore.vaultExists ? UNLOCK_MODE : SETUP_MODE;
        isLoading.val = false;
        error.val = '';
        setupPassphraseLocked.val = false;
    };

    const enterLockedSetupMode = (message) => {
        mode.val = SETUP_MODE;
        setupPassphraseLocked.val = true;
        confirmPassword.val = '';
        error.val = message;
    };

    let wasVisible = false;
    van.derive(() => {
        const isVisible = vaultStore.showUnlockModal;
        if (isVisible && !wasVisible) {
            resetState();
        } else if (!isVisible && wasVisible) {
            resetState();
        }
        wasVisible = isVisible;
    });

    const handleSetup = async () => {
        if (!password.val) {
            error.val = 'Passphrase is required';
            return;
        }
        if (!confirmPassword.val) {
            error.val = 'Please confirm your passphrase';
            return;
        }
        if (password.val !== confirmPassword.val) {
            error.val = 'Passphrases do not match';
            return;
        }

        if (!setupPassphraseLocked.val) {
            // Setup-mode without prior unlock means this account has no vault yet.
            vaultService.masterKey = null;
            vaultService.masterKeyResolved = false;
        }

        try {
            await vaultService.setupKeystoreWithPassword(password.val);
            vaultStore.setShowUnlockModal(false);
        } catch (setupError) {
            console.error('[UnlockModal] Setup error:', setupError);
            if (isLinkRequiredError(setupError)) {
                vaultStore.setShowUnlockModal(false);
                vaultStore.setShowDeviceLinkModal(true);
            } else {
                error.val = setupError.message || 'Failed to set up vault';
            }
        }
    };

    const handleUnlock = async () => {
        try {
            await vaultService.unlockWithPassword(password.val);
            vaultStore.setShowUnlockModal(false);
        } catch (err) {
            console.error('[UnlockModal] Error:', err);
            if (isLinkRequiredError(err)) {
                vaultStore.setShowUnlockModal(false);
                vaultStore.setShowDeviceLinkModal(true);
                return;
            }

            const createdMasterKey = Boolean(vaultService.didCreateMasterKey && vaultService.didCreateMasterKey());
            if (createdMasterKey) {
                enterLockedSetupMode('No local vault exists for this account on this device. Confirm this passphrase to create one now.');
                return;
            }

            const resolvedMasterKey = Boolean(vaultService.didResolveMasterKey && vaultService.didResolveMasterKey());
            if (resolvedMasterKey) {
                try {
                    // Existing account vault was unlocked, but this device has no local vault for this user yet.
                    await vaultService.setupKeystoreWithPassword(password.val);
                    vaultStore.setShowUnlockModal(false);
                    return;
                } catch (setupError) {
                    console.error('[UnlockModal] Existing-vault device bootstrap error:', setupError);
                    if (isLinkRequiredError(setupError)) {
                        vaultStore.setShowUnlockModal(false);
                        vaultStore.setShowDeviceLinkModal(true);
                        return;
                    }
                    error.val = setupError.message || 'Failed to set up local vault for this device.';
                    return;
                }
            }

            error.val = 'Passphrase did not unlock an existing vault for this account.';
        }
    };

    const handleSubmit = async (e) => {
        e.preventDefault();
        if (!password.val) return;

        isLoading.val = true;
        error.val = '';

        try {
            if (mode.val === SETUP_MODE) {
                await handleSetup();
            } else {
                await handleUnlock();
            }
        } finally {
            isLoading.val = false;
        }
    };

    return () => div({ class: 'unlock-modal-wrapper' },
        vaultStore.showUnlockModal ? div({ class: 'modal-overlay' },
            div({ class: 'modal-content unlock-modal' },
                h2(() => mode.val === SETUP_MODE ? 'Set Up Messaging Vault' : 'Unlock Messaging'),
                () => mode.val === SETUP_MODE
                    ? p('Set a vault passphrase for encrypted messaging on this device. If you are returning, use the same passphrase you used before.')
                    : p('Enter your vault passphrase to unlock encrypted messages on this device. If you signed in with email/password, this is usually your login password.'),

                form({ onsubmit: handleSubmit },
                    div({ class: 'form-group' },
                        input({
                            type: 'password',
                            placeholder: 'Vault Passphrase',
                            value: password,
                            oninput: e => password.val = e.target.value,
                            required: true,
                            class: 'form-input',
                            autofocus: true,
                            disabled: isLoading,
                        })
                    ),

                    () => mode.val === SETUP_MODE ? div({ class: 'form-group' },
                        input({
                            type: 'password',
                            placeholder: 'Confirm Vault Passphrase',
                            value: confirmPassword,
                            oninput: e => confirmPassword.val = e.target.value,
                            required: true,
                            class: 'form-input',
                            disabled: isLoading
                        })
                    ) : null,

                    () => error.val ? p({ class: 'error-message' }, error.val) : null,

                    div({ class: 'form-actions' },
                        button({
                            type: 'submit',
                            class: 'button button-primary',
                            disabled: isLoading
                        }, () => {
                            if (mode.val === SETUP_MODE) {
                                return isLoading.val ? 'Setting up...' : 'Create Vault';
                            }
                            return isLoading.val ? 'Unlocking...' : 'Unlock';
                        }),

                        button({
                            type: 'button',
                            class: 'button button-secondary',
                            onclick: () => vaultStore.setShowUnlockModal(false),
                            disabled: isLoading
                        }, 'Cancel')
                    )
                ),

                div({ class: 'modal-footer' },
                    p({ class: 'text-muted small' },
                        'This unlocks your local encryption keys. Your passphrase is only used to wrap keys and is never stored unencrypted.'
                    )
                )
            )
        ) : null
    );
}
