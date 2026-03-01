import { createSignal, Show } from 'solid-js';
import { getTokenData } from '../../services/tokenService';
import api from '../../services/api';
import VerificationStatus from './VerificationStatus.jsx';
import EmailVerification from './EmailVerification.jsx';
import PhoneVerification from './PhoneVerification.jsx';
import PaymentVerification from './PaymentVerification.jsx';

const TIER_TIERS = {
  1: 'Email',
  2: 'Phone',
  3: 'Payment'
};

export default function VerificationSettings() {
  const [status, setStatus] = createSignal(null);
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal('');
  const [targetTier, setTargetTier] = createSignal(null);

  const tokenData = getTokenData();
  const userEmail = () => tokenData?.email;

  const refreshStatus = async () => {
    setLoading(true);
    setError('');

    try {
      const result = await api.verification.getStatus();
      setStatus(result || {});

      const currentTier = result?.current_tier || 0;
      if (currentTier >= 3) {
        setTargetTier(null);
      } else if (!targetTier() || targetTier() <= currentTier) {
        setTargetTier(currentTier + 1);
      }
    } catch (err) {
      setError(err?.data?.error || err?.message || 'Failed to load verification status');
    } finally {
      setLoading(false);
    }
  };

  const renderUpgrade = () => {
    if (loading()) {
      return <p class="loading">Loading verification steps...</p>;
    }

    if (error()) {
      return (
        <div class="error-message">
          <p>{error()}</p>
          <button type="button" class="btn btn-sm" onClick={refreshStatus}>
            Retry
          </button>
        </div>
      );
    }

    const current = status()?.current_tier || 0;
    const next = targetTier() || current + 1;

    if (current >= 3) {
      return (
        <div class="success-state">
          <div class="success-icon">✓</div>
          <p class="success-message">All verification tiers complete.</p>
        </div>
      );
    }

    if (next === 1) {
      return <EmailVerification userEmail={userEmail()} onSuccess={refreshStatus} />;
    }

    if (next === 2) {
      const phoneAvailability = status()?.provider_capabilities?.phone;
      if (phoneAvailability && phoneAvailability.available === false) {
        return (
          <div class="verification-blocked">
            <div class="blocked-icon">⚠️</div>
            <p class="error-message">Phone verification is currently unavailable.</p>
            <p class="blocked-message">
              {phoneAvailability.reason || 'Check back later or contact support.'}
            </p>
            <p class="blocked-message">You can still use public feed features until a provider becomes available.</p>
          </div>
        );
      }
      return <PhoneVerification onSuccess={refreshStatus} />;
    }

    if (next === 3) {
      const paymentAvailability = status()?.provider_capabilities?.payment;
      if (paymentAvailability && paymentAvailability.available === false) {
        return (
          <div class="verification-blocked">
            <div class="blocked-icon">⚠️</div>
            <p class="error-message">Payment verification is currently unavailable.</p>
            <p class="blocked-message">
              {paymentAvailability.reason || 'Check back later or contact support.'}
            </p>
            <p class="blocked-message">This is required for market creation and governance actions.</p>
          </div>
        );
      }
      return <PaymentVerification onSuccess={refreshStatus} />;
    }

    return (
      <p class="error-message">
        Unknown verification state for next step:
        {next in TIER_TIERS ? ` ${TIER_TIERS[next]}` : ' unknown'}
      </p>
    );
  };

  refreshStatus();

  return (
    <section class="settings-section verification-settings">
      <h3 class="settings-section-title">Verification</h3>
      <div class="verification-content">
        <VerificationStatus
          onUpgrade={(next) => setTargetTier(next)}
        />
        {renderUpgrade()}
        <button
          type="button"
          class="btn btn-secondary btn-sm verification-refresh"
          onClick={refreshStatus}
        >
          Refresh Status
        </button>
      </div>
    </section>
  );
}

