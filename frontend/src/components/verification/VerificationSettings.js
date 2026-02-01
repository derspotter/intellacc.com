/**
 * Verification Settings Section
 * Combines status and upgrade flows
 */
import van from 'vanjs-core';
import api from '../../services/api.js';
import userStore from '../../store/user';
import VerificationStatus from './VerificationStatus.js';
import EmailVerification from './EmailVerification.js';
import PhoneVerification from './PhoneVerification.js';
import PaymentVerification from './PaymentVerification.js';

const { div, h3, p, button } = van.tags;

export default function VerificationSettings() {
  const status = van.state(null);
  const loading = van.state(true);
  const error = van.state('');
  const activeTier = van.state(null);

  const refreshStatus = async () => {
    loading.val = true;
    error.val = '';
    try {
      const result = await api.verification.getStatus();
      status.val = result;
      if (result?.current_tier >= 3) {
        activeTier.val = null;
      } else if (!activeTier.val || activeTier.val <= result.current_tier) {
        activeTier.val = result.current_tier + 1;
      }
    } catch (err) {
      console.error('[VerificationSettings] Error:', err);
      error.val = err.data?.error || err.message || 'Failed to load verification status';
    } finally {
      loading.val = false;
    }
  };

  refreshStatus();

  const renderUpgrade = () => {
    if (loading.val) {
      return p({ class: 'loading' }, 'Loading verification steps...');
    }

    if (error.val) {
      return div({ class: 'error-message' },
        p(error.val),
        button({ type: 'button', class: 'btn btn-sm', onclick: refreshStatus }, 'Retry')
      );
    }

    const currentTier = status.val?.current_tier || 0;
    const targetTier = activeTier.val || currentTier + 1;

    if (currentTier >= 3) {
      return div({ class: 'success-state' },
        div({ class: 'success-icon' }, 'OK'),
        p({ class: 'success-message' }, 'All verification tiers complete.')
      );
    }

    if (targetTier === 1) {
      return EmailVerification({ userEmail: userStore.state.profile.val?.email });
    }

    if (targetTier === 2) {
      return PhoneVerification({ onSuccess: refreshStatus });
    }

    if (targetTier === 3) {
      return PaymentVerification({ onSuccess: refreshStatus });
    }

    return null;
  };

  return div({ class: 'settings-section verification-settings' },
    h3({ class: 'settings-section-title' },
      'Verification'
    ),
    div({ class: 'verification-content' },
      VerificationStatus({ onUpgrade: (tier) => activeTier.val = tier }),
      renderUpgrade,
      button({
        type: 'button',
        class: 'btn btn-secondary btn-sm verification-refresh',
        onclick: refreshStatus
      }, 'Refresh Status')
    )
  );
}
