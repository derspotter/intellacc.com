import { createEffect, createSignal, For, Show } from 'solid-js';
import Card from '../common/Card';
import Button from '../common/Button';
import { getPredictionAnalyticsDashboard } from '../../services/api';
import { isAuthenticated } from '../../services/auth';

const formatNumber = (value, fallback = '0') => {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return num.toLocaleString();
};

const formatPercent = (value, fallback = '—') => {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return `${num.toFixed(1)}%`;
};

const formatRp = (value) => {
  const num = Number(value);
  if (!Number.isFinite(num)) return '0.00 RP';
  return `${num.toFixed(2)} RP`;
};

const formatDate = (value) => {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString();
};

const summarizePredictionStatus = (item) => {
  if (!item) return 'Pending';
  if (item.outcome) return String(item.outcome);
  return 'Pending';
};

export default function PredictionAnalyticsDashboard() {
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal('');
  const [dashboard, setDashboard] = createSignal(null);

  const load = async () => {
    if (!isAuthenticated()) {
      setDashboard(null);
      setError('');
      setLoading(false);
      return;
    }

    try {
      setLoading(true);
      setError('');
      const payload = await getPredictionAnalyticsDashboard();
      setDashboard(payload || null);
    } catch (err) {
      setError(err?.message || 'Failed to load analytics.');
    } finally {
      setLoading(false);
    }
  };

  createEffect(() => {
    load();
  });

  const summary = () => dashboard()?.summary || {};
  const activity = () => dashboard()?.activity || {};
  const recentPredictions = () => dashboard()?.recent_predictions || [];
  const openPositions = () => dashboard()?.open_positions || [];

  if (!isAuthenticated()) {
    return (
      <Card title="Prediction Analytics" className="prediction-analytics-dashboard">
        <p>Sign in to view your forecasting and position analytics.</p>
      </Card>
    );
  }

  return (
    <Card title="Prediction Analytics Dashboard" className="prediction-analytics-dashboard">
      <div class="dashboard-header-row">
        <p class="dashboard-subtitle">Forecasting performance, open exposure, and recent market activity.</p>
        <Button type="button" className="analytics-refresh-button" variant="secondary" onclick={() => void load()} disabled={loading()}>
          {loading() ? 'Refreshing…' : 'Refresh'}
        </Button>
      </div>

      <Show when={error()}>
        <div class="leaderboard-error-banner">{error()}</div>
      </Show>

      <Show when={loading() && !dashboard()}>
        <div class="leaderboard-loading">Loading analytics…</div>
      </Show>

      <Show when={dashboard()}>
        <div class="analytics-summary-grid">
          <div class="analytics-stat-card">
            <span class="analytics-stat-label">Total Predictions</span>
            <span class="analytics-stat-value">{formatNumber(summary().total_predictions)}</span>
          </div>
          <div class="analytics-stat-card">
            <span class="analytics-stat-label">Accuracy</span>
            <span class="analytics-stat-value">{formatPercent(summary().accuracy_percent)}</span>
          </div>
          <div class="analytics-stat-card">
            <span class="analytics-stat-label">Pending</span>
            <span class="analytics-stat-value">{formatNumber(summary().pending_predictions)}</span>
          </div>
          <div class="analytics-stat-card">
            <span class="analytics-stat-label">Active Markets</span>
            <span class="analytics-stat-value">{formatNumber(activity().active_markets)}</span>
          </div>
          <div class="analytics-stat-card">
            <span class="analytics-stat-label">Open Positions</span>
            <span class="analytics-stat-value">{formatNumber(activity().open_positions)}</span>
          </div>
          <div class="analytics-stat-card">
            <span class="analytics-stat-label">30d Trade Volume</span>
            <span class="analytics-stat-value">{formatRp(activity().staked_last_30d)}</span>
          </div>
        </div>

        <div class="analytics-detail-grid">
          <div class="analytics-panel">
            <h3>Forecasting Summary</h3>
            <div class="analytics-key-values">
              <p><span>Resolved:</span> <strong>{formatNumber(summary().resolved_predictions)}</strong></p>
              <p><span>Correct:</span> <strong>{formatNumber(summary().correct_predictions)}</strong></p>
              <p><span>Incorrect:</span> <strong>{formatNumber(summary().incorrect_predictions)}</strong></p>
              <p><span>Average Confidence:</span> <strong>{formatPercent(summary().average_confidence, '0.0%')}</strong></p>
              <p><span>Available Reputation:</span> <strong>{formatRp(activity().available_reputation)}</strong></p>
              <p><span>Currently Staked:</span> <strong>{formatRp(activity().staked_reputation)}</strong></p>
            </div>
          </div>

          <div class="analytics-panel">
            <h3>Recent Predictions</h3>
            <Show when={recentPredictions().length > 0} fallback={<p class="analytics-empty-state">No predictions yet.</p>}>
              <div class="analytics-list">
                <For each={recentPredictions()}>
                  {(item) => (
                    <div class="analytics-list-row">
                      <div>
                        <div class="analytics-row-title">{item.event || `Event #${item.event_id}`}</div>
                        <div class="analytics-row-meta">
                          {item.prediction_value || '—'} · {Number(item.confidence || 0).toFixed(0)}% · {formatDate(item.created_at)}
                        </div>
                      </div>
                      <div class={`analytics-badge status-${String(summarizePredictionStatus(item)).toLowerCase()}`}>
                        {summarizePredictionStatus(item)}
                      </div>
                    </div>
                  )}
                </For>
              </div>
            </Show>
          </div>
        </div>

        <div class="analytics-panel">
          <h3>Open Positions</h3>
          <Show when={openPositions().length > 0} fallback={<p class="analytics-empty-state">No open positions.</p>}>
            <div class="analytics-list">
              <For each={openPositions()}>
                {(item) => (
                  <div class="analytics-list-row analytics-position-row">
                    <div>
                      <div class="analytics-row-title">{item.event_title}</div>
                      <div class="analytics-row-meta">
                        {item.exposure_label} · {item.quantity_label} · closes {formatDate(item.closing_date)}
                      </div>
                    </div>
                    <div class="analytics-position-stats">
                      <span>{formatRp(item.staked_rp)}</span>
                      <span>{formatPercent(Number(item.market_prob || 0) * 100, '—')}</span>
                    </div>
                  </div>
                )}
              </For>
            </div>
          </Show>
        </div>
      </Show>
    </Card>
  );
}
