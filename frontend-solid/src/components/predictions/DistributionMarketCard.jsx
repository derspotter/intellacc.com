import { createEffect, createMemo, createSignal, For, Show, onCleanup } from 'solid-js';
import { getToken } from '../../services/tokenService';
import {
  api,
  getMarketState,
  getNumericQuote,
  placeNumericTrade,
  sellNumericPosition,
  ApiError
} from '../../services/api';
import { createConfirmCore } from '../../lib/confirmTimer';
import {
  safeNumber,
  formatCurrency,
  toDate,
  toShortDate,
  isPhoneVerificationMessage
} from './marketCardShared';
import {
  makeTransform,
  fitDistributionFromState,
  quantileFromState,
  niceTicks,
  applySpreadPreset,
  rpToLedger,
  ledgerToRp,
  chartXToNominal,
  pickNearestHandle
} from '../../utils/distributionMath';

const CHART_W = 640;
const CHART_H = 200;
const PAD_X = 10;
const PAD_Y = 10;
const TAIL_W = 20;
const TAIL_GAP = 6;
const AXIS_H = 14;
const QUOTE_DEBOUNCE_MS = 400;
const DEFAULT_BUDGET_RP = '10';

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
const fmt = (value) => (Number.isFinite(Number(value)) ? Number(value).toFixed(2) : '0.00');
const fmtTick = (v) =>
  Number.isFinite(Number(v))
    ? new Intl.NumberFormat('en', { notation: 'compact', maximumSignificantDigits: 3 }).format(Number(v))
    : '';

// Trading card for numeric (dense-bin) markets: a hand-rolled SVG showing the
// market's current probability mass, a user-editable target distribution
// (three handles: low/center/high = P10/P50/P90), a live debounced quote,
// and a Trade / Sell-all flow. Mirrors OutcomeMarketCard's loading states,
// verification-notice handling, and logged-out login prompt.
export default function DistributionMarketCard(props) {
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

  const [bins, setBins] = createSignal([]);
  const [numericConfig, setNumericConfig] = createSignal(null);
  const [marketLoadState, setMarketLoadState] = createSignal('loading'); // loading | ready | error | unconfigured

  const [low, setLow] = createSignal(0);
  const [center, setCenter] = createSignal(0);
  const [high, setHigh] = createSignal(0);
  let handlesInitialized = false;
  let baseSpread = { low: 0, center: 0, high: 0 };

  const [budgetRp, setBudgetRp] = createSignal(DEFAULT_BUDGET_RP);

  const [quote, setQuote] = createSignal(null); // {alpha, cost_ledger, market_version, post_distribution, deltas}
  const [quoteLoading, setQuoteLoading] = createSignal(false);
  const [quoteError, setQuoteError] = createSignal('');
  const [marketVersion, setMarketVersion] = createSignal(null);

  const [positionShares, setPositionShares] = createSignal([]); // [{outcome_id, label, shares, staked_ledger}]
  const [busyAction, setBusyAction] = createSignal('');
  const [error, setError] = createSignal('');
  const [tradeMessage, setTradeMessage] = createSignal('');
  // Numeric per-bin staked_ledger is 0 by design (the engine tracks exact
  // cost basis server-side in numeric_position_basis, which is not exposed
  // to the frontend). This is a best-effort, session-local running total of
  // what THIS browser tab has spent, cleared on full sell — labeled
  // accordingly rather than claimed as a persistent cost basis.
  const [sessionSpentRp, setSessionSpentRp] = createSignal(0);

  let lastEventId = '';
  let quoteTimer = null;
  let quoteSeq = 0;
  // Request-ordering guards for loadMarketState/loadPositions, same pattern
  // as fetchQuote's quoteSeq / MarketDetailView's loadSeq: each load
  // captures its own sequence number at the top and every set* after an
  // await bails if a newer call of the same kind has since started. Two
  // independent counters (not one shared one) because loadMarketState and
  // loadPositions are fired concurrently (not awaited) from the
  // event-change effect below — sharing a single counter would make each
  // call's own increment spuriously invalidate the other's in-flight
  // request. Without this, a slow response for a market you've navigated
  // away from (reachable via detail-view back/forward between two numeric
  // markets) can land after a faster response for the new market and
  // overwrite its bins/positions with stale data.
  let marketSeq = 0;
  let positionsSeq = 0;

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

  // Remaps the engine's internal span-clamp wording to trader-facing copy.
  const friendlyTradeError = (message) => {
    if (typeof message === 'string' && message.includes('too extreme or target too concentrated')) {
      return "Your target is too concentrated for this market's liquidity — widen your P10–P90 range or reduce the trade size.";
    }
    return message;
  };

  const inboundBins = () => bins().filter((b) => (b.bucket_kind || 'inbound') === 'inbound');
  const tailLow = () => bins().find((b) => b.bucket_kind === 'lower_tail') || null;
  const tailHigh = () => bins().find((b) => b.bucket_kind === 'upper_tail') || null;
  // Linear config derived from inbound bin bounds — used when the market-state
  // response predates numeric_config (stale bundle/backend).
  const fallbackConfig = () => {
    const ib = inboundBins();
    return {
      range_min: ib[0] ? Number(ib[0].lower_bound) : 0,
      range_max: ib.length ? Number(ib[ib.length - 1].upper_bound) : 1,
      zero_point: null
    };
  };
  const transform = createMemo(() => makeTransform(numericConfig() || fallbackConfig()));
  const rangeMin = () => transform()?.rangeMin ?? 0;
  const rangeMax = () => transform()?.rangeMax ?? 1;

  const loadMarketState = async () => {
    if (!eventId()) return;
    const seq = ++marketSeq;
    setMarketLoadState('loading');
    try {
      const state = await getMarketState(eventId());
      if (seq !== marketSeq) return;
      const rows = Array.isArray(state?.outcomes) ? state.outcomes : [];
      if (rows.length < 2) {
        setBins([]);
        setNumericConfig(null);
        setMarketLoadState('unconfigured');
        setMarketVersion(null);
        return;
      }
      setBins(rows);
      setNumericConfig(state?.numeric_config ?? null);
      setMarketVersion(state?.numeric_market_version ?? null);
      setMarketLoadState('ready');
      if (!handlesInitialized) {
        handlesInitialized = true;
        const p10 = quantileFromState(rows, state?.numeric_config ?? null, 0.10);
        const p50 = quantileFromState(rows, state?.numeric_config ?? null, 0.50);
        const p90 = quantileFromState(rows, state?.numeric_config ?? null, 0.90);
        setLow(p10);
        setCenter(p50);
        setHigh(p90);
        baseSpread = { low: p10, center: p50, high: p90 };
      }
    } catch (err) {
      if (seq !== marketSeq) return;
      setBins([]);
      setNumericConfig(null);
      setMarketLoadState('error');
      setMarketVersion(null);
    }
  };

  const loadPositions = async () => {
    if (!isLoggedIn() || !eventId()) {
      setPositionShares([]);
      return;
    }
    const seq = ++positionsSeq;
    try {
      const result = await api.events.getShares(eventId());
      if (seq !== positionsSeq) return;
      setPositionShares(Array.isArray(result?.outcome_shares) ? result.outcome_shares : []);
    } catch (err) {
      if (seq !== positionsSeq) return;
      if (err instanceof ApiError && err.status === 403) {
        setVerificationMessage(err.message, { requiredTier: err.data?.required_tier });
      }
      setPositionShares([]);
    }
  };

  const hasPosition = () => positionShares().some((row) => safeNumber(row.shares) > 0);
  const totalShares = () => positionShares().reduce((acc, row) => acc + safeNumber(row.shares), 0);
  // Selling only needs a market_version, not a live trade quote — clearing
  // the budget input nulls quote() but must not disable Sell. Prefer the
  // quote's version when one is loaded (freshest), falling back to the
  // version from the last market-state load.
  const sellVersion = () => quote()?.market_version ?? marketVersion();

  // Marginal-price estimate (shares x current per-bin prob), same
  // approximation OutcomeMarketCard uses for its "Position Value" stat —
  // there is no live full-sale quote endpoint, only the executing sell.
  const positionValue = () =>
    positionShares().reduce((acc, row) => {
      const bin = bins().find((b) => String(b.outcome_id) === String(row.outcome_id));
      return acc + safeNumber(row.shares) * safeNumber(bin?.prob);
    }, 0);

  // Target distribution from the three handles, via the pure math util.
  const targetU = createMemo(() => {
    if (bins().length === 0) return [];
    return fitDistributionFromState({
      low: low(), center: center(), high: high(),
      rows: bins(), config: numericConfig()
    });
  });

  // --- SVG geometry (viewBox 640x200) --------------------------------------
  // plotLeft/plotRight collapse to PAD_X on linear markets with no open tails
  // (no gutter), matching the pre-Task-8 layout exactly.
  const plotLeft = () => PAD_X + (tailLow() ? TAIL_W + TAIL_GAP : 0);
  const plotRight = () => CHART_W - PAD_X - (tailHigh() ? TAIL_W + TAIL_GAP : 0);
  const toX = (t) => plotLeft() + clamp(t, 0, 1) * (plotRight() - plotLeft());
  const baselineY = () => CHART_H - PAD_Y - AXIS_H;

  const yMax = createMemo(() => {
    const marketMax = bins().reduce((m, b) => Math.max(m, safeNumber(b.prob)), 0);
    const targetMax = targetU().reduce((m, v) => Math.max(m, v), 0);
    const previewMax = (quote()?.post_distribution || []).reduce((m, v) => Math.max(m, safeNumber(v)), 0);
    return Math.max(marketMax, targetMax, previewMax, 1e-6) * 1.15;
  });

  const toY = (mass) => {
    const clamped = clamp(safeNumber(mass), 0, yMax());
    return baselineY() - (clamped / yMax()) * (baselineY() - PAD_Y);
  };

  // Step-shaped path helpers: a "market mass" / "target" / "preview" curve is
  // one point per bin edge, held flat across each bin (never sampled at bin
  // centers) so the picture matches what u_i actually represents: mass over
  // an interval, not a density sampled at a point.
  // values stays aligned with the full bins() order (inbound + tails); tails
  // are excluded from the step curve but still consume their index.
  const stepPoints = (values) => {
    const rows = bins();
    const n = inboundBins().length;
    if (n === 0) return [];
    const pts = [];
    let i = 0;
    rows.forEach((row, idx) => {
      if ((row.bucket_kind || 'inbound') !== 'inbound') return;
      const x0 = toX(i / n).toFixed(2);
      const x1 = toX((i + 1) / n).toFixed(2);
      const y = toY(values[idx]).toFixed(2);
      pts.push(`${x0},${y}`, `${x1},${y}`);
      i += 1;
    });
    return pts;
  };

  const areaPath = (values) => {
    if (inboundBins().length === 0) return '';
    const baseline = baselineY().toFixed(2);
    const pts = stepPoints(values);
    return `M ${toX(0).toFixed(2)},${baseline} L ${pts.join(' L ')} L ${toX(1).toFixed(2)},${baseline} Z`;
  };

  const linePath = (values) => {
    if (bins().length === 0) return '';
    const pts = stepPoints(values);
    return `M ${pts.join(' L ')}`;
  };

  const marketAreaPath = createMemo(() => areaPath(bins().map((b) => safeNumber(b.prob))));
  const targetLinePath = createMemo(() => linePath(targetU()));
  const previewLinePath = createMemo(() => {
    const post = quote()?.post_distribution;
    return Array.isArray(post) && post.length === bins().length ? linePath(post) : '';
  });

  // Thin "your shares by bin" overlay: small ticks near the baseline, scaled
  // to their own max so a concentrated position never drowns out the market
  // mass / target curves sharing the same axes.
  const sharesById = () =>
    new Map(positionShares().map((row) => [String(row.outcome_id), safeNumber(row.shares)]));
  const maxHeldShare = () => Math.max(...positionShares().map((row) => safeNumber(row.shares)), 1e-9);

  const positionTicks = createMemo(() => {
    if (!hasPosition()) return [];
    const byId = sharesById();
    const maxShare = maxHeldShare();
    const n = inboundBins().length;
    if (n === 0) return [];
    const out = [];
    let i = 0;
    bins().forEach((bin) => {
      if ((bin.bucket_kind || 'inbound') !== 'inbound') return;
      const idx = i;
      i += 1;
      const shares = byId.get(String(bin.outcome_id)) || 0;
      if (shares <= 0) return;
      const x0 = toX(idx / n);
      const x1 = toX((idx + 1) / n);
      const height = 4 + (shares / maxShare) * 16;
      out.push({ x: x0, width: Math.max(x1 - x0 - 1, 1), height });
    });
    return out;
  });

  // Overlay height (px) for shares held in a tail outcome, scaled to the same
  // maxHeldShare as the inbound position ticks, or null if none held there.
  const tailPositionHeight = (tailRow) => {
    if (!tailRow || !hasPosition()) return null;
    const shares = sharesById().get(String(tailRow.outcome_id)) || 0;
    if (shares <= 0) return null;
    return 4 + (shares / maxHeldShare()) * 16;
  };

  // Nice 1-2-5 axis ticks (empty until a transform is available).
  const axisTicks = createMemo(() => niceTicks(numericConfig() || fallbackConfig(), 5));

  // --- Quote (debounced 400ms) ----------------------------------------------
  // quoteLoading doubles as "the displayed quote() may not match the current
  // handles/budget yet" — it is set the instant any tracked input changes
  // (see the createEffect below), not just while the network call is in
  // flight. This closes a gap where the Trade button would otherwise stay
  // enabled during the debounce wait itself: without it, editing a handle
  // and clicking Trade inside that ~400ms window would submit a fresh
  // target alongside a stale quote's cost_ledger/market_version — exactly
  // the kind of quote/execute mismatch the max_cost_ledger cap exists to
  // catch, but better to never let the button be clickable in that state.
  const bailQuote = () => {
    setQuote(null);
    setQuoteLoading(false);
  };

  const fetchQuote = async () => {
    const seq = ++quoteSeq;
    if (!isLoggedIn() || marketLoadState() !== 'ready' || !isOpen()) {
      return bailQuote();
    }
    const budget = safeNumber(budgetRp(), 0);
    if (!(budget > 0)) {
      return bailQuote();
    }
    const target = targetU();
    if (target.length === 0) {
      return bailQuote();
    }
    setQuoteError('');
    try {
      const result = await getNumericQuote(eventId(), {
        budgetLedger: rpToLedger(budget),
        target
      });
      if (seq !== quoteSeq) return;
      setQuote(result);
    } catch (err) {
      if (seq !== quoteSeq) return;
      setQuote(null);
      if (err instanceof ApiError && err.status === 403) {
        setVerificationMessage(err.message, { requiredTier: err.data?.required_tier });
      } else {
        setQuoteError(friendlyTradeError(err?.message) || 'Failed to fetch quote.');
      }
    } finally {
      if (seq === quoteSeq) setQuoteLoading(false);
    }
  };

  createEffect(() => {
    // Reading these signals here (not inside the async body) is what makes
    // them reactive dependencies for the debounce.
    low();
    center();
    high();
    budgetRp();
    marketLoadState();
    // Mark the current quote() stale for the whole debounce+fetch window,
    // not just the network round trip — see the comment on fetchQuote.
    // Bumping the sequence here (not only in fetchQuote) also invalidates any
    // response already in flight the instant the inputs change, so a late
    // arrival can never re-enable Trade against edited handles.
    quoteSeq += 1;
    setQuoteLoading(true);
    if (quoteTimer) clearTimeout(quoteTimer);
    quoteTimer = setTimeout(() => void fetchQuote(), QUOTE_DEBOUNCE_MS);
  });
  onCleanup(() => {
    if (quoteTimer) clearTimeout(quoteTimer);
  });

  // --- Handle editing --------------------------------------------------------
  const updateLow = (value) => setLow(clamp(safeNumber(value, low()), rangeMin(), center()));
  const updateCenter = (value) => setCenter(clamp(safeNumber(value, center()), low(), high()));
  const updateHigh = (value) => setHigh(clamp(safeNumber(value, high()), center(), rangeMax()));

  // --- Direct chart interaction ---------------------------------------------
  // pointerdown grabs the nearest of the three guide lines and moves it to the
  // pointer; setPointerCapture keeps pointermove routed here for the drag, so
  // a plain click is just a zero-length drag. Values route through the same
  // updateLow/updateCenter/updateHigh as the number inputs, which keeps the
  // low <= center <= high clamping and the debounced quote unchanged.
  let svgRef;
  const [dragHandle, setDragHandle] = createSignal(null);
  const chartInteractive = () => isOpen() && !busyAction() && marketLoadState() === 'ready';

  // Pointer event -> { x: viewBox x, nominal: value under the pointer }, or
  // null when the geometry/config is degenerate (event is ignored).
  const pointerTarget = (domEvent) => {
    const rect = svgRef?.getBoundingClientRect();
    if (!rect || !(rect.width > 0)) return null;
    // preserveAspectRatio="none": client x maps linearly onto the viewBox.
    const x = ((domEvent.clientX - rect.left) / rect.width) * CHART_W;
    const nominal = chartXToNominal(x, {
      plotLeft: plotLeft(),
      plotRight: plotRight(),
      config: numericConfig() || fallbackConfig()
    });
    return nominal == null ? null : { x, nominal };
  };

  const applyHandleValue = (key, value) => {
    if (key === 'low') updateLow(value);
    else if (key === 'center') updateCenter(value);
    else updateHigh(value);
  };

  const onChartPointerDown = (domEvent) => {
    if (!chartInteractive()) return;
    const tf = transform();
    const target = pointerTarget(domEvent);
    if (!tf || !target) return;
    const key = pickNearestHandle(target.x, {
      lowX: toX(tf.toInternal(low())),
      centerX: toX(tf.toInternal(center())),
      highX: toX(tf.toInternal(high()))
    });
    domEvent.preventDefault();
    setDragHandle(key);
    applyHandleValue(key, target.nominal);
    svgRef?.setPointerCapture?.(domEvent.pointerId);
  };

  const onChartPointerMove = (domEvent) => {
    const key = dragHandle();
    if (!key) return;
    const target = pointerTarget(domEvent);
    if (target) applyHandleValue(key, target.nominal);
  };

  const endChartDrag = (domEvent) => {
    if (!dragHandle()) return;
    setDragHandle(null);
    if (svgRef?.hasPointerCapture?.(domEvent.pointerId)) {
      svgRef.releasePointerCapture(domEvent.pointerId);
    }
  };

  const applyPreset = (factor) => {
    const { low: nextLow, high: nextHigh } = applySpreadPreset({
      center: center(),
      baseLow: baseSpread.low,
      baseCenter: baseSpread.center,
      baseHigh: baseSpread.high,
      factor
    });
    setLow(clamp(nextLow, rangeMin(), center()));
    setHigh(clamp(nextHigh, center(), rangeMax()));
  };

  // --- Trade / sell ----------------------------------------------------------
  const handleTrade = async (domEvent) => {
    domEvent?.preventDefault?.();
    if (!isOpen()) {
      setError('Market is closed or resolved.');
      return;
    }
    if (!isLoggedIn()) {
      setVerificationMessage('Please log in first.');
      return;
    }
    const activeQuote = quote();
    if (!activeQuote) {
      setError('Waiting for a quote — enter a budget first.');
      return;
    }

    closeMessages();
    setBusyAction('trade');
    try {
      const result = await placeNumericTrade(eventId(), {
        target: targetU(),
        budgetLedger: rpToLedger(safeNumber(budgetRp(), 0)),
        // Cap at the exact quoted cost: if the market moved between quote and
        // execute, the engine's fresh recompute must exceed this and 409
        // rather than silently charging more than what was quoted.
        maxCostLedger: activeQuote.cost_ledger,
        marketVersion: activeQuote.market_version
      });
      setSessionSpentRp((prev) => prev + ledgerToRp(result.cost_ledger));
      emitSuccess(
        `Traded for ${ledgerToRp(result.cost_ledger).toFixed(2)} RP (moved ${Math.round(result.alpha * 100)}% toward your target).`
      );
      window.dispatchEvent(new CustomEvent('rp-balance-refresh'));
      await loadMarketState();
      await loadPositions();
      await fetchQuote();
      await onTrade()?.(eventId());
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && err.data?.quote) {
        setQuote(err.data.quote);
        setError('Market moved since your last quote — review the refreshed cost and try again.');
      } else if (err instanceof ApiError && err.status === 403) {
        setVerificationMessage(err.message || 'Verification required to trade.', {
          requiredTier: err.data?.required_tier
        });
      } else {
        setError(friendlyTradeError(err?.message) || 'Failed to place trade.');
      }
    } finally {
      setBusyAction('');
    }
  };

  // Two-step sell confirm replacing the old window.confirm() dialog: the
  // first tap arms the Sell button (label flips to "Confirm sell — <est.
  // payout>"), a second tap within CONFIRM_RESET_MS executes, otherwise the
  // shared core auto-resets. Same pattern as the terminal settings sections'
  // useConfirmTimer — that hook is terminal-skin-scoped, so wire the plain
  // core (which cancels its timer on unmount via dispose) to a signal here.
  const [armedSellId, setArmedSellId] = createSignal(null);
  const sellConfirm = createConfirmCore({ get: armedSellId, set: setArmedSellId });
  onCleanup(sellConfirm.dispose);

  const handleSell = async () => {
    if (!isOpen()) {
      setError('Market is closed or resolved.');
      return;
    }
    if (!hasPosition()) {
      setError('No position to sell.');
      return;
    }
    const version = sellVersion();
    if (version == null) return;
    if (!sellConfirm.confirm('sell')) return;

    closeMessages();
    setBusyAction('sell');
    try {
      const result = await sellNumericPosition(eventId(), {
        marketVersion: version
      });
      setSessionSpentRp(0);
      emitSuccess(`Sold your position for ${ledgerToRp(result.payout_ledger).toFixed(2)} RP.`);
      window.dispatchEvent(new CustomEvent('rp-balance-refresh'));
      await loadMarketState();
      await loadPositions();
      await fetchQuote();
      await onTrade()?.(eventId());
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setError('Market moved — refresh and try selling again.');
        await fetchQuote();
      } else if (err instanceof ApiError && err.status === 403) {
        setVerificationMessage(err.message || 'Verification required to sell.', {
          requiredTier: err.data?.required_tier
        });
      } else {
        setError(err?.message || 'Failed to sell position.');
      }
    } finally {
      setBusyAction('');
    }
  };

  const handleRefresh = async () => {
    closeMessages();
    await loadMarketState();
    await loadPositions();
    await fetchQuote();
  };

  createEffect(() => {
    const nextId = String(eventId());
    if (nextId !== lastEventId) {
      lastEventId = nextId;
      handlesInitialized = false;
      setQuote(null);
      setSessionSpentRp(0);
      // Invalidate anything already in flight for the previous event before
      // kicking off fresh loads, so a slow response for the market we just
      // navigated away from (e.g. the isLoggedIn() branch below never
      // firing loadPositions again) can't land later and clobber state that
      // belongs to nextId.
      marketSeq += 1;
      positionsSeq += 1;
      void loadMarketState();
      if (isLoggedIn()) {
        void loadPositions();
      } else {
        setPositionShares([]);
      }
    }
  });

  return (
    <div class="event-card distribution-market-card">
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

        <Show when={marketLoadState() === 'loading'}>
          <p class="muted">Loading distribution...</p>
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
          <div class="distribution-card-chart-row">
            <svg
              ref={svgRef}
              class="distribution-card-chart"
              classList={{ 'distribution-card-chart-interactive': chartInteractive(), 'distribution-card-chart-dragging': !!dragHandle() }}
              viewBox={`0 0 ${CHART_W} ${CHART_H}`}
              preserveAspectRatio="none"
              role="img"
              aria-label="Market probability distribution. Click or drag to set your low, center, and high values."
              onPointerDown={onChartPointerDown}
              onPointerMove={onChartPointerMove}
              onPointerUp={endChartDrag}
              onPointerCancel={endChartDrag}
            >
              <path class="distribution-card-market-area" d={marketAreaPath()} />
              <Show when={targetLinePath()}>
                <path class="distribution-card-target-line" d={targetLinePath()} />
              </Show>
              <Show when={previewLinePath()}>
                <path class="distribution-card-preview-line" d={previewLinePath()} />
              </Show>
              <For each={positionTicks()}>
                {(tick) => (
                  <rect
                    class="distribution-card-position-overlay"
                    x={tick.x}
                    y={baselineY() - tick.height}
                    width={tick.width}
                    height={tick.height}
                  />
                )}
              </For>
              <line
                class="distribution-card-handle-guide"
                x1={toX(transform()?.toInternal(low()) ?? 0)} x2={toX(transform()?.toInternal(low()) ?? 0)} y1={PAD_Y} y2={baselineY()}
              />
              <line
                class="distribution-card-handle-guide distribution-card-handle-guide-center"
                x1={toX(transform()?.toInternal(center()) ?? 0)} x2={toX(transform()?.toInternal(center()) ?? 0)} y1={PAD_Y} y2={baselineY()}
              />
              <line
                class="distribution-card-handle-guide"
                x1={toX(transform()?.toInternal(high()) ?? 0)} x2={toX(transform()?.toInternal(high()) ?? 0)} y1={PAD_Y} y2={baselineY()}
              />
              {/* grab knobs atop each guide line, shown while the chart is interactive */}
              <Show when={chartInteractive()}>
                <For each={[low, center, high]}>
                  {(value) => (
                    <circle
                      class="distribution-card-handle-knob"
                      cx={toX(transform()?.toInternal(value()) ?? 0)}
                      cy={PAD_Y}
                      r="5"
                    />
                  )}
                </For>
              </Show>

              {/* axis tick labels — nice 1-2-5 nominal values, placed in t-space */}
              <For each={axisTicks()}>
                {(tick) => (
                  <text class="distribution-card-axis-label" x={toX(tick.t)} y={CHART_H - 3} text-anchor="middle">
                    {fmtTick(tick.value)}
                  </text>
                )}
              </For>

              {/* tail edge bars: market prob as a filled bar, target mass as a line */}
              <Show when={tailLow()}>
                <rect
                  class="distribution-card-tail-bar"
                  x={PAD_X}
                  y={toY(safeNumber(tailLow().prob))}
                  width={TAIL_W}
                  height={Math.max(baselineY() - toY(safeNumber(tailLow().prob)), 0.5)}
                />
                <text class="distribution-card-tail-pct" x={PAD_X + TAIL_W / 2} y={toY(safeNumber(tailLow().prob)) - 3} text-anchor="middle">
                  {`${(safeNumber(tailLow().prob) * 100).toFixed(0)}%`}
                </text>
                <Show when={tailPositionHeight(tailLow())}>
                  {(h) => (
                    <rect
                      class="distribution-card-position-overlay"
                      x={PAD_X}
                      y={baselineY() - h()}
                      width={Math.max(TAIL_W - 1, 1)}
                      height={h()}
                    />
                  )}
                </Show>
                <text class="distribution-card-axis-label" x={PAD_X + TAIL_W / 2} y={CHART_H - 3} text-anchor="middle">
                  {`<${fmtTick(rangeMin())}`}
                </text>
                <Show when={targetU().length === bins().length}>
                  <line
                    class="distribution-card-target-line"
                    x1={PAD_X} x2={PAD_X + TAIL_W}
                    y1={toY(targetU()[bins().indexOf(tailLow())])}
                    y2={toY(targetU()[bins().indexOf(tailLow())])}
                  />
                </Show>
                <Show when={(quote()?.post_distribution || []).length === bins().length}>
                  <line
                    class="distribution-card-preview-line"
                    x1={PAD_X} x2={PAD_X + TAIL_W}
                    y1={toY(safeNumber(quote().post_distribution[bins().indexOf(tailLow())]))}
                    y2={toY(safeNumber(quote().post_distribution[bins().indexOf(tailLow())]))}
                  />
                </Show>
              </Show>
              <Show when={tailHigh()}>
                <rect
                  class="distribution-card-tail-bar"
                  x={CHART_W - PAD_X - TAIL_W}
                  y={toY(safeNumber(tailHigh().prob))}
                  width={TAIL_W}
                  height={Math.max(baselineY() - toY(safeNumber(tailHigh().prob)), 0.5)}
                />
                <text class="distribution-card-tail-pct" x={CHART_W - PAD_X - TAIL_W / 2} y={toY(safeNumber(tailHigh().prob)) - 3} text-anchor="middle">
                  {`${(safeNumber(tailHigh().prob) * 100).toFixed(0)}%`}
                </text>
                <Show when={tailPositionHeight(tailHigh())}>
                  {(h) => (
                    <rect
                      class="distribution-card-position-overlay"
                      x={CHART_W - PAD_X - TAIL_W}
                      y={baselineY() - h()}
                      width={Math.max(TAIL_W - 1, 1)}
                      height={h()}
                    />
                  )}
                </Show>
                <text class="distribution-card-axis-label" x={CHART_W - PAD_X - TAIL_W / 2} y={CHART_H - 3} text-anchor="middle">
                  {`>${fmtTick(rangeMax())}`}
                </text>
                <Show when={targetU().length === bins().length}>
                  <line
                    class="distribution-card-target-line"
                    x1={CHART_W - PAD_X - TAIL_W} x2={CHART_W - PAD_X}
                    y1={toY(targetU()[bins().indexOf(tailHigh())])}
                    y2={toY(targetU()[bins().indexOf(tailHigh())])}
                  />
                </Show>
                <Show when={(quote()?.post_distribution || []).length === bins().length}>
                  <line
                    class="distribution-card-preview-line"
                    x1={CHART_W - PAD_X - TAIL_W} x2={CHART_W - PAD_X}
                    y1={toY(safeNumber(quote().post_distribution[bins().indexOf(tailHigh())]))}
                    y2={toY(safeNumber(quote().post_distribution[bins().indexOf(tailHigh())]))}
                  />
                </Show>
              </Show>
            </svg>
            <button type="button" class="button secondary distribution-card-refresh" onClick={() => void handleRefresh()}>
              Refresh
            </button>
          </div>

          <p class="distribution-card-copy">
            {`80% chance between ${fmt(low())} and ${fmt(high())}`}
          </p>
          <p class="distribution-card-copy muted">
            {`Most likely around ${fmt(center())}`}
          </p>

          <div class="distribution-card-handles">
            <div class="form-field">
              <label for={`dist-low-${eventId()}`}>Low (P10)</label>
              <input
                id={`dist-low-${eventId()}`}
                class="distribution-card-handle-input"
                type="number"
                step="any"
                value={fmt(low())}
                onInput={(e) => updateLow(e.target.value)}
                disabled={!!busyAction()}
              />
            </div>
            <div class="form-field">
              <label for={`dist-center-${eventId()}`}>Center (P50)</label>
              <input
                id={`dist-center-${eventId()}`}
                class="distribution-card-handle-input"
                type="number"
                step="any"
                value={fmt(center())}
                onInput={(e) => updateCenter(e.target.value)}
                disabled={!!busyAction()}
              />
            </div>
            <div class="form-field">
              <label for={`dist-high-${eventId()}`}>High (P90)</label>
              <input
                id={`dist-high-${eventId()}`}
                class="distribution-card-handle-input"
                type="number"
                step="any"
                value={fmt(high())}
                onInput={(e) => updateHigh(e.target.value)}
                disabled={!!busyAction()}
              />
            </div>
          </div>

          <div class="distribution-card-presets">
            <button type="button" class="button secondary" onClick={() => applyPreset(0.5)} disabled={!!busyAction()}>Narrow</button>
            <button type="button" class="button secondary" onClick={() => applyPreset(1)} disabled={!!busyAction()}>Medium</button>
            <button type="button" class="button secondary" onClick={() => applyPreset(2)} disabled={!!busyAction()}>Wide</button>
          </div>

          <Show when={isOpen()} fallback={<p class="muted">Market is closed or resolved.</p>}>
            <Show when={isLoggedIn()} fallback={
              <div class="login-prompt">
                <p>Log in to trade this market's distribution</p>
                <button type="button" class="button" onClick={() => { window.location.hash = 'login'; }}>
                  Log In
                </button>
              </div>
            }>
              <form class="betting-form distribution-card-trade-panel" onSubmit={handleTrade}>
                <div class="form-row horizontal-row">
                  <div class="form-field">
                    <label for={`dist-budget-${eventId()}`}>Trade size (RP):</label>
                    <input
                      id={`dist-budget-${eventId()}`}
                      class="stake-input distribution-card-budget-input"
                      type="number"
                      min="0.01"
                      step="0.01"
                      placeholder="Enter amount"
                      value={budgetRp()}
                      onInput={(e) => setBudgetRp(e.target.value)}
                      disabled={!!busyAction()}
                    />
                  </div>
                  <div class="form-actions">
                    <button
                      type="submit"
                      class="button primary"
                      disabled={!quote() || quoteLoading() || !!busyAction()}
                    >
                      {busyAction() === 'trade' ? 'Trading...' : 'Trade'}
                    </button>
                  </div>
                </div>

                <Show when={quoteLoading()}>
                  <p class="muted distribution-card-quote-loading">Getting a quote…</p>
                </Show>
                <Show when={!quoteLoading() && quote()}>
                  <p class="distribution-card-quote">
                    {`Cost ${ledgerToRp(quote().cost_ledger).toFixed(2)} RP · moves market ${Math.round(quote().alpha * 100)}% toward your target`}
                  </p>
                </Show>
                <Show when={!quoteLoading() && !quote() && quoteError()}>
                  <p class="error-message">{quoteError()}</p>
                </Show>
              </form>
            </Show>
          </Show>
        </Show>
      </div>

      <div style={{ flex: '0 0 auto', marginTop: 'auto' }}>
        <Show when={hasPosition()}>
          <div class="distribution-card-position">
            <div class="position-stats">
              <div class="stat">
                <span class="stat-label">Shares held:</span>
                <span class="stat-value">{totalShares().toFixed(2)}</span>
              </div>
              <div class="stat">
                <span class="stat-label">Spent this session:</span>
                <span class="stat-value">{formatCurrency(sessionSpentRp())}</span>
              </div>
              <div class="stat">
                <span class="stat-label">Est. value:</span>
                <span class="stat-value">{formatCurrency(positionValue())}</span>
              </div>
            </div>
            <button
              type="button"
              class={sellConfirm.isArmed('sell') ? 'button button-danger' : 'button secondary'}
              onClick={() => void handleSell()}
              onBlur={() => sellConfirm.disarm('sell')}
              disabled={!!busyAction() || !isOpen() || totalShares() <= 0 || sellVersion() == null}
            >
              {busyAction() === 'sell'
                ? 'Selling...'
                : sellConfirm.isArmed('sell')
                  ? `Confirm sell — ~${positionValue().toFixed(2)} RP`
                  : `Sell all (${totalShares().toFixed(2)} sh)`}
            </button>
            <Show when={!isOpen()}>
              <p class="muted">Market is closed or resolved — selling is unavailable.</p>
            </Show>
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
