import { createEffect, createMemo, createSignal, For, Show } from 'solid-js';
import { getEvents, getUserPositions, api } from '../../services/api';
import MarketEventCard from './MarketEventCard';
import { isAuthenticated, getCurrentUserId } from '../../services/auth';

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
  const [filter, setFilter] = createSignal('open');
  const [expandedIds, setExpandedIds] = createSignal(new Set());

  const isExpanded = (id) => expandedIds().has(String(id));

  const [userPositions, setUserPositions] = createSignal([]);
  const [positionsLoading, setPositionsLoading] = createSignal(false);

  const [weeklyAssignment, setWeeklyAssignment] = createSignal(null);
  const [weeklyLoading, setWeeklyLoading] = createSignal(false);
  const [weeklyError, setWeeklyError] = createSignal(null);

  const [hasLoadedEvents, setHasLoadedEvents] = createSignal(false);
  const [loadedWeeklyUserId, setLoadedWeeklyUserId] = createSignal('');
  const [loadedPositionsUserId, setLoadedPositionsUserId] = createSignal('');

  let searchTimeout;
  let lastTargetedSelectionFetchKey = '';

  const authed = () => isAuthenticated();

  const loadEvents = async (search = '') => {
    try {
      setLoading(true);
      setError(null);

      const response = await getEvents(search);
      const loaded = normalizeRows(response);
      setEvents(loaded);

      const assignment = weeklyAssignment();
      if (assignment?.event_id || assignment?.event?.id) {
        const assignmentEventId = String(assignment.event_id || assignment.event?.id || '');
        const refreshedAssignmentEvent = loaded.find((item) => String(item.id) === assignmentEventId);
        if (refreshedAssignmentEvent) {
          setWeeklyAssignment({
            ...assignment,
            event: refreshedAssignmentEvent
          });
        } else if (assignment?.event) {
          setWeeklyAssignment({
            ...assignment,
            event: null
          });
        }
      }
    } catch (errorMessage) {
      setError(errorMessage?.message || 'Failed to load prediction markets.');
      setEvents([]);
    } finally {
      setLoading(false);
    }
  };

  const applyTargetedSelection = () => {
    const marketId = String(props.targetedMarketId || '').trim();
    if (!marketId) return false;

    const targetEvent = events().find((eventItem) => String(eventItem.id) === marketId);
    if (!targetEvent) return false;

    setExpandedIds((prev) => {
      const next = new Set(prev);
      next.add(String(targetEvent.id));
      return next;
    });
    lastTargetedSelectionFetchKey = '';
    return true;
  };

  createEffect(() => {
    const marketId = String(props.targetedMarketId || '').trim();
    events(); // subscribe to events changes
    loading(); // subscribe to loading state

    if (!marketId) {
      lastTargetedSelectionFetchKey = '';
      return;
    }

    if (applyTargetedSelection()) {
      return;
    }

    if (loading()) {
      return;
    }

    const fetchKey = `${marketId}:${searchQuery().trim()}`;
    if (lastTargetedSelectionFetchKey === fetchKey) {
      return;
    }

    lastTargetedSelectionFetchKey = fetchKey;
    void loadEvents(searchQuery().trim());
  });

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
    setFilter('open');
    void loadEvents('');
  };

  // Independent toggles: expanding a row never collapses another, so the
  // clicked question stays put (controls fold in below it, in place).
  const handleEventClick = (eventItem) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      const key = String(eventItem.id);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  // Auto-expand the weekly assignment once it loads, unless something is
  // already expanded or a deep-link is targeting a specific market.
  createEffect(() => {
    const assignment = weeklyAssignment();
    const assignedId = assignment?.event?.id;
    if (assignedId && expandedIds().size === 0 && !props.targetedMarketId) {
      setExpandedIds(new Set([String(assignedId)]));
    }
  });

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

  // Weekly-assignment event pinned first (deduped), then the filtered list.
  const orderedRows = createMemo(() => {
    const rows = filteredEvents();
    const weekly = weeklyAssignment()?.event;
    if (!weekly) return rows;
    const rest = rows.filter((e) => String(e.id) !== String(weekly.id));
    return [weekly, ...rest];
  });

  const positionEventIds = createMemo(
    () => new Set((userPositions() || []).map((p) => String(p.event_id)))
  );

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
              <h3>Error Loading Events</h3>
              <p>{`Error: ${error()}`}</p>
              <button type="button" onClick={() => void loadEvents()}>
                Retry
              </button>
            </div>
          </Show>

          <Show when={!loading() && !error()}>
            <Show when={filteredEvents().length === 0} fallback={null}>
              <div class="no-events">
                <h3>No Events Found</h3>
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
                <For each={orderedRows()}>
                  {(marketItem) => {
                    const weeklyId = () => weeklyAssignment()?.event?.id;
                    const isWeekly = () => String(weeklyId() || '') === String(marketItem.id);
                    const prob = () => Number(marketItem.market_prob ?? 0.5);
                    return (
                      <li
                        class={`event-list-item ${isExpanded(marketItem.id) ? 'expanded' : ''} ${marketItem.outcome ? 'resolved' : ''} ${isWeekly() ? 'weekly' : ''}`}
                      >
                        <div class="event-list-item-row" onClick={() => handleEventClick(marketItem)}>
                          <div class="event-list-item-header">
                            <span class="event-title">{marketItem.title}</span>
                            <span class="event-prob">{formatProbability(marketItem.market_prob || 0.5)}</span>
                          </div>
                          <div class="event-prob-bar" aria-hidden="true">
                            <div class="event-prob-bar-fill" style={{ width: `${Math.round(prob() * 100)}%` }} />
                          </div>
                          <div class="event-list-item-meta">
                            <Show when={isWeekly()}>
                              <span class="event-weekly-tag">{`Weekly · ${weeklyAssignment()?.weekly_assignment_completed ? 'Completed' : 'Pending'}`}</span>
                            </Show>
                            <span class="event-category">{marketItem.category || 'General'}</span>
                            <span class="event-date">{`Closes: ${formatDate(marketItem.closing_date)}`}</span>
                            <Show when={positionEventIds().has(String(marketItem.id))}>
                              <span class="event-position-tag">Position</span>
                            </Show>
                            {marketItem.outcome ? <span class="event-resolved">Resolved</span> : null}
                          </div>
                        </div>
                        <Show when={isExpanded(marketItem.id)}>
                          <div class="event-row-expanded">
                            <MarketEventCard
                              event={marketItem}
                              onTrade={handleTradeRefresh}
                              onVerificationNotice={props.onVerificationNotice}
                              hideTitle={true}
                              authenticated={authed()}
                            />
                          </div>
                        </Show>
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
            {loading() ? 'Loading...' : 'Refresh Markets'}
          </button>
        </div>
      </div>
    </section>
  );
}
