import van from 'vanjs-core';
import { webauthnService } from '../../services/webauthn';
import { saveToken, checkAuth, onLoginSuccess } from '../../services/auth';
import vaultService from '../../services/vaultService';

const { button, span } = van.tags;

export default function PasskeyButton({ email, onSuccess, onError }) {
    const isSupported = van.state(false);
    const isLoading = van.state(false);

    // Check support on mount
    webauthnService.isAvailable().then(avail => {
        isSupported.val = avail;
    });

    const handleClick = async (e) => {
        e.preventDefault();
        isLoading.val = true;
        
        // Resolve email value
        let emailVal = email;
        if (typeof email === 'function') emailVal = email();
        else if (email && typeof email.val !== 'undefined') emailVal = email.val;

        try {
            // Get PRF input if vault exists
            const prfInput = await vaultService.getPrfInput();

            const result = await webauthnService.login(emailVal, prfInput);
            if (result.verified && result.token) {
                saveToken(result.token);
                
                // If we got PRF output, attempt to unlock vault immediately
                if (result.prfOutput) {
                    try {
                        await vaultService.unlockWithPrf(result.prfOutput);
                        console.log('Vault unlocked via PRF');
                    } catch (e) {
                        console.warn('Vault PRF unlock failed:', e);
                    }
                }

                // Run full post-login bootstrap (MLS, sync, etc.)
                await onLoginSuccess(null); // No password provided

                if (onSuccess) onSuccess();
            }
        } catch (err) {
            console.error(err);
            if (onError) onError(err);
        } finally {
            isLoading.val = false;
        }
    };

    return () => isSupported.val ? button({
        class: 'button button-secondary passkey-btn',
        type: 'button',
        onclick: handleClick,
        disabled: isLoading,
        style: 'margin-top: 10px; width: 100%; display: flex; justify-content: center; align-items: center; gap: 8px;'
    }, 
        span({ style: 'font-size: 1.2em;' }, '🔑'),
        isLoading.val ? 'Verifying...' : 'Sign in with Passkey'
    ) : null;
}
