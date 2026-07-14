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
