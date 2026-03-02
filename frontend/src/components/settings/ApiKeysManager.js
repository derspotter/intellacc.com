import van from 'vanjs-core';
const { div, h3, p, form, input, button, span, label, table, thead, tbody, tr, th, td, code } = van.tags;
import { api, ApiError } from '../../services/api.js';

export const ApiKeysManager = () => {
    const keys = van.state([]);
    const error = van.state('');
    const isLoading = van.state(true);
    const isCreating = van.state(false);
    const newKeyDisplay = van.state(null);

    let keyNameInput;
    let isBotInput;

    const loadKeys = async () => {
        isLoading.val = true;
        error.val = '';
        try {
            const response = await api.users.getApiKeys();
            if (response && response.keys) {
                keys.val = response.keys;
            }
        } catch (err) {
            if (err instanceof ApiError && (err.status === 403 || err.message === 'Forbidden')) {
                error.val = 'You must complete Email and Phone verification before generating API keys.';
            } else {
                error.val = err.message || 'Failed to load API keys';
            }
        } finally {
            isLoading.val = false;
        }
    };

    const handleCreateKey = async (e) => {
        e.preventDefault();
        const name = keyNameInput.value.trim();
        const isBot = isBotInput.checked;

        if (!name) {
            error.val = 'Key name is required';
            return;
        }

        isCreating.val = true;
        error.val = '';
        newKeyDisplay.val = null;

        try {
            const response = await api.users.createApiKey(name, isBot);
            if (response && response.apiKey) {
                newKeyDisplay.val = response.apiKey;
                keyNameInput.value = '';
                isBotInput.checked = false;
                await loadKeys();
            }
        } catch (err) {
            error.val = err.message || 'Failed to create key';
        } finally {
            isCreating.val = false;
        }
    };

    const handleRevokeKey = async (keyId) => {
        if (!confirm('Are you sure you want to revoke this key? Any scripts using it will immediately fail.')) return;

        error.val = '';
        try {
            await api.users.revokeApiKey(keyId);
            keys.val = keys.val.filter(k => k.id !== keyId);
        } catch (err) {
            error.val = err.message || 'Error revoking key';
        }
    };

    loadKeys();

    return div({ class: 'settings-section' }, [
        h3({ class: 'settings-section-title' },
            span({ class: 'section-icon' }, '🔑'),
            ' Agent API Keys'
        ),
        p({ class: 'text-sm text-gray-400 mb-4' }, 
          'Create secure, scoped API keys for headless bots or AI orchestrators (like OpenClaw). These keys bypass the need for passkeys but are strictly limited in what they can do.'
        ),

        () => isLoading.val 
            ? p({ class: 'loading' }, 'Loading keys...')
            : error.val === 'You must complete Email and Phone verification before generating API keys.'
                ? div({ class: 'verification-blocked', style: 'margin-bottom: 1rem;' },
                    div({ class: 'blocked-icon' }, '⚠️'),
                    p({ class: 'error-message' }, 'Verification Required'),
                    p({ class: 'blocked-message' }, 'You must complete Email and Phone verification before generating API keys.')
                  )
                : div([
                    () => error.val ? div({ class: 'error-message', style: 'margin-bottom: 1rem;' }, error.val) : null,
                    
                    form({ onsubmit: handleCreateKey, class: 'settings-form', style: 'margin-bottom: 1.5rem;' }, [
                        h3({ style: 'margin-top: 0; font-size: 1.1rem; margin-bottom: 1rem;' }, 'Generate New Key'),
                        div({ class: 'form-group' }, [
                            label('Key Name (e.g. "Trading Bot Alpha")'),
                            keyNameInput = input({ 
                                type: 'text', 
                                placeholder: 'Enter a name',
                                style: 'width: 100%; box-sizing: border-box;'
                            })
                        ]),
                        div({ class: 'form-group' }, [
                            label({ style: 'display: flex; align-items: center; gap: 0.5rem; cursor: pointer; font-weight: normal;' }, [
                                isBotInput = input({ type: 'checkbox', style: 'margin: 0; width: auto;' }),
                                span('This is an AI/Bot (Appends ✨ tag)')
                            ])
                        ]),
                        button({ 
                            type: 'submit', 
                            class: 'button button-primary',
                            disabled: () => isCreating.val
                        }, () => isCreating.val ? 'Generating...' : 'Generate Key')
                    ]),

                    () => newKeyDisplay.val ? div({ class: 'success-state', style: 'margin-bottom: 1.5rem;' }, [
                        div({ class: 'success-icon' }, 'OK'),
                        p({ class: 'success-message' }, 'Key Generated Successfully!'),
                        p('Please copy this key now. You will not be able to see it again.'),
                        div({ style: 'display: flex; align-items: center; justify-content: space-between; background: var(--bg-color); padding: 0.5rem; border-radius: 4px; border: 1px solid var(--border-color); margin-top: 0.5rem;' }, [
                            code({ style: 'word-break: break-all; font-size: 0.9em;' }, newKeyDisplay.val),
                            button({
                                type: 'button',
                                class: 'button button-secondary button-sm',
                                style: 'margin-left: 1rem; white-space: nowrap;',
                                onclick: () => navigator.clipboard.writeText(newKeyDisplay.val).then(() => alert('Copied to clipboard!'))
                            }, 'Copy')
                        ])
                    ]) : null,

                    () => keys.val.length === 0 
                        ? p({ style: 'text-align: center; color: var(--secondary-text); font-style: italic; font-size: 0.9em; padding: 1rem 0;' }, 'No API keys active.')
                        : div({ style: 'overflow-x: auto;' }, [
                            table({ style: 'width: 100%; border-collapse: collapse; font-size: 0.9em; text-align: left;' }, [
                                thead([
                                    tr({ style: 'border-bottom: 1px solid var(--border-color);' }, [
                                        th({ style: 'padding: 0.5rem;' }, 'Name'),
                                        th({ style: 'padding: 0.5rem;' }, 'Type'),
                                        th({ style: 'padding: 0.5rem;' }, 'Created'),
                                        th({ style: 'padding: 0.5rem;' }, 'Last Used'),
                                        th({ style: 'padding: 0.5rem; text-align: right;' }, 'Action')
                                    ])
                                ]),
                                tbody(
                                    keys.val.map(k => tr({ style: 'border-bottom: 1px solid var(--border-color);' }, [
                                        td({ style: 'padding: 0.5rem; font-weight: 500;' }, k.name),
                                        td({ style: 'padding: 0.5rem;' }, 
                                            k.is_bot 
                                                ? span({ style: 'background: rgba(128,0,128,0.1); color: purple; padding: 0.1rem 0.4rem; border-radius: 4px; font-size: 0.8em; border: 1px solid rgba(128,0,128,0.3);' }, 'AI/Bot')
                                                : span({ style: 'background: rgba(0,0,255,0.1); color: blue; padding: 0.1rem 0.4rem; border-radius: 4px; font-size: 0.8em; border: 1px solid rgba(0,0,255,0.3);' }, 'CLI')
                                        ),
                                        td({ style: 'padding: 0.5rem; color: var(--secondary-text);' }, new Date(k.created_at).toLocaleDateString()),
                                        td({ style: 'padding: 0.5rem; color: var(--secondary-text);' }, k.last_used_at ? new Date(k.last_used_at).toLocaleDateString() : 'Never'),
                                        td({ style: 'padding: 0.5rem; text-align: right;' },
                                            button({
                                                class: 'button-link',
                                                style: 'color: var(--error-color); padding: 0; background: none; border: none; cursor: pointer; font-size: 0.9em;',
                                                onclick: () => handleRevokeKey(k.id)
                                            }, 'Revoke')
                                        )
                                    ]))
                                )
                            ])
                        ])
                ])
    ]);
};
