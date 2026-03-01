import { createEffect, createSignal, For, Show } from 'solid-js';
import { getCurrentUserId } from '../../services/auth';
import {
  getLeaderboardFollowers,
  getLeaderboardFollowing,
  getLeaderboardGlobal,
  getLeaderboardNetwork,
  getLeaderboardUserRank
} from '../../services/api';

const LEADERBOARD_TABS = [
  { key: 'global', label: 'Global' },
  { key: 'followers', label: 'Followers' },
  { key: 'following', label: 'Following' },
  { key: 'network', label: 'Network' }
];

const formatReputation = (value) => {
  if (value === null || value === undefined) {
    return '1.0';
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric.toFixed(1) : '1.0';
};

const formatLogLoss = (value) => {
  if (value === null || value === undefined) {
    return '-';
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric.toFixed(3) : '-';
};

export default function LeaderboardCard() {
  const [activeTab, setActiveTab] = createSignal('global');
  const [entries, setEntries] = createSignal([]);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal('');
  const [rankData, setRankData] = createSignal(null);

  const fetchRows = async () => {
    setLoading(true);
    setError('');

    try {
      let nextEntries = [];
      const tab = activeTab();
      if (tab === 'global') {
        nextEntries = await getLeaderboardGlobal(10);
      } else if (tab === 'followers') {
        nextEntries = await getLeaderboardFollowers(10);
      } else if (tab === 'following') {
        nextEntries = await getLeaderboardFollowing(10);
      } else if (tab === 'network') {
        nextEntries = await getLeaderboardNetwork(10);
      } else {
        nextEntries = [];
      }
      setEntries(Array.isArray(nextEntries?.leaderboard) ? nextEntries.leaderboard : (nextEntries || []));

      if (tab === 'global' || tab === 'network') {
        try {
          const rank = await getLeaderboardUserRank();
          setRankData(rank || null);
        } catch {
          setRankData(null);
        }
      }
    } catch (err) {
      setError(err?.message || 'Failed to load leaderboard.');
      setEntries([]);
      setRankData(null);
    } finally {
      setLoading(false);
    }
  };

  const setTab = (tab) => {
    if (tab === activeTab()) {
      return;
    }
    setActiveTab(tab);
    void fetchRows();
  };

  const isCurrentUser = (userId) => {
    const current = getCurrentUserId();
    if (!current) return false;
    return String(userId) === String(current);
  };

  const renderEntries = () => {
    if (loading() && entries().length === 0 && !error()) {
      return <div class="leaderboard-loading">Loading leaderboard…</div>;
    }

    if (entries().length === 0 && !loading()) {
      return (
        <div class="leaderboard-empty">
          {activeTab() === 'global'
            ? 'No users with predictions yet.'
            : 'No users in your selected network yet.'}
        </div>
      );
    }

    return (
      <ul class="leaderboard-list-compact">
        <For each={entries()}>
          {(entry, index) => (
            <li class={`leaderboard-entry ${isCurrentUser(entry.user_id) ? 'current-user' : ''}`}>
              <span class="leaderboard-rank">#{index() + 1}</span>
              <div class="leaderboard-user">
                <a
                  class="leaderboard-username"
                  href={`#user/${entry.user_id}`}
                  onClick={(event) => {
                    event.preventDefault();
                    window.location.hash = `user/${entry.user_id}`;
                  }}
                >
                  {entry.username || `User ${entry.user_id}`}
                </a>
                <div class="leaderboard-meta">
                  <span class="leaderboard-meta-item">
                    {`Pred: ${entry.total_predictions ?? '-'}`
                  }
                  </span>
                  <span class="leaderboard-meta-item">
                    {`LogLoss: ${formatLogLoss(entry.avg_log_loss)}`}
                  </span>
                </div>
              </div>
              <div class="leaderboard-points">
                <span class="leaderboard-points-value">{formatReputation(entry.rep_points)}</span>
                <span class="leaderboard-points-label">RP</span>
              </div>
            </li>
          )}
        </For>
      </ul>
    );
  };

  createEffect(() => {
    void fetchRows();
  });

  return (
    <section class="predictions-sidebar leaderboard-card">
      <div class="leaderboard-header-row">
        <div class="card-header">
          <h3>Reputation Leaderboard</h3>
          <p class="header-subtitle">Unified log scoring (All-Log + PLL)</p>
        </div>
        <button
          type="button"
          class="refresh-button leaderboard-refresh"
          onClick={() => void fetchRows()}
          disabled={loading()}
        >
          {loading() ? 'Refreshing…' : '🔄'}
        </button>
      </div>

      <div class="leaderboard-tabs">
        {LEADERBOARD_TABS.map((tab) => (
          <button
            type="button"
            class={`tab-button ${activeTab() === tab.key ? 'active' : ''}`}
            onClick={() => setTab(tab.key)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <Show when={activeTab() === 'global' && rankData()}>
        <div class="user-rank-info">
          <span class="rank-label">Your Rank: </span>
          <span class="rank-value">#{rankData()?.rank || 'N/A'}</span>
          <span class="rank-points">{formatReputation(rankData()?.rep_points)} pts</span>
        </div>
      </Show>

      <div class="leaderboard-content">
        <Show when={error()}>
          <div class="leaderboard-error-banner">
            <span>{error()}</span>
            <button
              type="button"
              class="retry-button"
              onClick={() => void fetchRows()}
              disabled={loading()}
            >
              Retry
            </button>
          </div>
        </Show>
        {renderEntries()}
        <Show when={loading() && entries().length > 0}>
          <div class="leaderboard-loading-overlay">Refreshing…</div>
        </Show>
      </div>
    </section>
  );
}
