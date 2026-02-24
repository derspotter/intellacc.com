import {
  createEffect,
  createMemo,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show
} from 'solid-js';
import MarketEventCard from '../components/predictions/MarketEventCard';
import {
  createEvent,
  getEvents,
  getPredictionLeaderboardFallback,
  getPredictions,
  getScoringLeaderboard,
  resolveEvent,
  getUserPositions,
} from '../services/api';
import { getCurrentUserId, isAdmin, isAuthenticated } from '../services/auth';

const normalizeRows = (payload) => {
  if (!payload) return [];
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload.items)) return payload.items;
  if (Array.isArray(payload.leaderboard)) return payload.leaderboard;
  if (Array.isArray(payload.events)) return payload.events;
  return [];
};

const nowCloseWindow = (hours = 24) =>
  new Date(Date.now() + hours * 60 * 60 * 1000);

const outcomeLabel = (outcome) => {
  if (!outcome) {
    return 'Open';
  }
  return outcome === 'correct' ? 'Correct' : 'Resolved';
};

export default function PredictionsPage() {
  const [events, setEvents] = createSignal([]);
  const [predictions, setPredictions] = createSignal([]);
  const [userPositions, setUserPositions] = createSignal([]);
  const [leaderboard, setLeaderboard] = createSignal([]);
  const [loadingEvents, setLoadingEvents] = createSignal(false);
  const [loadingPredictions, setLoadingPredictions] = createSignal(false);
  const [loadingPositions, setLoadingPositions] = createSignal(false);
  const [loadingLeaderboard, setLoadingLeaderboard] = createSignal(false);
  const [searchQuery, setSearchQuery] = createSignal('');
  const [filter, setFilter] = createSignal('all');
  const [errors, setErrors] = createSignal([]);
  const [eventTitle, setEventTitle] = createSignal('');
  const [eventDetails, setEventDetails] = createSignal('');
  const [eventClosingDate, setEventClosingDate] = createSignal('');
  const [creatingEvent, setCreatingEvent] = createSignal(false);
  const [createEventError, setCreateEventError] = createSignal('');
  const [createEventMessage, setCreateEventMessage] = createSignal('');
  const [lastTradeMessage, setLastTradeMessage] = createSignal('');
  let lastTradeTimeout = null;

  const authed = () => isAuthenticated();
  const userId = () => getCurrentUserId();
  const isFilterActive = (value) => filter() === value;

  const pushError = (message) => {
    if (!message) {
      return;
    }
    setErrors((current) => [...current, message]);
  };

  const clearErrors = () => setErrors([]);

  const clearTradeMessage = () => {
    if (lastTradeTimeout) {
      clearTimeout(lastTradeTimeout);
      lastTradeTimeout = null;
    }
    setLastTradeMessage('');
  };

  const filteredEvents = createMemo(() => {
    const normalized = [...events()];
    const positionSet = new Set(userPositions().map((item) => String(item.event_id)));
    const now = Date.now();
    const soonWindow = nowCloseWindow(24).getTime();
    const list = normalized.filter((event) => {
      if (filter() === 'all') {
        return true;
      }
      if (filter() === 'my-positions') {
        return positionSet.has(String(event.id));
      }
      if (filter() === 'open') {
        const closed = !!event.outcome;
        const closeTs = event.closing_date ? new Date(event.closing_date).getTime() : Number.MAX_SAFE_INTEGER;
        return !closed && closeTs > now;
      }
      if (filter() === 'closing-soon') {
        const closeTs = event.closing_date ? new Date(event.closing_date).getTime() : NaN;
        return !event.outcome && closeTs > now && closeTs <= soonWindow;
      }
      return true;
    });

    return list.sort((a, b) => {
      const aOutcome = !!a.outcome;
      const bOutcome = !!b.outcome;
      if (aOutcome !== bOutcome) {
        return aOutcome ? 1 : -1;
      }
      const aDate = new Date(a.closing_date || 0).getTime();
      const bDate = new Date(b.closing_date || 0).getTime();
      return aDate - bDate;
    });
  });

  const predictedEventIds = createMemo(() => {
    const map = new Set();
    predictions().forEach((prediction) => {
      map.add(String(prediction.event_id));
    });
    return map;
  });

  const positionsByEventId = createMemo(() => {
    const map = new Map();
    for (const position of userPositions()) {
      map.set(String(position.event_id), position);
    }
    return map;
  });

  const setQuickCloseDate = () => {
    const now = new Date(Date.now() + 60 * 60 * 1000);
    const tzOffset = now.getTimezoneOffset() * 60000;
    const local = new Date(now.getTime() - tzOffset).toISOString().slice(0, 16);
    setEventClosingDate(local);
  };

  const loadEvents = async () => {
    clearErrors();
    setLoadingEvents(true);
    try {
      const response = await getEvents(searchQuery().trim());
      setEvents(normalizeRows(response));
    } catch (error) {
      const message = error?.message || 'Failed to load prediction markets.';
      pushError(message);
      setEvents([]);
    } finally {
      setLoadingEvents(false);
    }
  };

  const loadPredictions = async () => {
    clearErrors();
    if (!authed()) {
      setPredictions([]);
      return;
    }

    setLoadingPredictions(true);
    try {
      const response = await getPredictions();
      setPredictions(normalizeRows(response));
    } catch (error) {
      pushError(error?.message || 'Failed to load prediction history.');
      setPredictions([]);
    } finally {
      setLoadingPredictions(false);
    }
  };

  const loadPositions = async () => {
    if (!authed()) {
      setUserPositions([]);
      return;
    }
    if (!userId()) {
      setUserPositions([]);
      return;
    }

    setLoadingPositions(true);
    try {
      const response = await getUserPositions(userId());
      setUserPositions(normalizeRows(response));
    } catch (error) {
      if (!String(error?.message || '').includes('401')) {
        pushError(error?.message || 'Failed to load your open positions.');
      }
      setUserPositions([]);
    } finally {
      setLoadingPositions(false);
    }
  };

  const loadLeaderboard = async () => {
    setLoadingLeaderboard(true);
    try {
      const response = await getScoringLeaderboard(10);
      setLeaderboard(normalizeRows(response));
    } catch (error) {
      const fallback = await getPredictionLeaderboardFallback().catch(() => []);
      setLeaderboard(normalizeRows(fallback));
    } finally {
      setLoadingLeaderboard(false);
    }
  };

  const loadAll = async () => {
    const tasks = [loadEvents(), loadLeaderboard()];
    if (authed()) {
      tasks.push(loadPredictions(), loadPositions());
    } else {
      setPredictions([]);
      setUserPositions([]);
    }
    await Promise.all(tasks);
  };

  const handleCreateEvent = async (event) => {
    event?.preventDefault?.();
    setCreateEventError('');
    setCreateEventMessage('');
    clearTradeMessage();

    const title = eventTitle().trim();
    const details = eventDetails().trim();
    if (!title || !details) {
      setCreateEventError('Title and details are required.');
      return;
    }

    const closingDateValue = eventClosingDate().trim();
    if (!closingDateValue) {
      setCreateEventError('A closing date is required.');
      return;
    }

    const parsedClosingDate = new Date(closingDateValue);
    if (Number.isNaN(parsedClosingDate.getTime()) || parsedClosingDate <= new Date()) {
      setCreateEventError('Closing date must be a valid future date/time.');
      return;
    }

    setCreatingEvent(true);
    try {
      const created = await createEvent(title, details, parsedClosingDate.toISOString());
      setEvents((current) => [created, ...current]);
      setCreateEventMessage('Market question created.');
      setEventTitle('');
      setEventDetails('');
      setEventClosingDate('');
      await loadEvents();
    } catch (error) {
      setCreateEventError(error?.message || 'Failed to create question.');
    } finally {
      setCreatingEvent(false);
    }
  };

  const handleTrade = async () => {
    setLastTradeMessage('Trade submitted.');
    if (lastTradeTimeout) {
      clearTimeout(lastTradeTimeout);
    }
    lastTradeTimeout = setTimeout(() => {
      clearTradeMessage();
      lastTradeTimeout = null;
    }, 1600);
    await Promise.all([
      loadEvents(),
      ...(authed() ? [loadPredictions(), loadPositions()] : [])
    ]);
  };

  const handleResolve = async (eventId, outcome) => {
    clearTradeMessage();
    try {
      await resolveEvent(eventId, outcome);
      setLastTradeMessage(`Market resolved as ${String(outcome).toUpperCase()}.`);
      await Promise.all([
        loadEvents(),
        ...(authed() ? [loadPredictions(), loadPositions()] : [])
      ]);
      if (lastTradeTimeout) {
        clearTimeout(lastTradeTimeout);
      }
      lastTradeTimeout = setTimeout(() => {
        clearTradeMessage();
        lastTradeTimeout = null;
      }, 2600);
    } catch (error) {
      const message = error?.message || 'Failed to resolve market.';
      pushError(message);
    }
  };

  const setSearchNow = async () => {
    await loadEvents();
  };

  createEffect(() => {
    const interval = setInterval(() => {
      void loadEvents();
      if (authed()) {
        void loadPositions();
      }
    }, 60000);
    return () => clearInterval(interval);
  });

  onMount(() => {
    loadAll();
    if (authed() && isAdmin() && !eventClosingDate()) {
      setQuickCloseDate();
    }
  });

  onCleanup(() => {
    clearTradeMessage();
    if (lastTradeTimeout) {
      clearTimeout(lastTradeTimeout);
      lastTradeTimeout = null;
    }
  });

  return (
    <section class="predictions-page">
      <h1>Predictions & Trading</h1>
      <Show when={errors().length}>
        <div class="predictions-errors">
          <For each={errors()}>
            {(message) => <p class="error">{message}</p>}
          </For>
        </div>
      </Show>
      <Show when={lastTradeMessage()}>
        <p class="success">{lastTradeMessage()}</p>
      </Show>

      <Show when={!authed()}>
        <div class="login-notice">
          <p>Sign in to trade in markets and track your positions.</p>
          <button type="button" onClick={() => (window.location.hash = 'login')}>
            Sign in
          </button>
        </div>
      </Show>

      <div class="predictions-layout">
        <section class="predictions-events">
          <div class="predictions-section-head">
            <h2>Open Markets</h2>
            <div class="predictions-filter-row">
              <button
                type="button"
                class="post-action"
                classList={{ active: isFilterActive('all') }}
                onClick={() => setFilter('all')}
              >
                All
              </button>
              <button
                type="button"
                class="post-action"
                classList={{ active: isFilterActive('open') }}
                onClick={() => setFilter('open')}
              >
                Open
              </button>
              <button
                type="button"
                class="post-action"
                classList={{ active: isFilterActive('closing-soon') }}
                onClick={() => setFilter('closing-soon')}
              >
                Closing Soon
              </button>
              <Show when={authed()}>
                <button
                  type="button"
                  class="post-action"
                  classList={{ active: isFilterActive('my-positions') }}
                  onClick={() => setFilter('my-positions')}
                >
                  My Positions
                </button>
              </Show>
            </div>
          </div>

          <label class="search-row">
            <span>Search markets</span>
            <input
              type="search"
              placeholder="Search by title"
              value={searchQuery()}
              onInput={(event) => setSearchQuery(event.target.value)}
            />
            <button type="button" class="post-action" onClick={setSearchNow}>
              Search
            </button>
          </label>

          <Show when={createEventMessage()}>
            <p class="success">{createEventMessage()}</p>
          </Show>
          <Show when={createEventError()}>
            <p class="error">{createEventError()}</p>
          </Show>

          <Show when={authed() && isAdmin()}>
            <form class="market-create-form" onSubmit={handleCreateEvent}>
              <div class="form-group">
                <span>Market title</span>
                <input
                  type="text"
                  value={eventTitle()}
                  onInput={(event) => setEventTitle(event.target.value)}
                  placeholder="e.g. Will X happen by date"
                />
              </div>
              <div class="form-group">
                <span>Details</span>
                <textarea
                  value={eventDetails()}
                  onInput={(event) => setEventDetails(event.target.value)}
                  placeholder="Add context for the market"
                />
              </div>
              <div class="form-group">
                <span>Closing date</span>
                <input
                  type="datetime-local"
                  value={eventClosingDate()}
                  onInput={(event) => setEventClosingDate(event.target.value)}
                />
              </div>
              <div class="form-actions">
                <button type="submit" class="post-action" disabled={creatingEvent()}>
                  {creatingEvent() ? 'Creating…' : 'Create market'}
                </button>
              </div>
            </form>
          </Show>

          <Show when={loadingEvents()}>
            <p class="muted">Loading market list…</p>
          </Show>

          <Show when={!loadingEvents() && filteredEvents().length === 0}>
            <p class="empty-feed">
              {searchQuery().trim() || filter() !== 'all'
                ? 'No markets found for your selected filters.'
                : 'No markets found.'}
            </p>
          </Show>

          <div class="prediction-list">
            <For each={filteredEvents()}>
              {(marketItem) => (
                <MarketEventCard
                  event={marketItem}
                  position={positionsByEventId().get(String(marketItem.id))}
                  onTrade={handleTrade}
                  canResolve={authed() && isAdmin()}
                  onResolve={handleResolve}
                  authenticated={authed()}
                  predicted={predictedEventIds().has(String(marketItem.id))}
                />
              )}
            </For>
          </div>
        </section>

        <aside class="predictions-sidebars">
          <section class="predictions-my-predictions">
            <h2>My Predictions</h2>
            <Show when={loadingPredictions()}>
              <p class="muted">Loading your predictions…</p>
            </Show>
            <Show when={!authed()}>
              <p class="empty-feed">Log in to view your prediction history.</p>
            </Show>
            <Show
              when={authed() && predictions().length === 0 && !loadingPredictions()}
            >
              <p class="empty-feed">No predictions yet.</p>
            </Show>
            <For each={predictions()}>
              {(prediction) => (
                <article class="prediction-card small">
                  <div class="prediction-card-header">
                    <h3>{prediction.event || `Market #${prediction.event_id}`}</h3>
                    <span class={`prediction-outcome ${outcomeLabel(prediction.outcome).toLowerCase()}`}>
                      {outcomeLabel(prediction.outcome)}
                    </span>
                  </div>
                  <p>
                    You predicted <strong>{prediction.prediction_value}</strong> with{' '}
                    {prediction.confidence}% confidence.
                  </p>
                </article>
              )}
            </For>
          </section>

          <section class="predictions-sidebar">
            <div class="leaderboard-header">
              <h2>Reputation Leaderboard</h2>
              <button
                type="button"
                class="post-action"
                onClick={loadLeaderboard}
                disabled={loadingLeaderboard()}
              >
                {loadingLeaderboard() ? 'Refreshing…' : 'Refresh'}
              </button>
            </div>
            <Show when={loadingLeaderboard()}>
              <p class="muted">Loading leaderboard…</p>
            </Show>
            <For each={leaderboard()}>
              {(entry, index) => (
                <article class="prediction-card small">
                  <div class="prediction-card-header">
                    <span class="prediction-rank">#{String(index() + 1)}</span>
                    <span>{entry.username || `User ${entry.user_id || 'anon'}`}</span>
                  </div>
                  <p class="muted">Rep points: {entry.rep_points ?? entry.reputation ?? 0}</p>
                </article>
              )}
            </For>
            <Show when={leaderboard().length === 0 && !loadingLeaderboard()}>
              <p class="empty-feed">No reputation scores yet.</p>
            </Show>
          </section>
        </aside>
      </div>
    </section>
  );
}
