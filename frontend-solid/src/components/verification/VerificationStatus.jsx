import { createSignal, Show } from 'solid-js';
import { api } from '../../services/api';

const TIER_INFO = [
  { level: 0, name: 'Unverified', description: 'Basic access', icon: '👤' },
  { level: 1, name: 'Email Verified', description: 'Post, comment, message', icon: '📧' },
  { level: 2, name: 'Phone Verified', description: 'Predictions and markets', icon: '📱' },
  { level: 3, name: 'Payment Verified', description: 'Governance and advanced', icon: '💳' }
];

export default function VerificationStatus({ onUpgrade }) {
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal('');
  const [status, setStatus] = createSignal(null);

  const refresh = async () => {
    setLoading(true);
    setError('');
    try {
      const data = await api.verification.getStatus();
      setStatus(data || {});
    } catch (err) {
      setError(err?.message || 'Failed to load verification status');
    } finally {
      setLoading(false);
    }
  };

  refresh();

  return (
    <div class="verification-status">
      <h3>Verification Status</h3>
      <Show when={loading()}>
        <div class="loading">Loading verification status...</div>
      </Show>
      <Show when={error()}>
        <div class="error-message">
          <p>{error()}</p>
          <button type="button" class="btn btn-sm" onClick={refresh}>
            Retry
          </button>
        </div>
      </Show>

      <Show when={!loading() && !error()}>
        <div class="tier-list">
          {() =>
            TIER_INFO.map((tier) => {
              const current = status()?.current_tier || 0;
              return (
                <div
                  class={`tier-item tier-level-${tier.level} ${
                    current >= tier.level ? 'verified' : ''
                  } ${current === tier.level ? 'current' : ''}`}
                >
                  <div class="tier-header">
                    <span class="tier-icon">{tier.icon}</span>
                    <span class="tier-name">{tier.name}</span>
                    <span class={`tier-badge ${current >= tier.level ? 'verified' : 'pending'}`}>
                      {current >= tier.level ? '✓' : '○'}
                    </span>
                  </div>
                  <div class="tier-details">
                    <p class="tier-description">{tier.description}</p>
                  </div>
                  {current === tier.level - 1 && onUpgrade ? (
                    <button
                      type="button"
                      class="btn btn-primary btn-sm upgrade-btn"
                      onClick={() => onUpgrade(tier.level)}
                    >
                      Verify {tier.name.replace(' Verified', '')}
                    </button>
                  ) : null}
                </div>
              );
            })
          }
        </div>
      </Show>
    </div>
  );
}
