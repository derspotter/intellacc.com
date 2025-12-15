// frontend/src/components/vault/VaultSettings.js
// Vault settings panel for the Settings page

import van from 'vanjs-core';
import vaultStore from '../../stores/vaultStore.js';
import vaultService from '../../services/vaultService.js';

const { div, h3, p, button, label, select, option, span } = van.tags;

/**
 * Vault settings component for the Settings page
 */
export default function VaultSettings() {
    const showChangePassphrase = van.state(false);

    const handleAutoLockChange = (e) => {
        const minutes = parseInt(e.target.value, 10);
        vaultStore.setAutoLockMinutes(minutes);
        // Persist to localStorage
        try {
            localStorage.setItem('vault_autolock_minutes', String(minutes));
        } catch {}
    };

    const handleLockNow = async () => {
        await vaultService.lockKeys();
        vaultStore.setShowUnlockModal(true);
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

    // Load saved auto-lock setting
    van.derive(() => {
        try {
            const saved = localStorage.getItem('vault_autolock_minutes');
            if (saved) {
                vaultStore.setAutoLockMinutes(parseInt(saved, 10));
            }
        } catch {}
    });

    return div({ class: 'settings-section vault-settings' },
        h3({ class: 'settings-section-title' },
            span({ class: 'section-icon' }, '\uD83D\uDD12'),
            'Encryption Vault'
        ),

        () => !vaultStore.vaultExists
            ? div({ class: 'vault-not-setup' },
                p('Your vault has not been set up yet.'),
                button({
                    class: 'button button-primary',
                    onclick: () => vaultStore.setShowSetupModal(true)
                }, 'Set Up Vault')
            )
            : div({ class: 'vault-settings-content' },
                // Status indicator
                div({ class: 'vault-status' },
                    span({ class: () => `status-indicator ${vaultStore.isLocked ? 'locked' : 'unlocked'}` }),
                    span({ class: 'status-text' },
                        () => vaultStore.isLocked ? 'Vault is locked' : 'Vault is unlocked'
                    )
                ),

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

                // Lock now button
                div({ class: 'setting-row' },
                    button({
                        class: 'button button-secondary',
                        onclick: handleLockNow,
                        disabled: () => vaultStore.isLocked
                    }, '\uD83D\uDD12 Lock Now')
                ),

                // Danger zone
                div({ class: 'danger-zone' },
                    h3('Danger Zone'),
                    p({ class: 'danger-description' },
                        'These actions are irreversible and will permanently delete your encrypted data.'
                    ),
                    button({
                        class: 'button button-danger',
                        onclick: handlePanicWipe
                    }, '\uD83D\uDEA8 Emergency Wipe')
                )
            )
    );
}
