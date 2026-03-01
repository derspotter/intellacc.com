import { createEffect, createSignal, onCleanup, onMount } from 'solid-js';
import { isAuthenticated } from '../../services/auth';
import {
  getCurrentUser,
  getScoringUserRank
} from '../../services/api';
import Button from '../common/Button';

const safeNumber = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const normalize = (value) => ({
  rp_balance: safeNumber(value?.rp_balance),
  rep_points: safeNumber(value?.rep_points),
  rank: value?.rank || null,
  total_predictions: Number(value?.total_predictions || 0)
});

const formatRP = (value) => {
  const numeric = safeNumber(value);
  return `${numeric.toFixed(2)} RP`;
};

export default function RPBalance({ horizontal = false }) {
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal('');
  const [balance, setBalance] = createSignal(null);
  const [lastToken, setLastToken] = createSignal('');

  const isAuthed = () => isAuthenticated();

  const loadBalance = async () => {
    if (!isAuthed()) {
      setBalance(null);
      setLoading(false);
      setError('');
      return;
    }

    setLoading(true);
    setError('');
    try {
      const [userResponse, rankResponse] = await Promise.allSettled([
        getCurrentUser(),
        getScoringUserRank()
      ]);

      const userPayload = userResponse.status === 'fulfilled' ? userResponse.value : null;
      const rankPayload = rankResponse.status === 'fulfilled' ? rankResponse.value : {};

      setBalance(normalize({
        rp_balance: userPayload?.rp_balance,
        rep_points: rankPayload?.rep_points,
        rank: rankPayload?.rank,
        total_predictions: rankPayload?.total_predictions
      }));
    } catch (loadError) {
      setError(loadError?.message || 'Unable to load balance.');
      setBalance(null);
    } finally {
      setLoading(false);
    }
  };

  createEffect(() => {
    const token = localStorage.getItem('token') || '';
    if (token !== lastToken()) {
      setLastToken(token);
      loadBalance();
    }
  });

  const handleAuthChange = () => {
    setTimeout(() => {
      const token = localStorage.getItem('token') || '';
      if (token !== lastToken()) {
        setLastToken(token);
      }
      loadBalance();
    }, 0);
  };

  const refresh = () => loadBalance();

  onMount(() => {
    window.addEventListener('solid-auth-changed', handleAuthChange);
    handleAuthChange();
  });

  onCleanup(() => {
    window.removeEventListener('solid-auth-changed', handleAuthChange);
  });

  if (horizontal) {
    return (
      <div class="user-stats-horizontal">
        {loading() && <div class="prediction-event-meta">Loading your balance…</div>}
        {error() && (
          <div class="prediction-card error" style={{ width: '100%' }}>
            <p>{error()}</p>
            <Button onclick={refresh} variant="secondary">Retry</Button>
          </div>
        )}
        {!loading() && !error() && !balance() && (
          <div class="prediction-card">
            <p>Unable to load balance. Please log in.</p>
            <Button onclick={() => (window.location.hash = 'login')} variant="secondary">
              Log in
            </Button>
          </div>
        )}
        {balance() ? (
          <>
            <div class="stat-item">
              <span class="stat-main">{formatRP(balance().rp_balance)}</span>
              <span class="stat-sub">Balance</span>
            </div>
            <div class="stat-item">
              <span class="stat-main">{formatRP(balance().rp_balance)}</span>
              <span class="stat-sub">Available for Betting</span>
            </div>
            <div class="stat-item">
              <span class="stat-main">
                {Number.isFinite(Number(balance().rep_points)) ? Number(balance().rep_points).toFixed(1) : '1.0'}
              </span>
              <span class="stat-sub">Reputation Points</span>
            </div>
            <div class="stat-item">
              <span class="stat-main">#{balance().rank || 'Unranked'}</span>
              <span class="stat-sub">Global Rank</span>
            </div>
            <div class="stat-item">
              <span class="stat-main">{Number(balance().total_predictions || 0)}</span>
              <span class="stat-sub">Total Predictions</span>
            </div>
          </>
        ) : null}
      </div>
    );
  }

  return (
    <section class="rp-balance-card">
      <h3 class="rp-balance-title">💰 Your RP Balance</h3>
      {loading() && <p class="rp-balance-loading">Loading your balance…</p>}
      {error() && <p class="rp-balance-error">{error()}</p>}
      {!loading() && !error() && balance() && (
        <div class="rp-balance-content">
          <div class="balance-display">
            <span class="balance-amount">
              {formatRP(balance().rp_balance)}
            </span>
            <span class="balance-label">Available for betting</span>
          </div>
          <div class="rp-balance-stats">
            <p>Reputation: {Number(balance().rep_points || 1).toFixed(1)}</p>
            <p>Global Rank: {balance().rank || 'Unranked'}</p>
            <p>Total Predictions: {balance().total_predictions || 0}</p>
          </div>
          <div class="balance-actions">
            <Button onclick={() => (window.location.hash = 'profile')} variant="secondary">
              📊 View Profile
            </Button>
            <Button onclick={refresh} variant="secondary">
              🔄 Refresh
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
