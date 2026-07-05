import { createEffect, createSignal, For, Show } from 'solid-js';
import { getCurrentUserId } from '../../services/auth';
import { getToken } from '../../services/tokenService';
import {
  getMarketState,
  getUserPositions,
  placeOutcomeUpdate,
  sellOutcomeShares
} from '../../services/api';
import { ApiError } from '../../services/api';
import {
  safeNumber,
  formatProbability,
  formatCurrency,
  toDate,
  toShortDate,
  isPhoneVerificationMessage,
  getProbabilityColor
} from './marketCardShared';

const formatOutcomeLabel = (outcome) => {
  const lower = outcome?.lower_bound;
  const upper = outcome?.upper_bound;
  if (Number.isFinite(Number(lower)) && Number.isFinite(Number(upper))) {
    return `${Number(lower)} – ${Number(upper)}`;
  }
  return outcome?.label || 'Outcome';
};

// Trading card for multiple_choice / numeric (bucketed) markets.
// Select an outcome from the list, then buy or sell in the panel below.
export default function OutcomeMarketCard(props) {
  const event = () => props.event || {};
  const hideTitle = props.hideTitle || false;
  const onTrade = () => props.onTrade || props.onStakeUpdate;
  const isLoggedIn = () => !!getToken();
  const eventId = () => event().id;

  const isClosed = () => {
    if (event().outcome) return true;
    const date = toDate(event().closing_date);
    return !!(date && date.getTime() <= Date.now());
  };
  const isOpen = () => !isClosed();

  const [outcomes, setOutcomes] = createSignal([]);
  const [marketLoadState, setMarketLoadState] = createSignal('loading'); // loading | ready | error | unconfigured
  const [selectedOutcomeId, setSelectedOutcomeId] = createSignal(null);
  const [stakeAmount, setStakeAmount] = createSignal('');
  const [positionRows, setPositionRows] = createSignal([]);
  const [busyAction, setBusyAction] = createSignal('');
  const [error, setError] = createSignal('');
  const [tradeMessage, setTradeMessage] = createSignal('');

  let lastEventId = '';

  const closeMessages = () => {
    setError('');
    setTradeMessage('');
  };

  const setVerificationMessage = (message, options = {}) => {
    const normalized = message || '';
    const isVerification = options.requiredTier === 2 || isPhoneVerificationMessage(normalized);
    if (isVerification && props.onVerificationNotice) {
      props.onVerificationNotice(normalized);
    }
    setError(normalized);
  };

  const emitSuccess = (value) => {
    props.onVerificationNotice?.('');
    setTradeMessage(value);
  };

  const selectedOutcome = () =>
    outcomes().find((o) => String(o.outcome_id) === String(selectedOutcomeId())) || null;

  const sharesInOutcome = (outcomeId) => {
    const row = positionRows().find((r) => String(r.outcome_id) === String(outcomeId));
    return safeNumber(row?.outcome_shares);
  };

  const totalStaked = () =>
    positionRows().reduce((acc, row) => acc + safeNumber(row.outcome_staked_rp), 0);

  const positionValue = () =>
    positionRows().reduce((acc, row) => {
      const outcome = outcomes().find((o) => String(o.outcome_id) === String(row.outcome_id));
      return acc + safeNumber(row.outcome_shares) * safeNumber(outcome?.prob);
    }, 0);

  const hasPosition = () => positionRows().some((row) => safeNumber(row.outcome_shares) > 0);

  const loadMarketState = async () => {
    if (!eventId()) return;
    setMarketLoadState('loading');
    try {
      const state = await getMarketState(eventId());
      const rows = Array.isArray(state?.outcomes) ? state.outcomes : [];
      if (rows.length < 2) {
        setOutcomes([]);
        setMarketLoadState('unconfigured');
        return;
      }
      setOutcomes(rows);
      setMarketLoadState('ready');
      if (!rows.some((o) => String(o.outcome_id) === String(selectedOutcomeId()))) {
        setSelectedOutcomeId(rows[0].outcome_id);
      }
    } catch (err) {
      setOutcomes([]);
      setMarketLoadState('error');
    }
  };

  const loadPositions = async () => {
    if (!isLoggedIn()) {
      setPositionRows([]);
      return;
    }
    const currentUserId = getCurrentUserId();
    if (!currentUserId || !eventId()) {
      setPositionRows([]);
      return;
    }
    try {
      const positions = await getUserPositions(currentUserId);
      if (!Array.isArray(positions)) {
        setPositionRows([]);
        return;
      }
      setPositionRows(positions.filter(
        (row) => String(row.event_id) === String(eventId()) && row.outcome_id != null
      ));
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) {
        setVerificationMessage(err.message, { requiredTier: err.data?.required_tier });
      }
      setPositionRows([]);
    }
  };

  const applyTradeResult = (result) => {
    if (Array.isArray(result?.outcomes) && result.outcomes.length > 0) {
      setOutcomes(result.outcomes);
    }
  };

  const handleBuy = async (eventObj) => {
    eventObj?.preventDefault?.();
    if (!isOpen()) {
      setError('Market is closed or resolved.');
      return;
    }
    if (!isLoggedIn()) {
      setVerificationMessage('Please log in first.');
      return;
    }
    const outcome = selectedOutcome();
    if (!outcome) {
      setError('Select an outcome first.');
      return;
    }
    const amount = safeNumber(stakeAmount(), 0);
    if (!amount || amount <= 0) {
      setError('Stake amount must be greater than zero.');
      return;
    }

    closeMessages();
    setBusyAction('buy');
    try {
      const result = await placeOutcomeUpdate(eventId(), {
        stake: amount,
        outcome_id: Number(outcome.outcome_id)
      });
      applyTradeResult(result);
      await loadPositions();
      setStakeAmount('');
      emitSuccess(`Bought ${safeNumber(result?.shares_acquired).toFixed(2)} shares of "${formatOutcomeLabel(outcome)}".`);
      await onTrade()?.(eventId());
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) {
        setVerificationMessage(err.message || 'Verification required to place trade.', {
          requiredTier: err.data?.required_tier
        });
      } else {
        setError(err?.message || 'Failed to place stake.');
      }
    } finally {
      setBusyAction('');
    }
  };

  const handleSell = async () => {
    if (!isOpen()) {
      setError('Market is closed or resolved.');
      return;
    }
    const outcome = selectedOutcome();
    if (!outcome) {
      setError('Select an outcome first.');
      return;
    }
    const held = sharesInOutcome(outcome.outcome_id);
    if (held <= 0) {
      setError('No shares to sell in the selected outcome.');
      return;
    }

    const estimated = held * safeNumber(outcome.prob);
    const ok = window.confirm(
      `Confirm sale:\n\n` +
      `Sell ${held.toFixed(2)} shares of "${formatOutcomeLabel(outcome)}"\n` +
      `Estimated payout: ${estimated.toFixed(2)} RP\n\n` +
      `Do you want to proceed?`
    );
    if (!ok) return;

    closeMessages();
    setBusyAction('sell');
    try {
      const result = await sellOutcomeShares(eventId(), {
        outcome_id: Number(outcome.outcome_id),
        amount: held
      });
      applyTradeResult(result);
      await loadPositions();
      emitSuccess(`Sold ${held.toFixed(2)} shares for ${safeNumber(result?.payout).toFixed(2)} RP.`);
      await onTrade()?.(eventId());
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) {
        setVerificationMessage(err.message || 'Verification required to sell shares.', {
          requiredTier: err.data?.required_tier
        });
      } else {
        setError(err?.message || 'Failed to sell shares.');
      }
    } finally {
      setBusyAction('');
    }
  };

  createEffect(() => {
    const nextId = String(eventId());
    if (nextId !== lastEventId) {
      lastEventId = nextId;
      setSelectedOutcomeId(null);
      void loadMarketState();
      if (isLoggedIn()) {
        void loadPositions();
      } else {
        setPositionRows([]);
      }
    }
  });

  return (
    <div class="event-card outcome-market-card">
      <div style={{ flex: '1 1 auto' }}>
        <Show when={!hideTitle}>
          <div class="event-header">
            <h3 class="event-title">{event().title || 'Untitled market'}</h3>
            <div class="event-meta">
              <span class="event-category">{event().category || 'General'}</span>
              <span class="event-closing">{`Closes: ${toShortDate(event().closing_date)}`}</span>
            </div>
          </div>
        </Show>

        <div class="market-state">
          <div class="market-stats">
            <div class="stat">
              <span class="stat-label">Event Type:</span>
              <span class="stat-value">{event().event_type === 'numeric' ? 'numeric buckets' : 'multiple choice'}</span>
            </div>
            <div class="stat">
              <span class="stat-label">Total RP Staked:</span>
              <span class="stat-value">{formatCurrency(Math.max(0, safeNumber(event().cumulative_stake)), { includeSymbol: false })}</span>
            </div>
          </div>
        </div>

        <Show when={props?.predicted}>
          <p class="prediction-outcome muted">You already submitted a forecast prediction for this market.</p>
        </Show>

        <Show when={marketLoadState() === 'loading'}>
          <p class="muted">Loading outcomes...</p>
        </Show>

        <Show when={marketLoadState() === 'error'}>
          <div class="outcome-market-degraded">
            <p class="muted">Prices unavailable.</p>
            <button type="button" class="button" onClick={() => void loadMarketState()}>Retry</button>
          </div>
        </Show>

        <Show when={marketLoadState() === 'unconfigured'}>
          <p class="muted">This market's outcomes are not configured yet. Trading opens once they are.</p>
        </Show>

        <Show when={marketLoadState() === 'ready'}>
          <div class="outcome-list" role="radiogroup" aria-label="Market outcomes">
            <For each={outcomes()}>
              {(outcome) => (
                <button
                  type="button"
                  class={`outcome-row ${String(selectedOutcomeId()) === String(outcome.outcome_id) ? 'selected' : ''}`}
                  role="radio"
                  aria-checked={String(selectedOutcomeId()) === String(outcome.outcome_id)}
                  onClick={() => setSelectedOutcomeId(outcome.outcome_id)}
                  disabled={!!busyAction()}
                >
                  <span class="outcome-label">{formatOutcomeLabel(outcome)}</span>
                  <span class="outcome-meta">
                    <Show when={sharesInOutcome(outcome.outcome_id) > 0}>
                      <span class="outcome-user-shares">{`${sharesInOutcome(outcome.outcome_id).toFixed(2)} sh`}</span>
                    </Show>
                    <span class="outcome-prob" style={{ color: getProbabilityColor(outcome.prob) }}>
                      {formatProbability(outcome.prob)}
                    </span>
                  </span>
                </button>
              )}
            </For>
          </div>

          <Show when={isOpen()} fallback={<p class="muted">Market is closed or resolved.</p>}>
            <Show when={isLoggedIn()} fallback={
              <div class="login-prompt">
                <p>Log in to trade outcomes in this market</p>
                <button type="button" class="button" onClick={() => { window.location.hash = 'login'; }}>
                  Log In
                </button>
              </div>
            }>
              <form class="betting-form outcome-trade-panel" onSubmit={handleBuy}>
                <div class="outcome-trade-summary">
                  <Show when={selectedOutcome()} fallback={<span class="muted">Select an outcome above.</span>}>
                    <span>
                      {`Trading: ${formatOutcomeLabel(selectedOutcome())} @ ${formatProbability(selectedOutcome()?.prob)}`}
                    </span>
                  </Show>
                </div>
                <div class="form-row horizontal-row">
                  <div class="form-field">
                    <label for={`outcome-stake-${eventId()}`}>Stake Amount (RP):</label>
                    <input
                      id={`outcome-stake-${eventId()}`}
                      class="stake-input"
                      type="number"
                      min="0.01"
                      step="0.01"
                      placeholder="Enter stake amount"
                      value={stakeAmount()}
                      onInput={(e) => setStakeAmount(e.target.value)}
                    />
                  </div>
                  <div class="form-actions outcome-trade-actions">
                    <button
                      type="submit"
                      class="button primary"
                      disabled={!stakeAmount() || !selectedOutcome() || !!busyAction()}
                    >
                      {busyAction() === 'buy' ? 'Buying...' : 'Buy'}
                    </button>
                    <button
                      type="button"
                      class="button secondary"
                      onClick={() => void handleSell()}
                      disabled={!selectedOutcome() || sharesInOutcome(selectedOutcomeId()) <= 0 || !!busyAction()}
                    >
                      {busyAction() === 'sell'
                        ? 'Selling...'
                        : `Sell (${sharesInOutcome(selectedOutcomeId()).toFixed(2)})`}
                    </button>
                  </div>
                </div>
              </form>
            </Show>
          </Show>
        </Show>
      </div>

      <div style={{ flex: '0 0 auto', marginTop: 'auto' }}>
        <Show when={hasPosition()}>
          <div class="user-position">
            <div class="position-stats">
              <div class="stat">
                <span class="stat-label">Your Stake:</span>
                <span class="stat-value">{formatCurrency(totalStaked())}</span>
              </div>
              <div class="stat">
                <span class="stat-label">Position Value:</span>
                <span class="stat-value">{formatCurrency(positionValue())}</span>
              </div>
              <div class="stat">
                <span class="stat-label">Unrealized P&L:</span>
                <span class={`stat-value ${positionValue() - totalStaked() >= 0 ? 'positive' : 'negative'}`}>
                  {formatCurrency(positionValue() - totalStaked())}
                </span>
              </div>
            </div>
          </div>
        </Show>

        <Show when={tradeMessage()}>
          <p class="success">{tradeMessage()}</p>
        </Show>
        <Show when={error()}>
          <p class="error-message">{error()}</p>
        </Show>
      </div>
    </div>
  );
}
