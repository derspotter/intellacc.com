import van from 'vanjs-core';
import vaultStore from '../../stores/vaultStore.js';
import vaultService from '../../services/vaultService.js';

const { div, h2, p, form, input, button, span } = van.tags;

/**
 * Modal to unlock the device keystore using the login password
 */
export default function UnlockKeystoreModal() {
    const password = van.state('');
    const isLoading = van.state(false);
    const error = van.state('');

    const handleSubmit = async (e) => {
        e.preventDefault();
        if (!password.val) return;

        isLoading.val = true;
        error.val = '';

        try {
            await vaultService.unlockWithPassword(password.val);
            // Successfully unlocked, modal will be hidden by reactive state
        } catch (err) {
            console.error('[UnlockModal] Error:', err);
            error.val = err.message || 'Incorrect password';
        } finally {
            isLoading.val = false;
        }
    };

    return () => {
        if (!vaultStore.showUnlockModal) return null;

        return div({ class: 'modal-overlay' },
            div({ class: 'modal-content unlock-modal' },
                h2('Unlock Messaging'),
                p('Please enter your login password to unlock your encrypted messages on this device.'),
                
                form({ onsubmit: handleSubmit },
                    div({ class: 'form-group' },
                        input({
                            type: 'password',
                            placeholder: 'Login Password',
                            value: password,
                            oninput: e => password.val = e.target.value,
                            required: true,
                            class: 'form-input',
                            autofocus: true,
                            disabled: isLoading
                        })
                    ),
                    
                    error.val ? p({ class: 'error-message' }, error.val) : null,
                    
                    div({ class: 'form-actions' },
                        button({
                            type: 'submit',
                            class: 'button button-primary',
                            disabled: isLoading
                        }, isLoading.val ? 'Unlocking...' : 'Unlock'),
                        
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
                        'This unlocks your local encryption keys. Your password is never stored unencrypted.'
                    )
                )
            )
        );
    };
}
