import van from 'vanjs-core';
import vaultStore from '../../stores/vaultStore.js';
import vaultService from '../../services/vaultService.js';

const { div, h2, p, form, input, button, span } = van.tags;

export default function MigrationModal() {
    const oldPassword = van.state('');
    const currentPassword = van.state('');
    const isLoading = van.state(false);
    const error = van.state('');

    const handleMigration = async (e) => {
        e.preventDefault();
        if (!oldPassword.val || !currentPassword.val) return;

        isLoading.val = true;
        error.val = '';

        try {
            const userId = vaultStore.userId;
            // 1. Try to unlock with OLD password
            const found = await vaultService.findAndUnlock(oldPassword.val, userId);
            
            if (!found) {
                throw new Error('Old password incorrect or no data found for this user.');
            }

            // 2. Re-wrap with NEW (Current) password
            await vaultService.changePassphrase(oldPassword.val, currentPassword.val);
            
            // Success
            vaultStore.setShowMigrationModal(false);
            alert('History recovered and security updated!');
            
        } catch (err) {
            console.error('[Migration] Error:', err);
            error.val = err.message || 'Migration failed';
        } finally {
            isLoading.val = false;
        }
    };

    const handleReset = async () => {
        if (!confirm('This will delete your local message history on this device. Are you sure?')) return;
        
        isLoading.val = true;
        try {
            // Setup fresh with CURRENT password
            // Note: Since we are logged in, we assume they know the current password they just used.
            // But we need it for wrapping. We can use the one they typed in "Current Password" field
            // or ask for it if empty.
            if (!currentPassword.val) {
                error.val = 'Please enter your Current Password to setup a fresh vault.';
                isLoading.val = false;
                return;
            }
            
            await vaultService.setupKeystoreWithPassword(currentPassword.val);
            vaultStore.setShowMigrationModal(false);
        } catch (err) {
            error.val = 'Reset failed: ' + err.message;
        } finally {
            isLoading.val = false;
        }
    };

    return () => {
        if (!vaultStore.showMigrationModal) return null;

        return div({ class: 'modal-overlay' },
            div({ class: 'modal-content' },
                h2('Encrypted Storage Found'),
                p('We found existing encrypted data on this device. If this is your data and you changed your password, enter your OLD password to recover it.'),
                p('If you are a new user on this device, or want to start fresh, select "Create New".'),
                
                form({ onsubmit: handleMigration },
                    div({ class: 'form-group' },
                        input({
                            type: 'password',
                            placeholder: 'Old Password (for recovery)',
                            value: oldPassword,
                            oninput: e => oldPassword.val = e.target.value,
                            required: false, // Not required if clicking Create New
                            class: 'form-input',
                            autofocus: true
                        })
                    ),
                    div({ class: 'form-group' },
                        input({
                            type: 'password',
                            placeholder: 'Current Login Password',
                            value: currentPassword,
                            oninput: e => currentPassword.val = e.target.value,
                            required: true,
                            class: 'form-input'
                        })
                    ),
                    
                    error.val ? p({ class: 'error-message' }, error.val) : null,
                    
                    div({ class: 'form-actions', style: 'justify-content: space-between; align-items: center;' },
                        button({
                            type: 'button',
                            class: 'button button-danger',
                            onclick: handleReset,
                            disabled: isLoading
                        }, 'Create New / Reset'),
                        
                        div({ style: 'display: flex; gap: 10px;' },
                            button({
                                type: 'button',
                                class: 'button button-secondary',
                                onclick: () => vaultStore.setShowMigrationModal(false),
                                disabled: isLoading
                            }, 'Cancel'),
                            button({
                                type: 'submit',
                                class: 'button button-primary',
                                disabled: isLoading
                            }, isLoading.val ? 'Updating...' : 'Recover Data')
                        )
                    )
                )
            )
        );
    };
}
