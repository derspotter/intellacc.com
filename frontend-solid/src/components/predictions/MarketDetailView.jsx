import { For, Show, createEffect, createMemo, createSignal } from 'solid-js';
import { api } from '../../services/api';
import MarketEventCard from './MarketEventCard';
import OutcomeMarketCard from './OutcomeMarketCard';
import { formatProbability } from './marketCardShared';

const TRADES_LIMIT = 200;
const ACTIVITY_COUNT = 15;

const isMultiOutcome = (eventItem) =>
  ['multiple_choice', 'numeric'].includes(eventItem?.event_type);

const formatDate = (value) => {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return 'No date';
  return parsed.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
};

const formatTradeTime = (value) => {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return '';
  return parsed.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
};

export default function MarketDetailView(props) {
  const [event, setEvent] = createSignal(null);
  const [trades, setTrades] = createSignal([]);
  const [loading, setLoading] = createSignal(true);
  const [notFound, setNotFound] = createSignal(false);

  const loadAll = async (id) => {
    let row = null;
    try {
      row = await api.events.getById(id);
    } catch {
      row = null;
    }
    if (!row?.id) {
      setNotFound(true);
      setEvent(null);
      setTrades([]);
      return;
    }
    setNotFound(false);
    setEvent(row);
    try {
      const response = await api.events.getTrades(id, TRADES_LIMIT);
      setTrades(Array.isArray(response?.trades) ? response.trades : []);
    } catch {
      setTrades([]);
    }
  };

  createEffect(() => {
    const id = String(props.marketId || '').trim();
    if (!/^\d+$/.test(id)) {
      setNotFound(true);
      setLoading(false);
      return;
    }
    setLoading(true);
    void loadAll(id).finally(() => setLoading(false));
  });

  const handleTradeRefresh = () => {
    void loadAll(String(props.marketId || '').trim());
  };

  const prob = () => Number(event()?.market_prob ?? 0.5);

  const activity = createMemo(() => trades().slice(0, ACTIVITY_COUNT));

  // Probability history as an SVG step line. Binary markets only —
  // market_updates has no per-outcome history for multi-outcome events.
  const CHART_W = 640;
  const CHART_H = 180;
  const CHART_PAD = 10;

  const chartPoints = createMemo(() => {
    const row = event();
    if (!row || isMultiOutcome(row)) return null;

    const history = trades()
      .filter((trade) => trade.market_type !== 'multi_outcome')
      .map((trade) => ({
        t: Date.parse(trade.timestamp),
        p: Number(trade.price_after),
        before: Number(trade.price_before)
      }))
      .filter((point) => Number.isFinite(point.t) && Number.isFinite(point.p))
      .sort((a, b) => a.t - b.t);
    if (history.length < 2) return null;

    // Anchor at the earliest trade's starting price, extend to now at the
    // current market probability.
    const series = [
      { t: history[0].t, p: history[0].before },
      ...history.map(({ t, p }) => ({ t, p })),
      { t: Date.now(), p: Number(row.market_prob ?? 0.5) }
    ];

    const t0 = series[0].t;
    const span = Math.max(series[series.length - 1].t - t0, 1);
    const toX = (t) => CHART_PAD + ((t - t0) / span) * (CHART_W - 2 * CHART_PAD);
    const toY = (p) => CHART_PAD + (1 - Math.min(Math.max(p, 0), 1)) * (CHART_H - 2 * CHART_PAD);

    // Step line: hold each probability until the next trade.
    const coords = [];
    let prevY = null;
    for (const point of series) {
      const x = toX(point.t);
      const y = toY(point.p);
      if (prevY !== null) coords.push(`${x.toFixed(1)},${prevY}`);
      prevY = y.toFixed(1);
      coords.push(`${x.toFixed(1)},${prevY}`);
    }
    return coords.join(' ');
  });

  const gridY = (p) => CHART_PAD + (1 - p) * (CHART_H - 2 * CHART_PAD);

  const categoryLabel = () =>
    (event()?.topics || []).length > 0
      ? event().topics.join(' · ')
      : (event()?.category || 'General');

  return (
    <section class="market-detail">
      <a class="market-detail-back" href="#predictions/markets">← Back to markets</a>

      <Show when={loading()}>
        <div class="events-loading">
          <div class="loading-spinner" />
          <p>Loading market...</p>
        </div>
      </Show>

      <Show when={!loading() && notFound()}>
        <div class="no-events">
          <h3>Market not found</h3>
          <p>This market does not exist or is no longer available.</p>
        </div>
      </Show>

      <Show when={!loading() && !notFound() && event()}>
        <header class="market-detail-header">
          <div class="market-detail-title-row">
            <h2 class="market-detail-title">{event().title}</h2>
            <span class="market-detail-prob">{formatProbability(event().market_prob)}</span>
          </div>
          <div class="event-prob-bar" aria-hidden="true">
            <div class="event-prob-bar-fill" style={{ width: `${Math.round(prob() * 100)}%` }} />
          </div>
          <div class="market-detail-meta">
            <span class="event-category">{categoryLabel()}</span>
            <span class="event-date">{`Closes: ${formatDate(event().closing_date)}`}</span>
            <Show when={event().outcome}>
              <span class="event-resolved">Resolved</span>
            </Show>
          </div>
        </header>

        <Show when={String(event().details || '').trim()}>
          <div class="market-detail-description">{event().details}</div>
        </Show>

        <Show when={chartPoints()}>
          <div class="market-detail-chart">
            <h3>Probability history</h3>
            <div class="market-detail-chart-body">
              <div class="chart-y-labels" aria-hidden="true">
                <span>100%</span>
                <span>50%</span>
                <span>0%</span>
              </div>
              <svg
                viewBox={`0 0 ${CHART_W} ${CHART_H}`}
                preserveAspectRatio="none"
                role="img"
                aria-label="Market probability over time"
              >
                <line class="chart-grid" x1={CHART_PAD} y1={gridY(0.75)} x2={CHART_W - CHART_PAD} y2={gridY(0.75)} />
                <line class="chart-grid" x1={CHART_PAD} y1={gridY(0.5)} x2={CHART_W - CHART_PAD} y2={gridY(0.5)} />
                <line class="chart-grid" x1={CHART_PAD} y1={gridY(0.25)} x2={CHART_W - CHART_PAD} y2={gridY(0.25)} />
                <polyline class="chart-line" points={chartPoints()} />
              </svg>
            </div>
          </div>
        </Show>

        <div class="market-detail-trade">
          <Show
            when={isMultiOutcome(event())}
            fallback={
              <MarketEventCard
                event={event()}
                onTrade={handleTradeRefresh}
                onVerificationNotice={props.onVerificationNotice}
                hideTitle={true}
              />
            }
          >
            <OutcomeMarketCard
              event={event()}
              onTrade={handleTradeRefresh}
              onVerificationNotice={props.onVerificationNotice}
              hideTitle={true}
            />
          </Show>
        </div>

        <Show when={activity().length > 0}>
          <div class="market-detail-activity">
            <h3>Recent activity</h3>
            <ul>
              <For each={activity()}>
                {(trade) => (
                  <li class="market-detail-trade-row">
                    <span class="trade-user">{trade.user}</span>
                    <span class="trade-direction">{trade.direction}</span>
                    <span class="trade-amount">{`${Number(trade.amount).toFixed(2)} RP`}</span>
                    <span class="trade-move">
                      {`${formatProbability(trade.price_before)} → ${formatProbability(trade.price_after)}`}
                    </span>
                    <span class="trade-time">{formatTradeTime(trade.timestamp)}</span>
                  </li>
                )}
              </For>
            </ul>
          </div>
        </Show>
      </Show>
    </section>
  );
}
