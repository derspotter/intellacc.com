import { createEffect, createMemo, createSignal, For, Show } from 'solid-js';
import { getEvents, getUserPositions, api } from '../../services/api';
import MarketEventCard from './MarketEventCard';
import { isAdmin, isAuthenticated, getCurrentUserId } from '../../services/auth';

const formatProbability = (value) => {
  const parsed = Number(value);
  if (Number.isNaN(parsed)) {
    return '0.0%';
  }
  return `${(parsed * 100).toFixed(1)}%`;
};

const formatDate = (value) => {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return 'No date';
  }
  return parsed.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  });
};

const normalizeRows = (payload) => {
  if (!payload) return [];
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.items)) return payload.items;
  if (Array.isArray(payload?.events)) return payload.events;
  if (Array.isArray(payload?.leaderboard)) return payload.leaderboard;
  return [];
};

const nowCloseWindow = (hours = 24) => new Date(Date.now() + hours * 60 * 60 * 1000);

export default function EventsList(props) {
  const [events, setEvents] = createSignal([]);
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal(null);

  const [searchQuery, setSearchQuery] = createSignal('');
  const [filter, setFilter] = createSignal('all');
  const [selectedEvent, setSelectedEvent] = createSignal(null);

  const [userPositions, setUserPositions] = createSignal([]);
  const [positionsLoading, setPositionsLoading] = createSignal(false);

  const [weeklyAssignment, setWeeklyAssignment] = createSignal(null);
  const [weeklyLoading, setWeeklyLoading] = createSignal(false);
  const [weeklyError, setWeeklyError] = createSignal(null);

  const [hasLoadedEvents, setHasLoadedEvents] = createSignal(false);
  const [loadedWeeklyUserId, setLoadedWeeklyUserId] = createSignal('');
  const [loadedPositionsUserId, setLoadedPositionsUserId] = createSignal('');

  let searchTimeout;

  const authed = () => isAuthenticated();

  const loadEvents = async (search = '') => {
    try {
      setLoading(true);
      setError(null);

      const response = await getEvents(search);
      setEvents(normalizeRows(response));
      const loaded = normalizeRows(response);
      const current = selectedEvent();
      if (current && !loaded.some((item) => String(item.id) === String(current.id))) {
        setSelectedEvent(null);
      }
    } catch (errorMessage) {
      setError(errorMessage?.message || 'Failed to load prediction markets.');
      setEvents([]);
    } finally {
      setLoading(false);
    }
  };

  const loadUserPositions = async () => {
    if (!authed()) {
      setUserPositions([]);
      return;
    }

    const userId = getCurrentUserId();
    if (!userId) {
      setUserPositions([]);
      return;
    }

    setPositionsLoading(true);
    try {
      const response = await getUserPositions(userId);
      setUserPositions(normalizeRows(response));
    } catch {
      setUserPositions([]);
    } finally {
      setPositionsLoading(false);
    }
  };

  const loadWeeklyAssignment = async () => {
    if (!authed()) {
      setWeeklyAssignment(null);
      setWeeklyLoading(false);
      return;
    }

    const userId = getCurrentUserId();
    if (!userId) {
      setWeeklyAssignment(null);
      setWeeklyLoading(false);
      return;
    }

    setWeeklyLoading(true);
    setWeeklyError(null);

    try {
      const response = await api.weekly.getUserStatus(userId);
      if (!response?.success) {
        setWeeklyError(response?.error || 'Failed to load weekly assignment');
        setWeeklyAssignment(null);
        setWeeklyLoading(false);
        return;
      }

      const assignment = response.assignment || null;
      if (assignment && assignment.event_id) {
        const foundEvent = events().find((eventItem) => String(eventItem.id) === String(assignment.event_id));
        if (foundEvent) {
          setWeeklyAssignment({ ...assignment, event: foundEvent });
        } else {
          setWeeklyAssignment(assignment);
        }
      } else {
        setWeeklyAssignment(assignment);
      }
    } catch (err) {
      setWeeklyError(err?.message || 'Failed to load weekly assignment.');
      setWeeklyAssignment(null);
    } finally {
      setWeeklyLoading(false);
    }
  };

  const filteredEvents = createMemo(() => {
    const now = new Date();
    const closingWindow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    const positionEventIds = new Set(
      (userPositions() || []).map((position) => String(position.event_id))
    );

    return events().filter((eventItem) => {
      if (filter() === 'all') {
        return true;
      }

      if (filter() === 'open') {
        return !eventItem.outcome && new Date(eventItem.closing_date) > now;
      }

      if (filter() === 'closing-soon') {
        const closingDate = new Date(eventItem.closing_date);
        return (
          !eventItem.outcome &&
          closingDate > now &&
          closingDate <= closingWindow
        );
      }

      if (filter() === 'my-positions') {
        return positionEventIds.has(String(eventItem.id));
      }

      return true;
    }).sort((a, b) => {
      if (a.outcome && !b.outcome) return 1;
      if (!a.outcome && b.outcome) return -1;
      return new Date(a.closing_date) - new Date(b.closing_date);
    });
  });

  const clearSearch = () => {
    setSearchQuery('');
    setFilter('all');
    void loadEvents('');
  };

  const handleEventClick = (eventItem) => {
    setSelectedEvent(eventItem);
  };

  const handleStakeUpdate = () => {
    void loadEvents(searchQuery().trim());
    if (authed()) {
      void loadUserPositions();
    }
  };

  const refreshSelected = async () => {
    await loadEvents(searchQuery());
    if (authed()) {
      await loadUserPositions();
    }
  };

  const handleTradeRefresh = () => {
    void refreshSelected();
  };

  const handleSearchInput = (value) => {
    if (searchTimeout) {
      clearTimeout(searchTimeout);
    }

    searchTimeout = setTimeout(() => {
      loadEvents(value);
    }, 500);
  };

  const renderSelectedEvent = () => {
    if (selectedEvent()) {
      return (
        <div class="event-card-section">
          <h2>{selectedEvent().title || 'Selected market'}</h2>
          <MarketEventCard
            event={selectedEvent()}
            onTrade={handleTradeRefresh}
            onResolve={props.onResolve}
            onVerificationNotice={props.onVerificationNotice}
            canResolve={authed() && isAdmin()}
            hideTitle={true}
            authenticated={authed()}
          />
        </div>
      );
    }

    if (authed() && weeklyLoading()) {
      return (
        <div class="event-card-section">
          <h2>Select an Event</h2>
          <div class="selection-prompt">
            <p>Loading your weekly assignment...</p>
          </div>
        </div>
      );
    }

    if (authed() && weeklyAssignment() && weeklyAssignment().event) {
      const assignedEvent = weeklyAssignment().event;
      return (
        <div class="event-card-section weekly-assignment-active">
          <div class="event-card-header">
            <h2>{assignedEvent.title || 'Weekly Assignment'}</h2>
            <span class="assignment-status">
              {weeklyAssignment()?.weekly_assignment_completed ? '✅ Completed' : '⏳ Pending'}
            </span>
          </div>
          <div class="weekly-assignment-subheader">
            <h3>📅 Your Weekly Assignment</h3>
          </div>
          <MarketEventCard
            event={assignedEvent}
            onTrade={handleTradeRefresh}
            onResolve={props.onResolve}
            onVerificationNotice={props.onVerificationNotice}
            canResolve={authed() && isAdmin()}
            hideTitle={true}
          />
        </div>
      );
    }

    return (
      <div class="event-card-section">
        <h2>Select an Event</h2>
        <div class="selection-prompt">
          <p>Choose an event from the list above to view details, make predictions, and place bets.</p>
          {authed() ? <p>No weekly assignment available.</p> : null}
        </div>
      </div>
    );
  };

  createEffect(() => {
    if (!hasLoadedEvents()) {
      setHasLoadedEvents(true);
      void loadEvents('');
      return;
    }

    if (!authed()) {
      setUserPositions([]);
      setWeeklyAssignment(null);
      setLoadedWeeklyUserId('');
      setLoadedPositionsUserId('');
      return;
    }

    const userId = String(getCurrentUserId() || '');
    if (!userId) {
      return;
    }

    if (!weeklyLoading() && loadedWeeklyUserId() !== userId && weeklyError() === null) {
      setLoadedWeeklyUserId(userId);
      void loadWeeklyAssignment();
    }

    if (!positionsLoading() && loadedPositionsUserId() !== userId) {
      setLoadedPositionsUserId(userId);
      void loadUserPositions();
    }
  });

  return (
    <section class="events-container">
      <div class="events-list-card">
        <div class="events-list-header">
          <h2>Open Questions</h2>

          <div class="events-filters">
            <input
              type="text"
              placeholder="Search by title or category..."
              value={searchQuery()}
              onInput={(eventTarget) => {
                const nextValue = eventTarget.currentTarget.value;
                setSearchQuery(nextValue);
                handleSearchInput(nextValue.trim());
              }}
            />

            <select value={filter()} onChange={(eventTarget) => setFilter(eventTarget.currentTarget.value)}>
              <option value="all">All Events</option>
              <option value="open">Open Markets</option>
              <option value="closing-soon">Closing Soon (24h)</option>
              <Show when={authed()}>
                <option value="my-positions">My Positions</option>
              </Show>
            </select>
          </div>

          <div class="events-summary">
              {loading() ? (
                <p>Loading events...</p>
              ) : (
                <p>
                  {`Showing ${filteredEvents().length} of ${events().length} events`}
                  {(() => {
                    const openMarkets = filteredEvents().filter((eventItem) => !eventItem.outcome).length;
                    return openMarkets > 0 ? ` (${openMarkets} open markets)` : '';
                  })()}
                </p>
              )}
            </div>
          </div>

        <div class="events-list-content">
          <Show when={loading()}>
            <div class="events-loading">
              <div class="loading-spinner" />
              <p>Loading prediction markets...</p>
            </div>
          </Show>

          <Show when={error()}>
            <div class="events-error">
              <h3>⚠️ Error Loading Events</h3>
              <p>{`Error: ${error()}`}</p>
              <button type="button" onClick={() => void loadEvents()}>
                Retry
              </button>
            </div>
          </Show>

          <Show when={!loading() && !error()}>
            <Show when={filteredEvents().length === 0} fallback={null}>
              <div class="no-events">
                <h3>📭 No Events Found</h3>
                <p>
                  {searchQuery().trim()
                    ? 'No events match your search criteria.'
                    : 'No events available. Check back later for new prediction markets!'}
                </p>
                {searchQuery().trim() ? (
                  <button type="button" onClick={clearSearch}>
                    Clear Filters
                  </button>
                ) : null}
              </div>
            </Show>

            <Show when={filteredEvents().length > 0}>
              <ul class="events-simple-list">
                <For each={filteredEvents()}>
                  {(marketItem) => {
                    const cacheKey = `market-${marketItem.id}`;
                    return (
                      <li
                        class={`event-list-item ${selectedEvent() && String(selectedEvent().id) === String(marketItem.id) ? 'selected' : ''} ${marketItem.outcome ? 'resolved' : ''}`}
                        onClick={() => handleEventClick(marketItem)}
                      >
                        <div class="event-list-item-header">
                          <span class="event-title">{marketItem.title}</span>
                          <span class="event-prob">{formatProbability(marketItem.market_prob || 0.5)}</span>
                        </div>
                        <div class="event-list-item-meta">
                          <span class="event-category">{marketItem.category || 'General'}</span>
                          <span class="event-date">{`Closes: ${formatDate(marketItem.closing_date)}`}</span>
                          {marketItem.outcome ? <span class="event-resolved">✓ Resolved</span> : null}
                        </div>
                      </li>
                    );
                  }}
                </For>
              </ul>
            </Show>
          </Show>
        </div>

        <div class="events-actions">
          <button
            type="button"
            class="secondary"
            onClick={() => void loadEvents()}
            disabled={loading()}
          >
            {loading() ? 'Loading...' : '🔄 Refresh Markets'}
          </button>
        </div>
      </div>

      <div class="selected-event-container">
        <Show when={selectedEvent()}>
            <button
              type="button"
              class="back-button secondary"
              onClick={() => {
                setSelectedEvent(null);
              }}
            >
            ← Back to List
          </button>
        </Show>

        {renderSelectedEvent()}
      </div>
    </section>
  );
}
