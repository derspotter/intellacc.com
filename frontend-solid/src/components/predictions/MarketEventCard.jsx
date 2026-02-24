import { createSignal, createEffect, Show } from 'solid-js';
import { placeEventUpdate, sellEventShares } from '../../services/api';

const safeNumber = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const formatProbability = (value) => `${(safeNumber(value) * 100).toFixed(1)}%`;
const formatCurrency = (value) => `${safeNumber(value).toFixed(2)} RP`;

const getClosingDate = (closingDate) => {
  const parsed = new Date(closingDate || '');
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

export default function MarketEventCard(props) {
  const event = () => props.event || {};
  const position = () => props.position || null;
  const closingDate = () => getClosingDate(event().closing_date);
  const isClosed = () => {
    if (event().outcome) {
      return true;
    }
    const date = closingDate();
    if (!date) {
      return false;
    }
    return date.getTime() <= Date.now();
  };
  const isOpen = () => !isClosed();
  const closingLabel = () => {
    const date = closingDate();
    if (!date) {
      return 'No close date';
    }
    return date.toLocaleString();
  };

  const marketProb = () => safeNumber(event().market_prob, 0.5);
  const positionYes = () => safeNumber(position()?.yes_shares);
  const positionNo = () => safeNumber(position()?.no_shares);
  const hasPosition = () => positionYes() > 0 || positionNo() > 0;
  const currentValue = () => (positionYes() * marketProb()) + (positionNo() * (1 - marketProb()));

  const [direction, setDirection] = createSignal('yes');
  const [stake, setStake] = createSignal('');
  const [targetProb, setTargetProb] = createSignal(0.99);
  const [busyAction, setBusyAction] = createSignal('');
  const [resolveOutcome, setResolveOutcome] = createSignal('yes');
  const [resolving, setResolving] = createSignal(false);
  const [resolveMessage, setResolveMessage] = createSignal('');
  const [resolveError, setResolveError] = createSignal('');
  const [tradeMessage, setTradeMessage] = createSignal('');
  const [tradeError, setTradeError] = createSignal('');
  let messageTimer = null;

  const isBusy = () => Boolean(busyAction());
  const parsedTargetProb = () => safeNumber(targetProb(), direction() === 'yes' ? 0.99 : 0.01);
  const targetProbLabel = () => `${(parsedTargetProb() * 100).toFixed(1)}%`;
  const directionHint = () =>
    direction() === 'yes'
      ? 'Betting higher predicted probability (YES)'
      : 'Betting lower predicted probability (NO)';

  createEffect(() => {
    setTargetProb(direction() === 'yes' ? 0.99 : 0.01);
  });

  const closeMessage = () => {
    if (messageTimer) {
      clearTimeout(messageTimer);
    }
    messageTimer = setTimeout(() => {
      setTradeMessage('');
      setTradeError('');
      messageTimer = null;
    }, 4000);
  };

  const clearMessages = () => {
    setTradeMessage('');
    setTradeError('');
  };

  const runAfterTrade = async (resultEventId) => {
    setTradeMessage('Trade submitted. Market refreshed.');
    closeMessage();
    await props.onTrade?.(resultEventId);
  };

  const refreshIfNeeded = async (resultEventId) => {
    await runAfterTrade(resultEventId);
    setStake('');
  };

  const handleStake = async (eventObj) => {
    eventObj.preventDefault();
    clearMessages();

    const stakeValue = safeNumber(stake(), 0);
    if (!stakeValue || stakeValue <= 0) {
      setTradeError('Stake amount must be greater than zero.');
      return;
    }

    const eventId = event().id;
    if (!eventId) {
      setTradeError('Event not available.');
      return;
    }

    if (!isOpen()) {
      setTradeError('This market is not active.');
      return;
    }

    setBusyAction('stake');
    try {
      await placeEventUpdate(eventId, {
        stake: stakeValue,
        target_prob: parsedTargetProb()
      });
      await refreshIfNeeded(eventId);
    } catch (error) {
      setTradeError(error?.message || 'Failed to place stake.');
    } finally {
      setBusyAction('');
    }
  };

  const handleSell = async (shareType) => {
    clearMessages();
    const shares = shareType === 'yes' ? positionYes() : positionNo();
    if (!hasPosition()) {
      setTradeError('No position to sell.');
      return;
    }

    if (shares <= 0) {
      setTradeError(`No ${shareType.toUpperCase()} shares to sell.`);
      return;
    }

    const estimatedPayout = (shares * (shareType === 'yes' ? marketProb() : (1 - marketProb()))).toFixed(2);
    const confirmed = window.confirm(
      `Sell all ${shares.toFixed(2)} ${shareType.toUpperCase()} shares for approx ${estimatedPayout} RP?`
    );
    if (!confirmed) {
      return;
    }

    const eventId = event().id;
    if (!eventId) {
      setTradeError('Event not available.');
      return;
    }

    setBusyAction(`sell-${shareType}`);
    try {
      await sellEventShares(eventId, {
        share_type: shareType,
        amount: shares
      });
      await refreshIfNeeded(eventId);
    } catch (error) {
      setTradeError(error?.message || `Failed to sell ${shareType} shares.`);
    } finally {
      setBusyAction('');
    }
  };

  const clearResolveMessages = () => {
    setResolveMessage('');
    setResolveError('');
  };

  const handleResolve = async (value) => {
    const selectedOutcome = String(value || resolveOutcome()).toLowerCase();
    const eventId = event().id;
    if (!eventId) {
      setResolveError('Event not available.');
      return;
    }
    if (event().outcome) {
      setResolveError('This market is already resolved.');
      return;
    }

    if (!props.onResolve) {
      setResolveError('Resolve handler unavailable.');
      return;
    }

    setResolving(true);
    clearResolveMessages();
    try {
      await props.onResolve(eventId, selectedOutcome);
      setResolveMessage(`Market resolved as ${selectedOutcome.toUpperCase()}.`);
      await props.onTrade?.(eventId);
    } catch (error) {
      setResolveError(error?.message || 'Failed to resolve market.');
    } finally {
      setResolving(false);
    }
  };

  return (
    <article class="prediction-card market-event-card">
      <div class="prediction-card-header">
        <div class="prediction-card-title-block">
          <h3>{event().title || 'Untitled market'}</h3>
          <p class="prediction-event-meta">
            Closes: {closingLabel()}
          </p>
        </div>
        <Show when={event().outcome}>
          <span class="prediction-outcome">Outcome: {event().outcome}</span>
        </Show>
      </div>

      <p class="prediction-card-detail">{event().details || 'No details provided.'}</p>

      <div class="market-stats">
        <span>Current probability: <strong>{formatProbability(event().market_prob)}</strong></span>
        <span>Total staked: <strong>{formatCurrency(event().cumulative_stake || 0)}</strong></span>
      </div>

      <Show when={props.predicted}>
        <p class="prediction-outcome muted">You already submitted a forecast prediction for this market.</p>
      </Show>

      <Show when={hasPosition()}>
        <div class="position-summary">
          <p>
            Position: {positionYes().toFixed(2)} YES, {positionNo().toFixed(2)} NO
          </p>
          <p>Current value: {formatCurrency(currentValue())}</p>
          <div class="position-actions">
            <button
              type="button"
              class="post-action"
              onClick={() => handleSell('yes')}
              disabled={isBusy()}
            >
              {busyAction() === 'sell-yes' ? 'Selling...' : 'Sell Yes'}
            </button>
            <button
              type="button"
              class="post-action"
              onClick={() => handleSell('no')}
              disabled={isBusy()}
            >
              {busyAction() === 'sell-no' ? 'Selling...' : 'Sell No'}
            </button>
          </div>
        </div>
      </Show>

      <Show when={props.authenticated}>
        <Show when={isOpen()}>
          <form class="prediction-form market-trade-form" onSubmit={handleStake}>
        <label class="inline-field">
          <span>Direction</span>
          <div class="trade-direction">
            <button
              type="button"
                  class={`post-action ${direction() === 'no' ? 'active-trade-direction' : ''}`}
                  onClick={() => setDirection('no')}
                >
                  Bet NO
                </button>
                <button
                  type="button"
                  class={`post-action ${direction() === 'yes' ? 'active-trade-direction' : ''}`}
                  onClick={() => setDirection('yes')}
            >
              Bet YES
            </button>
          </div>
          <small class="muted">{directionHint()}</small>
        </label>

        <label class="inline-field">
          <span>Target probability: {targetProbLabel()}</span>
          <input
            class="probability-slider"
            type="range"
            min="0.01"
            max="0.99"
            step="0.01"
            value={targetProb()}
            onInput={(eventInput) => setTargetProb(eventInput.target.value)}
            disabled={isBusy()}
          />
        </label>

        <label class="inline-field">
          <span>Stake (RP)</span>
              <input
                type="number"
                min="0.01"
                step="0.01"
                value={stake()}
                onInput={(eventInput) => setStake(eventInput.target.value)}
                placeholder="Enter stake amount"
              />
            </label>

            <button
              type="submit"
              class="post-action"
              disabled={isBusy()}
            >
              {isBusy() ? 'Submitting...' : 'Place trade'}
            </button>
          </form>
        </Show>
        <Show when={!isOpen()}>
          <p class="muted">Market is closed or resolved.</p>
        </Show>
      </Show>
      <Show when={props.canResolve && !event().outcome}>
        <div class="market-resolve-controls">
          <p class="inline-field">Resolve market manually</p>
          <div class="trade-direction">
            <button
              type="button"
              class={`post-action ${resolveOutcome() === 'no' ? 'active-trade-direction' : ''}`}
              onClick={() => setResolveOutcome('no')}
              disabled={resolving()}
            >
              Resolve No
            </button>
            <button
              type="button"
              class={`post-action ${resolveOutcome() === 'yes' ? 'active-trade-direction' : ''}`}
              onClick={() => setResolveOutcome('yes')}
              disabled={resolving()}
            >
              Resolve Yes
            </button>
          </div>
          <button
            type="button"
            class="post-action"
            onClick={() => handleResolve(resolveOutcome())}
            disabled={resolving()}
          >
            {resolving() ? 'Resolving...' : 'Resolve market'}
          </button>
        </div>
      </Show>

      <Show when={tradeError()}>
        <p class="error">{tradeError()}</p>
      </Show>
      <Show when={tradeMessage()}>
        <p class="success">{tradeMessage()}</p>
      </Show>
      <Show when={resolveError()}>
        <p class="error">{resolveError()}</p>
      </Show>
      <Show when={resolveMessage()}>
        <p class="success">{resolveMessage()}</p>
      </Show>
    </article>
  );
}
