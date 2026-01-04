import van from 'vanjs-core';
import { webauthnService } from '../../services/webauthn';
import vaultService from '../../services/vaultService';

const { div, h3, p, button, ul, li, span, input, form } = van.tags;

export default function PasskeyManager() {
    const credentials = van.state([]);
    const isLoading = van.state(true);
    const isRegistering = van.state(false);
    const error = van.state('');
    const newPasskeyName = van.state('');
    const showAddForm = van.state(false);

    const loadCredentials = async () => {
        try {
            credentials.val = await webauthnService.getCredentials();
        } catch (e) {
            console.error(e);
        } finally {
            isLoading.val = false;
        }
    };

    // Load on mount
    loadCredentials();

    const handleAddPasskey = async (e) => {
        e.preventDefault();
        error.val = '';
        isRegistering.val = true;
        
        try {
            const name = newPasskeyName.val || 'My Passkey';
            const prfInput = await webauthnService.isAvailable() ? await vaultService.getPrfInput() : null;

            const result = await webauthnService.register(name, prfInput);
            
            // If PRF supported and we are unlocked, setup wrapping
            if (result.prfOutput) {
                await vaultService.setupPrfWrapping(result.prfOutput, result.credentialID);
            }

            await loadCredentials();
            showAddForm.val = false;
            newPasskeyName.val = '';
        } catch (err) {
            console.error(err);
            error.val = err.message || 'Failed to register passkey';
        } finally {
            isRegistering.val = false;
        }
    };

    const handleDelete = async (id) => {
        if (!confirm('Are you sure you want to remove this passkey?')) return;
        try {
            await webauthnService.deleteCredential(id);
            await loadCredentials();
        } catch (err) {
            console.error(err);
            alert('Failed to delete passkey');
        }
    };

    return div({ class: 'settings-section passkey-manager' },
        h3({ class: 'settings-section-title' },
            span({ class: 'section-icon' }, '🔑'),
            'Passkeys'
        ),
        
        div({ class: 'passkey-content' },
            p({ class: 'passkey-intro' }, 
                'Passkeys allow you to sign in securely without a password using your device (TouchID, FaceID, etc).'
            ),
            
            () => isLoading.val ? p('Loading...') : ul({ class: 'passkey-list' },
                credentials.val.length === 0 ? li({ class: 'empty-state' }, 'No passkeys registered') :
                credentials.val.map(cred => li({ class: 'passkey-item' },
                    div({ class: 'passkey-info' },
                        span({ class: 'passkey-name' }, cred.name || 'Passkey'),
                        span({ class: 'passkey-date' }, `Used: ${cred.last_used_at ? new Date(cred.last_used_at).toLocaleDateString() : 'Never'}`)
                    ),
                    button({ 
                        class: 'button button-danger button-sm',
                        onclick: () => handleDelete(cred.id)
                    }, 'Remove')
                ))
            ),
            
            !showAddForm.val ? button({
                class: 'button button-primary',
                onclick: () => showAddForm.val = true
            }, 'Add Passkey') :
            
            div({ class: 'add-passkey-form' },
                form({ onsubmit: handleAddPasskey },
                    div({ class: 'form-group' },
                        input({ 
                            type: 'text', 
                            placeholder: 'Passkey Name (e.g. MacBook Pro)',
                            value: newPasskeyName,
                            oninput: e => newPasskeyName.val = e.target.value,
                            required: true,
                            class: 'form-input'
                        })
                    ),
                    div({ class: 'form-actions' },
                         button({ 
                            class: 'button button-secondary',
                            type: 'button',
                            onclick: () => showAddForm.val = false
                        }, 'Cancel'),
                        button({ 
                            class: 'button button-primary',
                            type: 'submit', 
                            disabled: isRegistering
                        }, isRegistering.val ? 'Registering...' : 'Continue')
                    )
                ),
                () => error.val ? p({ class: 'error-message' }, error.val) : null
            )
        )
    );
}
