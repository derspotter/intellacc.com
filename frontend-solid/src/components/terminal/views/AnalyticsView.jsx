import { createEffect, createSignal, For, Show } from 'solid-js';
import { getPredictionAnalyticsDashboard } from '../../../services/api';
import { isAuthenticated } from '../../../services/auth';

const fmtInt = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString() : '--';
};

const fmtPercent = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n.toFixed(1) : '--';
};

const fmtRP = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n.toFixed(2) : '--';
};

const fmtDate = (dateStr) => {
  if (!dateStr) return '--';
  try {
    return new Date(dateStr).toLocaleDateString();
  } catch {
    return '--';
  }
};

const StatTile = (props) => (
  <div class="bg-bb-panel border border-bb-border p-2">
    <div class="text-xxs text-bb-muted">{props.label}</div>
    <div class="text-lg font-bold text-bb-accent">{props.value}</div>
  </div>
);

export default function AnalyticsView() {
  const [data, setData] = createSignal(null);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal('');

  let loadEpoch = 0;

  const refresh = () => {
    setLoading(true);
    setError('');
    const epoch = ++loadEpoch;
    getPredictionAnalyticsDashboard()
      .then((result) => {
        if (epoch !== loadEpoch) return;
        setData(result || {});
      })
      .catch((e) => {
        if (epoch !== loadEpoch) return;
        setError(e?.message || 'FAILED TO LOAD ANALYTICS');
        setData({});
      })
      .finally(() => {
        if (epoch === loadEpoch) setLoading(false);
      });
  };

  createEffect(() => {
    if (isAuthenticated()) {
      refresh();
    }
  });

  return (
    <div class="h-full flex flex-col font-mono text-sm">
      {/* Auth Gate */}
      <Show when={!isAuthenticated()}>
        <div class="flex-1 flex items-center justify-center">
          <div class="text-center p-4">
            <div class="text-bb-muted mb-2">SIGN IN TO VIEW ANALYTICS</div>
          </div>
        </div>
      </Show>

      {/* Authenticated Content */}
      <Show when={isAuthenticated()}>
        {/* Header with Refresh Button */}
        <div class="shrink-0 flex items-center justify-between border-b border-bb-border bg-bb-panel px-4 py-2">
          <div class="text-xs text-bb-muted uppercase font-bold">[ANALYTICS]</div>
          <button
            type="button"
            disabled={loading()}
            onClick={refresh}
            class="px-2 py-1 text-xs border border-bb-border text-bb-muted hover:text-bb-accent hover:border-bb-accent disabled:opacity-50 uppercase font-bold"
          >
            [REFRESH]
          </button>
        </div>

        <div class="flex-1 overflow-y-auto custom-scrollbar p-4 space-y-4">
          <Show when={error()}>
            <div class="p-2 border border-market-down/50 bg-market-down/10 text-market-down text-xs">
              ERROR // {error().toUpperCase()}
            </div>
          </Show>

          <Show when={data()}>
            {/* SUMMARY Section */}
            <div>
              <div class="text-bb-accent font-bold uppercase text-xs border-b border-bb-border pb-1 mb-2">[SUMMARY]</div>
              <div data-testid="analytics-summary" class="grid grid-cols-2 md:grid-cols-3 gap-2">
                <StatTile
                  label="TOTAL PREDICTIONS"
                  value={fmtInt(data()?.summary?.total_predictions)}
                />
                <StatTile
                  label="ACCURACY"
                  value={`${fmtPercent(data()?.summary?.accuracy_percent)}%`}
                />
                <StatTile
                  label="PENDING"
                  value={fmtInt(data()?.summary?.pending_predictions)}
                />
                <StatTile
                  label="RESOLVED"
                  value={fmtInt(data()?.summary?.resolved_predictions)}
                />
                <StatTile
                  label="CORRECT"
                  value={fmtInt(data()?.summary?.correct_predictions)}
                />
                <StatTile
                  label="INCORRECT"
                  value={fmtInt(data()?.summary?.incorrect_predictions)}
                />
              </div>
            </div>

            {/* ACTIVITY Section */}
            <Show when={data()?.activity}>
              <div>
                <div class="text-bb-accent font-bold uppercase text-xs border-b border-bb-border pb-1 mb-2">[ACTIVITY]</div>
                <div class="grid grid-cols-2 md:grid-cols-3 gap-2">
                  <StatTile
                    label="ACTIVE MARKETS"
                    value={fmtInt(data()?.activity?.active_markets)}
                  />
                  <StatTile
                    label="OPEN POSITIONS"
                    value={fmtInt(data()?.activity?.open_positions)}
                  />
                  <StatTile
                    label="STAKED (30D)"
                    value={fmtRP(data()?.activity?.staked_last_30d)}
                  />
                  <StatTile
                    label="AVAILABLE"
                    value={fmtRP(data()?.activity?.available_reputation)}
                  />
                  <StatTile
                    label="STAKED"
                    value={fmtRP(data()?.activity?.staked_reputation)}
                  />
                </div>
              </div>
            </Show>

            {/* RECENT PREDICTIONS Section */}
            <Show when={data()?.recent_predictions && data()?.recent_predictions.length > 0}>
              <div>
                <div class="text-bb-accent font-bold uppercase text-xs border-b border-bb-border pb-1 mb-2">
                  [RECENT PREDICTIONS]
                </div>
                <div class="space-y-1">
                  <For each={data()?.recent_predictions || []}>
                    {(pred) => (
                      <div class="flex justify-between gap-3 py-1 border-b border-bb-border/20 text-xs">
                        <span class="truncate text-bb-text">{pred.event || `EVENT ${pred.event_id || '--'}`}</span>
                        <span class="text-bb-muted shrink-0">{fmtPercent(pred.prediction_value)}%</span>
                        <span class="text-bb-muted shrink-0">{fmtPercent(pred.confidence)}%</span>
                        <span class="text-bb-muted shrink-0 uppercase">{pred.outcome || 'PENDING'}</span>
                      </div>
                    )}
                  </For>
                </div>
              </div>
            </Show>

            {/* OPEN POSITIONS Section */}
            <Show when={data()?.open_positions && data()?.open_positions.length > 0}>
              <div>
                <div class="text-bb-accent font-bold uppercase text-xs border-b border-bb-border pb-1 mb-2">
                  [OPEN POSITIONS]
                </div>
                <div class="space-y-1">
                  <For each={data()?.open_positions || []}>
                    {(pos) => (
                      <div class="flex justify-between gap-3 py-1 border-b border-bb-border/20 text-xs">
                        <span class="truncate text-bb-text">{pos.event_title || '--'}</span>
                        <span class="text-bb-muted shrink-0">{pos.exposure_label || '--'}</span>
                        <span class="text-bb-muted shrink-0">{fmtRP(pos.staked_rp)} RP</span>
                        <span class="text-bb-muted shrink-0">{fmtPercent(pos.market_prob)}%</span>
                      </div>
                    )}
                  </For>
                </div>
              </div>
            </Show>

            {/* PERSUASION Section */}
            <Show when={data()?.persuasion}>
              <div>
                <div class="text-bb-accent font-bold uppercase text-xs border-b border-bb-border pb-1 mb-2">
                  [PERSUASION]
                </div>
                <div class="grid grid-cols-2 md:grid-cols-3 gap-2 mb-3">
                  <StatTile
                    label="REWARD POOL"
                    value={fmtRP(data()?.persuasion?.reward_rp)}
                  />
                  <StatTile
                    label="REWARDED POSTS"
                    value={fmtInt(data()?.persuasion?.rewarded_posts)}
                  />
                  <StatTile
                    label="EPISODE"
                    value={fmtInt(data()?.persuasion?.episode_count)}
                  />
                </div>

                <Show when={data()?.persuasion?.recent_payouts && data()?.persuasion?.recent_payouts.length > 0}>
                  <div class="text-bb-muted text-xxs uppercase mb-2">Recent Payouts</div>
                  <div class="space-y-1">
                    <For each={data()?.persuasion?.recent_payouts || []}>
                      {(payout) => (
                        <div class="flex justify-between gap-3 py-1 border-b border-bb-border/20 text-xs text-bb-muted">
                          <span class="truncate">{payout.post_title || 'Payout'}</span>
                          <span class="shrink-0">{fmtDate(payout.payout_date)}</span>
                          <span class="shrink-0">{fmtRP(payout.amount)} RP</span>
                        </div>
                      )}
                    </For>
                  </div>
                </Show>
              </div>
            </Show>
          </Show>
        </div>
      </Show>
    </div>
  );
}
