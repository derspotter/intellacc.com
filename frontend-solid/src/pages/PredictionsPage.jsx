import {
  createMemo,
  createSignal,
  createEffect,
  For,
  Show
} from 'solid-js';
import {
  createEvent,
  createPrediction,
  getEvents,
  getPredictions,
  getScoringLeaderboard,
  getPredictionLeaderboardFallback
} from '../services/api';
import { getCurrentUserId, isAdmin, isAuthenticated } from '../services/auth';

const normalizeRows = (payload) => {
  if (!payload) {
    return [];
  }
  if (Array.isArray(payload)) {
    return payload;
  }
  if (Array.isArray(payload.leaderboard)) {
    return payload.leaderboard;
  }
  return [];
};

const formatDate = (value) => {
  if (!value) {
    return 'No closing date';
  }
  try {
    return new Date(value).toLocaleString();
  } catch {
    return value;
  }
};

const formatOutcome = (outcome) => {
  if (!outcome) {
    return 'open';
  }
  return outcome === 'correct' ? 'correct' : 'resolved';
};

export default function PredictionsPage() {
  const [events, setEvents] = createSignal([]);
  const [predictions, setPredictions] = createSignal([]);
  const [leaderboard, setLeaderboard] = createSignal([]);
  const [loadingEvents, setLoadingEvents] = createSignal(false);
  const [loadingPredictions, setLoadingPredictions] = createSignal(false);
  const [loadingLeaderboard, setLoadingLeaderboard] = createSignal(false);
  const [errors, setErrors] = createSignal([]);
  const [search, setSearch] = createSignal('');
  const [eventTitle, setEventTitle] = createSignal('');
  const [eventDetails, setEventDetails] = createSignal('');
  const [eventClosingDate, setEventClosingDate] = createSignal('');
  const [creatingEvent, setCreatingEvent] = createSignal(false);
  const [createEventError, setCreateEventError] = createSignal('');
  const [createEventMessage, setCreateEventMessage] = createSignal('');
  const [submittedPrediction, setSubmittedPrediction] = createSignal(null);

  const userId = () => getCurrentUserId();
  const authed = () => isAuthenticated();

  const eventsByClosing = createMemo(() => {
    const items = [...events()];
    items.sort((a, b) => {
      const aDate = new Date(a.closing_date || 0).getTime();
      const bDate = new Date(b.closing_date || 0).getTime();
      return aDate - bDate;
    });
    return items;
  });

  const predictedEventIds = createMemo(() => {
    const map = new Set();
    predictions().forEach((prediction) => {
      map.add(String(prediction.event_id));
    });
    return map;
  });

  const pushError = (message) => {
    if (!message) {
      return;
    }
    setErrors((current) => [...current, message]);
  };

  const clearErrors = () => setErrors([]);

  const loadEvents = async () => {
    clearErrors();
    setLoadingEvents(true);
    try {
      const response = await getEvents(search().trim() || null);
      const nextEvents = normalizeRows(response);
      setEvents(nextEvents);
    } catch (error) {
      const message = error?.message || 'Failed to load market events.';
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
      pushError(error?.message || 'Failed to load your predictions.');
      setPredictions([]);
    } finally {
      setLoadingPredictions(false);
    }
  };

  const loadLeaderboard = async () => {
    setLoadingLeaderboard(true);
    try {
      const response = await getScoringLeaderboard(10);
      const rows = normalizeRows(response);
      setLeaderboard(rows);
    } catch (error) {
      const fallback = await getPredictionLeaderboardFallback().catch(() => []);
      setLeaderboard(normalizeRows(fallback));
    } finally {
      setLoadingLeaderboard(false);
    }
  };

  const loadAll = async () => {
    await Promise.all([loadEvents(), loadPredictions(), loadLeaderboard()]);
  };

  const handleCreateEvent = async (event) => {
    event.preventDefault();
    setCreateEventError('');
    setCreateEventMessage('');

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
      const next = [created, ...(events() || [])];
      setEvents(next);
      setCreateEventMessage('Market question created.');
      setEventTitle('');
      setEventDetails('');
      setEventClosingDate('');
    } catch (error) {
      setCreateEventError(error?.message || 'Failed to create question.');
    } finally {
      setCreatingEvent(false);
    }
  };

  const updatePredictionsForEvent = async (eventId) => {
    try {
      const response = await getPredictions();
      setPredictions(normalizeRows(response));
      setSubmittedPrediction(String(eventId));
      setTimeout(() => {
        if (submittedPrediction() === String(eventId)) {
          setSubmittedPrediction(null);
        }
      }, 1400);
    } catch (error) {
      pushError(error?.message || 'Prediction posted but list refresh failed.');
    }
  };

  const handleCreatePrediction = async (eventItem, formState) => {
    if (!authed()) {
      return;
    }

    const confidence = Number(formState.confidence());
    const predictionValue = formState.predictionValue();

    if (!predictionValue || Number.isNaN(confidence) || confidence < 1 || confidence > 100) {
      pushError('Prediction confidence must be between 1 and 100.');
      return;
    }

    try {
      const created = await createPrediction(eventItem.id, predictionValue, confidence);
      if (!created) {
        throw new Error('Prediction endpoint returned no payload.');
      }
      await updatePredictionsForEvent(eventItem.id);
      setSubmittedPrediction(String(eventItem.id));
      setTimeout(() => {
        setSubmittedPrediction(null);
      }, 1400);
    } catch (error) {
      pushError(error?.message || 'Failed to submit prediction.');
    }
  };

  const PredictionForm = (props) => {
    const [confidence, setConfidence] = createSignal('50');
    const [predictionValue, setPredictionValue] = createSignal('yes');
    const [submitting, setSubmitting] = createSignal(false);

    const eventItem = () => props.eventItem;

    return (
      <form
        class="prediction-form"
        onSubmit={async (event) => {
          event.preventDefault();
          if (submitting()) {
            return;
          }
          setSubmitting(true);
          try {
            await handleCreatePrediction(eventItem(), { confidence, predictionValue });
          } finally {
            setSubmitting(false);
          }
        }}
      >
        <label class="inline-field">
          <span>Prediction:</span>
          <select
            value={predictionValue()}
            onChange={(e) => setPredictionValue(e.target.value)}
          >
            <option value="yes">Yes</option>
            <option value="no">No</option>
          </select>
        </label>
        <label class="inline-field">
          <span>Confidence:</span>
          <input
            type="number"
            min={1}
            max={100}
            value={confidence()}
            onInput={(e) => setConfidence(e.target.value)}
          />
        </label>
        <button type="submit" class="post-action" disabled={submitting()}>
          {submitting() ? 'Submitting…' : 'Submit prediction'}
        </button>
      </form>
    );
  };

  createEffect(() => {
    const interval = setInterval(() => {
      void loadEvents();
      if (authed()) {
        void loadPredictions();
      }
    }, 120000);
    return () => clearInterval(interval);
  });

  createEffect(() => {
    void loadAll();
  });

  createEffect(() => {
    const userKnown = !!userId();
    if (!userKnown && !authed()) {
      setPredictions([]);
      return;
    }
    void loadPredictions();
  });

  return (
    <section class="predictions-page">
      <h1>Predictions & Betting</h1>

      <Show when={errors().length}>
        <div class="predictions-errors">
          <For each={errors()}>
            {(message) => <p class="error">{message}</p>}
          </For>
        </div>
      </Show>

      <Show when={!authed()}>
        <div class="login-notice">
          <p>Sign in to submit predictions and track your positions.</p>
          <button type="button" onClick={() => (window.location.hash = 'login')}>
            Sign in
          </button>
        </div>
      </Show>

      <div class="predictions-layout">
        <section class="predictions-events">
          <div class="predictions-section-head">
            <h2>Open Markets</h2>
            <Show when={authed() && isAdmin()}>
              <button
                type="button"
                class="post-action"
                onClick={() => {
                  const hasDraft = !!(eventTitle().trim() || eventDetails().trim());
                  if (!hasDraft) {
                    const now = new Date(Date.now() + 60 * 60 * 1000);
                    const value = new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
                    setEventClosingDate(value);
                  }
                }}
              >
                Quick set close time
              </button>
            </Show>
          </div>
          <label class="search-row">
            <span>Search</span>
            <input
              type="search"
              placeholder="Search by title"
              value={search()}
              onInput={(event) => setSearch(event.target.value)}
            />
            <button type="button" class="post-action" onClick={loadEvents}>
              Search
            </button>
          </label>

          <Show when={creatingEvent()}>
            <p class="muted">Creating market question…</p>
          </Show>

          <Show when={createEventMessage()}>
            <p class="success">{createEventMessage()}</p>
          </Show>
          <Show when={createEventError()}>
            <p class="error">{createEventError()}</p>
          </Show>

          <Show when={authed() && isAdmin()}>
            <form class="market-create-form" onSubmit={handleCreateEvent}>
              <label class="form-group">
                <span>Market title</span>
                <input
                  type="text"
                  value={eventTitle()}
                  onInput={(event) => setEventTitle(event.target.value)}
                />
              </label>
              <label class="form-group">
                <span>Details</span>
                <textarea
                  value={eventDetails()}
                  onInput={(event) => setEventDetails(event.target.value)}
                />
              </label>
              <label class="form-group">
                <span>Closing date</span>
                <input
                  type="datetime-local"
                  value={eventClosingDate()}
                  onInput={(event) => setEventClosingDate(event.target.value)}
                />
              </label>
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

          <Show when={!loadingEvents() && eventsByClosing().length === 0}>
            <p class="empty-feed">No markets found.</p>
          </Show>

          <div class="prediction-list">
            <For each={eventsByClosing()}>
              {(eventItem) => (
                <article class="prediction-card">
                  <div class="prediction-card-header">
                    <h3>{eventItem.title || 'Untitled market'}</h3>
                    <span class="muted">Closes: {formatDate(eventItem.closing_date)}</span>
                  </div>
                  <p class="prediction-card-detail">{eventItem.details || 'No details provided.'}</p>
                  <Show when={eventItem.outcome}>
                    <p class="prediction-outcome">Outcome: {eventItem.outcome}</p>
                  </Show>

                  <Show when={authed()}>
                    <Show
                      when={predictedEventIds().has(String(eventItem.id))}
                      fallback={<PredictionForm eventItem={eventItem} />}
                    >
                      <p class="success">
                        {submittedPrediction() === String(eventItem.id)
                          ? 'Prediction submitted.'
                          : 'You already predicted this market.'}
                      </p>
                    </Show>
                  </Show>
                  <Show when={!authed()}>
                    <p class="muted">Sign in to add your prediction.</p>
                  </Show>
                </article>
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
            <Show when={authed() && predictions().length === 0 && !loadingPredictions()}>
              <p class="empty-feed">No predictions yet.</p>
            </Show>
            <For each={predictions()}>
              {(prediction) => (
                <article class="prediction-card small">
                  <div class="prediction-card-header">
                    <h3>{prediction.event || `Market #${prediction.event_id}`}</h3>
                    <span class={`prediction-outcome ${formatOutcome(prediction.outcome)}`}>
                      {formatOutcome(prediction.outcome)}
                    </span>
                  </div>
                  <p>
                    You predicted <strong>{prediction.prediction_value}</strong> with {prediction.confidence}% confidence.
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
