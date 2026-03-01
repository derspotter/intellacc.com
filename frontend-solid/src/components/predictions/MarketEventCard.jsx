import { createEffect, createSignal, Show } from 'solid-js';
import { getCurrentUserId } from '../../services/auth';
import { getToken } from '../../services/tokenService';
import {
  getUserPositions,
  sellEventShares,
  placeEventUpdate
} from '../../services/api';
import { ApiError } from '../../services/api';

const safeNumber = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const formatProbability = (value) => `${(safeNumber(value, 0.5) * 100).toFixed(1)}%`;
const formatCurrency = (value, { includeSymbol = true } = {}) => {
  const formatted = safeNumber(value).toFixed(2);
  return includeSymbol ? `${formatted} RP` : formatted;
};

const toDate = (value) => {
  const parsed = new Date(value || '');
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return parsed;
};

const toShortDate = (value) => {
  const parsed = toDate(value);
  if (!parsed) {
    return 'No date';
  }
  return parsed.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
};

const isPhoneVerificationMessage = (message) =>
  typeof message === 'string' && message.toLowerCase().includes('verify your phone');

const getProbabilityColor = (probability) => {
  const prob = safeNumber(probability, 0.5);
  const red = Math.round(prob * 255);
  const blue = Math.round((1 - prob) * 255);
  return `color: rgb(${red}, 0, ${blue})`;
};

const getKellyEdge = (belief, currentProb) =>
  (safeNumber(belief, 0.5) - safeNumber(currentProb, 0.5));

export default function MarketEventCard(props) {
  const event = () => props.event || {};
  const hideTitle = props.hideTitle || false;
  const onTrade = () => props.onTrade || props.onStakeUpdate;
  const isLoggedIn = () => !!getToken();

  const eventId = () => event().id;
  const isClosed = () => {
    const date = toDate(event().closing_date);
    if (event().outcome) {
      return true;
    }
    return !!(date && date.getTime() <= Date.now());
  };
  const isOpen = () => !isClosed();

  const [stakeAmount, setStakeAmount] = createSignal('');
  const [beliefProb, setBeliefProb] = createSignal(0.7);
  const [direction, setDirection] = createSignal('yes');
  const [position, setPosition] = createSignal(null);
  const [marketState, setMarketState] = createSignal({
    market_prob: safeNumber(event().market_prob, 0.5),
    cumulative_stake: safeNumber(event().cumulative_stake, 0),
    liquidity_b: safeNumber(event().liquidity_b, 5000),
  });
  const [, setPositionLoading] = createSignal(false);
  const [kellyData, setKellyData] = createSignal(null);
  const [, setKellyLoading] = createSignal(false);
  const [busyAction, setBusyAction] = createSignal('');
  const [error, setError] = createSignal('');
  const [isVerificationError, setIsVerificationError] = createSignal(false);
  const [tradeMessage, setTradeMessage] = createSignal('');
  const [resolveOutcome, setResolveOutcome] = createSignal('yes');
  const [resolving, setResolving] = createSignal(false);
  const [resolveMessage, setResolveMessage] = createSignal('');
  const [resolveError, setResolveError] = createSignal('');
  const [stakeInputRef, setStakeInputRef] = createSignal(null);

  let kellyTimeout;
  let lastEventId = '';

  const closeMessages = () => {
    setError('');
    setIsVerificationError(false);
    setTradeMessage('');
    setResolveMessage('');
    setResolveError('');
  };

  const setVerificationMessage = (message, options = {}) => {
    const normalized = message || '';
    const isVerification = options.requiredTier === 2 || isPhoneVerificationMessage(normalized);
    if (isVerification && props.onVerificationNotice) {
      props.onVerificationNotice(normalized);
    }
    setError(normalized);
    setIsVerificationError(isVerification);
  };

  const emitSuccess = (value) => {
    props.onVerificationNotice?.('');
    setTradeMessage(value);
  };

  const clearPosition = () => setPosition(null);

  const normalizePosition = (rawPosition) => {
    if (!rawPosition) return null;
    const yesShares = safeNumber(rawPosition.yes_shares);
    const noShares = safeNumber(rawPosition.no_shares);
    if (yesShares <= 0 && noShares <= 0) {
      return null;
    }

    const marketProb = safeNumber(marketState().market_prob, safeNumber(event().market_prob, 0.5));
    const totalStaked = safeNumber(rawPosition.total_staked) || (
      yesShares * marketProb + noShares * (1 - marketProb)
    );
    const unrealizedPnl = (yesShares * marketProb + noShares * (1 - marketProb)) - totalStaked;

    return {
      yes_shares: yesShares,
      no_shares: noShares,
      total_staked: safeNumber(rawPosition.total_staked, totalStaked),
      unrealized_pnl: safeNumber(rawPosition.unrealized_pnl, unrealizedPnl),
    };
  };

  const loadUserPosition = async () => {
    if (!isLoggedIn()) {
      clearPosition();
      return;
    }

    const currentUserId = getCurrentUserId();
    if (!currentUserId || !eventId()) {
      clearPosition();
      return;
    }

    setPositionLoading(true);
    try {
      const positions = await getUserPositions(currentUserId);
      if (!Array.isArray(positions)) {
        setError('');
        clearPosition();
        return;
      }

      const matching = positions.find((candidate) =>
        String(candidate.event_id) === String(eventId())
      );
      setPosition(normalizePosition(matching));
      emitSuccess('');
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) {
        setVerificationMessage(err.message, { requiredTier: err.data?.required_tier });
      } else {
        setError(err?.message || 'Failed to load your position.');
      }
      clearPosition();
    } finally {
      setPositionLoading(false);
    }
  };

  const loadKellySuggestion = async (belief) => {
    if (!isLoggedIn() || !eventId()) {
      return;
    }

    setKellyLoading(true);
    try {
      const response = await fetch(`/api/events/${eventId()}/kelly?belief=${encodeURIComponent(belief)}`, {
        headers: { Authorization: `Bearer ${getToken()}` }
      });

      if (response.ok) {
        const data = await response.json();
        const currentProb = safeNumber(marketState().market_prob, safeNumber(event().market_prob, 0.5));
        const edge = getKellyEdge(belief, currentProb);
        setKellyData({
          kelly_optimal: safeNumber(data.kelly_suggestion),
          quarter_kelly: safeNumber(data.quarter_kelly),
          kelly_growth: safeNumber(data.expected_log_growth),
          edge,
          balance: safeNumber(data.balance, 1000),
          current_prob: currentProb
        });
      } else if (response.status === 403) {
        const error = await response.json().catch(() => ({
          message: 'Verification required to load Kelly suggestion.'
        }));
        setVerificationMessage(error.message || 'Verification required to load Kelly suggestion.', {
          requiredTier: error.required_tier
        });
      } else {
        throw new Error(`Kelly suggestion request failed: ${response.status}`);
      }
    } catch (err) {
      const fallbackBalance = 1000;
      const currentProb = safeNumber(marketState().market_prob, safeNumber(event().market_prob, 0.5));
      const edge = getKellyEdge(belief, currentProb);
      const fallback = Math.max(0, Math.abs(edge) * fallbackBalance * 0.25);
      setKellyData({
        kelly_optimal: fallback,
        quarter_kelly: fallback * 0.25,
        edge,
        balance: fallbackBalance,
        kelly_growth: edge * 0.1,
        current_prob: currentProb
      });
    } finally {
      setKellyLoading(false);
    }
  };

  const formatDate = (dateString) => {
    const date = new Date(dateString);
    if (Number.isNaN(date.getTime())) {
      return toShortDate(dateString);
    }
    return date.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  };

  const positionHasData = () => {
    const current = position();
    if (!current) return false;
    return safeNumber(current.yes_shares) > 0 || safeNumber(current.no_shares) > 0;
  };

  const targetProb = () => (direction() === 'yes' ? 0.99 : 0.01);

  const handleStake = async (eventObj) => {
    eventObj?.preventDefault?.();
    if (!isOpen()) {
      setError('Market is closed or resolved.');
      return;
    }

    if (!isLoggedIn()) {
      setVerificationMessage('Please log in first.');
      return;
    }

    const amount = safeNumber(stakeAmount(), 0);
    if (!amount || amount <= 0) {
      setError('Stake amount must be greater than zero.');
      return;
    }
    if (!eventId()) {
      setError('Event not available.');
      return;
    }

    closeMessages();
    setBusyAction('stake');
    try {
      await placeEventUpdate(eventId(), { stake: amount, target_prob: targetProb() });
      await loadUserPosition();
      setStakeAmount('');
      emitSuccess('Trade submitted. Market refreshed.');
      await onTrade()?.(eventId());
    } catch (error) {
      if (error instanceof ApiError && error.status === 403) {
        setVerificationMessage(error.message || 'Verification required to place trade.', {
          requiredTier: error.data?.required_tier
        });
      } else {
        setError(error?.message || 'Failed to place stake.');
      }
    } finally {
      setBusyAction('');
    }
  };

  const executeSell = async (shareType, amount) => {
    const amountValue = safeNumber(amount, 0);
    if (!isLoggedIn()) {
      setError('Please log in first.');
      return;
    }
    if (amountValue <= 0) {
      setError(`No ${shareType.toUpperCase()} shares to sell.`);
      return;
    }

    const marketProb = safeNumber(marketState().market_prob, safeNumber(event().market_prob, 0.5));
    const currentPrice = shareType === 'yes' ? marketProb : (1 - marketProb);
    const payout = amountValue * currentPrice;
    const ok = window.confirm(
      `Confirm withdrawal:\n\n` +
      `Sell ${amountValue.toFixed(2)} ${shareType.toUpperCase()} shares\n` +
      `Estimated payout: ${payout.toFixed(2)} RP\n` +
      `Current market price: ${(currentPrice * 100).toFixed(1)}%\n\n` +
      `Do you want to proceed?`
    );
    if (!ok) {
      return;
    }

    setBusyAction(`sell-${shareType}`);
    closeMessages();
    try {
      const result = await sellEventShares(eventId(), {
        share_type: shareType,
        amount: amountValue
      });
      if (result?.success === false) {
        throw new Error(result.message || `Failed to sell ${shareType.toUpperCase()} shares.`);
      }
      await loadUserPosition();
      emitSuccess(
        `Successfully sold ${amountValue.toFixed(2)} ${shareType.toUpperCase()} shares for ${safeNumber(result?.payout).toFixed(2)} RP`
      );
      await onTrade()?.(eventId());
    } catch (error) {
      if (error instanceof ApiError && error.status === 403) {
        setVerificationMessage(error.message || 'Verification required to sell shares.', {
          requiredTier: error.data?.required_tier
        });
      } else {
        setError(error?.message || `Failed to sell ${shareType.toUpperCase()} shares.`);
      }
    } finally {
      setBusyAction('');
    }
  };

  const handleFullExit = async () => {
    const current = position();
    if (!current) {
      return;
    }

    const yesShares = safeNumber(current.yes_shares);
    const noShares = safeNumber(current.no_shares);
    const marketProb = safeNumber(marketState().market_prob, safeNumber(event().market_prob, 0.5));
    const estimated = (yesShares * marketProb) + (noShares * (1 - marketProb));
    const confirmed = window.confirm(
      `Confirm full exit:\n\n` +
      `Sell all your positions in this market\n` +
      `YES shares: ${yesShares.toFixed(2)}\n` +
      `NO shares: ${noShares.toFixed(2)}\n` +
      `Estimated total payout: ${estimated.toFixed(2)} RP\n\n` +
      'This action cannot be undone.'
    );
    if (!confirmed) {
      return;
    }

    setBusyAction('exit');
    closeMessages();
    try {
      let totalPayout = 0;
      if (yesShares > 0) {
        const yesResult = await sellEventShares(eventId(), {
          share_type: 'yes',
          amount: yesShares
        });
        totalPayout += safeNumber(yesResult?.payout);
      }
      if (noShares > 0) {
        const noResult = await sellEventShares(eventId(), {
          share_type: 'no',
          amount: noShares
        });
        totalPayout += safeNumber(noResult?.payout);
      }

      await loadUserPosition();
      emitSuccess(`Sold all shares. Estimated payout ${totalPayout.toFixed(2)} RP`);
      await onTrade()?.(eventId());
    } catch (error) {
      if (error instanceof ApiError && error.status === 403) {
        setVerificationMessage(error.message || 'Verification required to sell shares.', {
          requiredTier: error.data?.required_tier
        });
      } else {
        setError(error?.message || 'Failed to exit all positions.');
      }
    } finally {
      setBusyAction('');
    }
  };

  const handleBeliefChange = (eventInput) => {
    const value = safeNumber(eventInput.target.value, 0.7);
    setBeliefProb(value);

    if (kellyTimeout) {
      clearTimeout(kellyTimeout);
    }
    kellyTimeout = setTimeout(() => {
      if (isLoggedIn()) {
        void loadKellySuggestion(value);
      }
    }, 300);
  };

  const handleResolve = async (value) => {
    const selectedOutcome = String(value || resolveOutcome()).toLowerCase();
    if (!eventId()) {
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
    setResolveMessage('');
    setResolveError('');
    try {
      await props.onResolve(eventId(), selectedOutcome);
      setResolveMessage(`Market resolved as ${selectedOutcome.toUpperCase()}.`);
      setError('');
    } catch (error) {
      setResolveError(error?.message || 'Failed to resolve market.');
    } finally {
      setResolving(false);
    }
  };

  const applyKelly = () => {
    const suggestion = kellyData();
    if (!suggestion || !Number.isFinite(safeNumber(suggestion.kelly_optimal))) {
      return;
    }
    setStakeAmount(Math.max(0, safeNumber(suggestion.kelly_optimal)).toFixed(2));
    const input = stakeInputRef();
    if (input) {
      input.classList.remove('kelly-flash');
      // eslint-disable-next-line no-unused-expressions
      input.offsetWidth;
      input.classList.add('kelly-flash');
      setTimeout(() => input?.classList.remove('kelly-flash'), 500);
    }
  };

  const updatePositionFromEvent = () => {
    const nextEvent = event();
    if (!nextEvent) return;

    setMarketState({
      market_prob: safeNumber(nextEvent.market_prob, 0.5),
      cumulative_stake: safeNumber(nextEvent.cumulative_stake, 0),
      liquidity_b: safeNumber(nextEvent.liquidity_b, 5000),
    });

    const current = position();
    if (!current) {
      return;
    }
    setPosition(normalizePosition(current));
  };

  createEffect(() => {
    const nextId = String(eventId());
    if (nextId !== lastEventId) {
      lastEventId = nextId;
      updatePositionFromEvent();
      if (isLoggedIn() && eventId()) {
        void loadUserPosition();
      } else {
        clearPosition();
      }
    }
  });

  createEffect(() => {
    const current = marketState();
    const currentPosition = position();
    if (!currentPosition) {
      return;
    }
    setPosition(normalizePosition(currentPosition));
  });

  createEffect(() => {
    if (isLoggedIn() && eventId()) {
      const id = setTimeout(() => {
        void loadKellySuggestion(safeNumber(beliefProb(), 0.7));
      }, 100);
      return () => clearTimeout(id);
    }
  });

  return (
    <div class="event-card">
      <div style={{ flex: '1 1 auto' }}>
        <Show when={!hideTitle}>
          <div class="event-header">
            <h3 class="event-title">{event().title || 'Untitled market'}</h3>
            <div class="event-meta">
              <span class="event-category">{event().category || 'General'}</span>
              <span class="event-closing">{`📅 Closes: ${formatDate(event().closing_date)}`}</span>
            </div>
          </div>
        </Show>

        <div class="market-state">
          <div class="market-stats">
            <div class="stat">
              <span class="stat-label">Current Probability:</span>
              <span class="stat-value probability" style={{ color: getProbabilityColor(marketState().market_prob) }}>
                {formatProbability(marketState().market_prob)}
              </span>
            </div>
            <div class="stat">
              <span class="stat-label">Total RP Staked:</span>
              <span class="stat-value">{formatCurrency(marketState().cumulative_stake, { includeSymbol: false })}</span>
            </div>
            <div class="stat">
              <span class="stat-label">Liquidity Parameter:</span>
              <span class="stat-value">{safeNumber(marketState().liquidity_b).toFixed(0)}</span>
            </div>
            <div class="stat">
              <span class="stat-label">Event Type:</span>
              <span class="stat-value">{event().event_type || 'binary'}</span>
            </div>
          </div>
        </div>

        <Show when={props?.predicted}>
          <p class="prediction-outcome muted">You already submitted a forecast prediction for this market.</p>
        </Show>

        <Show when={isOpen()} fallback={
          <p class="muted">Market is closed or resolved.</p>
        }>
          <Show when={isLoggedIn()} fallback={
            <div class="login-prompt">
              <p>Log in to place stakes and participate in markets</p>
              <button type="button" class="button" onClick={() => { window.location.hash = 'login'; }}>
                Log In
              </button>
            </div>
          }>
            <div class="betting-interface">
              <form class="betting-form" onSubmit={handleStake}>
                <div class="form-row horizontal-row">
                  <div class="form-field">
                    <label for={`direction-${eventId()}`}>Bet Direction:</label>
                    <div class="direction-buttons">
                      <button
                        type="button"
                        class={`direction-btn no-btn ${direction() === 'no' ? 'active' : ''}`}
                        onClick={() => setDirection('no')}
                        disabled={!!busyAction()}
                      >
                        NO
                      </button>
                      <button
                        type="button"
                        class={`direction-btn yes-btn ${direction() === 'yes' ? 'active' : ''}`}
                        onClick={() => setDirection('yes')}
                        disabled={!!busyAction()}
                      >
                        YES
                      </button>
                    </div>
                  </div>

                  <div class="form-field">
                    <label for={`stake-${eventId()}`}>Stake Amount (RP):</label>
                    <input
                      ref={setStakeInputRef}
                      id={`stake-${eventId()}`}
                      class="stake-input"
                      type="number"
                      min="0.01"
                      step="0.01"
                      placeholder="Enter stake amount"
                      value={stakeAmount()}
                      onInput={(e) => setStakeAmount(e.target.value)}
                    />
                  </div>
                </div>

                <div class="form-row">
                  <label>Your Belief Probability:</label>
                  <div class="belief-slider-container">
                    <input
                      type="range"
                      min="0.01"
                      max="0.99"
                      step="0.01"
                      class="belief-slider"
                      value={beliefProb()}
                      onInput={handleBeliefChange}
                    />
                    <div class="belief-display">
                      <span class="belief-percentage">{formatProbability(beliefProb())}</span>
                      <small class="belief-hint">
                        {`Market: ${formatProbability(marketState().market_prob)} | ` +
                          `Your edge: ${(getKellyEdge(beliefProb(), marketState().market_prob) * 100).toFixed(1)}%`}
                      </small>
                    </div>
                  </div>
                </div>

                <div class="kelly-and-stake">
                  <div class="kelly-suggestion">
                    <div class="kelly-header">
                      <span>Kelly Optimal Suggestion</span>
                      <div class="kelly-buttons">
                        <button
                          type="button"
                          class="button kelly-apply-btn primary"
                          onClick={applyKelly}
                        >
                          Apply Kelly
                        </button>
                      </div>
                    </div>
                    <div class="kelly-details">
                      <div class="kelly-stat">
                        <span class="kelly-label">Optimal Kelly:</span>
                        <span class="kelly-amount">
                          {kellyData() ? formatCurrency(kellyData().kelly_optimal) : '--'}
                        </span>
                      </div>
                      <div class="kelly-stat">
                        <span class="kelly-label">Your Edge:</span>
                        <span class="kelly-edge positive">
                          {kellyData() ? `${Math.abs(getKellyEdge(beliefProb(), marketState().market_prob) * 100).toFixed(1)}%` : '--'}
                        </span>
                      </div>
                    </div>
                  </div>

                  <div class="form-actions">
                    <button
                      type="submit"
                      class="button primary"
                      disabled={!stakeAmount() || !!busyAction()}
                    >
                      {busyAction() === 'stake' ? 'Placing Stake...' : 'Place Stake'}
                    </button>
                  </div>
                </div>
              </form>
            </div>
          </Show>
        </Show>
      </div>

      <div style={{ flex: '0 0 auto', marginTop: 'auto' }}>
        <div class="user-position" style={{ display: positionHasData() ? 'block' : 'none' }}>
          <div class="position-stats">
            <div class="stat">
              <span class="stat-label">YES Shares:</span>
              <span class="stat-value">{safeNumber(position()?.yes_shares).toFixed(2)}</span>
            </div>
            <div class="stat">
              <span class="stat-label">NO Shares:</span>
              <span class="stat-value">{safeNumber(position()?.no_shares).toFixed(2)}</span>
            </div>
            <div class="stat">
              <span class="stat-label">Your Stake:</span>
              <span class="stat-value">{formatCurrency(safeNumber(position()?.total_staked, 0))}</span>
            </div>
            <div class="stat">
              <span class="stat-label">Unrealized P&L:</span>
              <span class={`stat-value ${safeNumber(position()?.unrealized_pnl) >= 0 ? 'positive' : 'negative'}`}>
                {formatCurrency(safeNumber(position()?.unrealized_pnl, 0))}
              </span>
            </div>
          </div>
        </div>

        <div class="withdrawal-actions">
          <button
            type="button"
            class={`button withdrawal-btn secondary ${positionHasData() && safeNumber(position()?.yes_shares) > 0 ? '' : 'hidden'}`}
            onClick={() => executeSell('yes', safeNumber(position()?.yes_shares))}
            disabled={!!busyAction()}
          >
            {busyAction() === 'sell-yes' ? 'Selling...' : `Sell All YES (${safeNumber(position()?.yes_shares).toFixed(2)})`}
          </button>
          <button
            type="button"
            class={`button withdrawal-btn secondary ${positionHasData() && safeNumber(position()?.no_shares) > 0 ? '' : 'hidden'}`}
            onClick={() => executeSell('no', safeNumber(position()?.no_shares))}
            disabled={!!busyAction()}
          >
            {busyAction() === 'sell-no' ? 'Selling...' : `Sell All NO (${safeNumber(position()?.no_shares).toFixed(2)})`}
          </button>
          <button
            type="button"
            class={`button withdrawal-btn primary ${positionHasData() ? '' : 'hidden'}`}
            onClick={() => void handleFullExit()}
            disabled={!!busyAction()}
          >
            {busyAction() === 'exit' ? 'Exiting...' : 'Exit All Positions'}
          </button>
        </div>

        <Show when={tradeMessage()}>
          <p class="success">{tradeMessage()}</p>
        </Show>
        <Show when={error()}>
          <p class="error-message">{error()}</p>
        </Show>
        <Show when={props.canResolve && !event().outcome}>
          <div class="market-resolve-controls">
            <div class="trade-direction">
              <button
                type="button"
                class={`button ${resolveOutcome() === 'no' ? 'active-trade-direction' : ''}`}
                onClick={() => setResolveOutcome('no')}
                disabled={resolving()}
              >
                Resolve No
              </button>
              <button
                type="button"
                class={`button ${resolveOutcome() === 'yes' ? 'active-trade-direction' : ''}`}
                onClick={() => setResolveOutcome('yes')}
                disabled={resolving()}
              >
                Resolve Yes
              </button>
            </div>
            <button
              type="button"
              class="button"
              onClick={() => void handleResolve(resolveOutcome())}
              disabled={resolving()}
            >
              {resolving() ? 'Resolving...' : 'Resolve market'}
            </button>
          </div>
        </Show>
        <Show when={resolveError()}>
          <p class="error">{resolveError()}</p>
        </Show>
        <Show when={resolveMessage()}>
          <p class="success">{resolveMessage()}</p>
        </Show>
      </div>
    </div>
  );
}
