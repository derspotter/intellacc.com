import { createEffect, createMemo, createSignal, For, Show } from 'solid-js';
import { getUserPositions, api } from '../../services/api';
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

const PAGE_SIZE = 100;

const appendUniqueById = (current, next) => {
  const seen = new Set(current.map((item) => String(item.id)));
  return [...current, ...next.filter((item) => !seen.has(String(item.id)))];
};

export default function EventsList(props) {
  const [events, setEvents] = createSignal([]);
  const [total, setTotal] = createSignal(0);
  const [hasMore, setHasMore] = createSignal(false);
  const [loadingMore, setLoadingMore] = createSignal(false);
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal(null);

  const [searchQuery, setSearchQuery] = createSignal('');
  const [filter, setFilter] = createSignal('open');
  const [categoryFilter, setCategoryFilter] = createSignal('');
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

  // Server-side filtered, paged like the post feed: append pages, never
  // download the full event table. `windowLimit` refreshes the whole loaded
  // window in one request (used after trades).
  const loadEvents = async ({ reset = true, windowLimit = null } = {}) => {
    try {
      if (reset) {
        setLoading(true);
      } else {
        setLoadingMore(true);
      }
      setError(null);

      const params = {
        search: searchQuery().trim(),
        topic: categoryFilter(),
        limit: windowLimit ? Math.min(windowLimit, 500) : PAGE_SIZE,
        offset: reset ? 0 : events().length
      };

      if (filter() === 'my-positions') {
        const ids = [...new Set((userPositions() || []).map((p) => Number(p.event_id)))];
        if (ids.length === 0) {
          setEvents([]);
          setTotal(0);
          setHasMore(false);
          return;
        }
        params.ids = ids;
        params.filter = 'all';
        params.limit = 500;
      } else {
        params.filter = filter();
      }

      const response = await api.events.getPage(params);
      const loaded = normalizeRows(response);
      setEvents((current) => (reset ? loaded : appendUniqueById(current, loaded)));
      setTotal(Number(response?.total ?? loaded.length));
      setHasMore(Boolean(response?.hasMore));

      const assignment = weeklyAssignment();
      if (assignment?.event_id || assignment?.event?.id) {
        const assignmentEventId = String(assignment.event_id || assignment.event?.id || '');
        const refreshedAssignmentEvent = events().find((item) => String(item.id) === assignmentEventId);
        if (refreshedAssignmentEvent) {
          setWeeklyAssignment({
            ...assignment,
            event: refreshedAssignmentEvent
          });
        }
      }
    } catch (errorMessage) {
      setError(errorMessage?.message || 'Failed to load prediction markets.');
      if (reset) {
        setEvents([]);
        setTotal(0);
      }
      setHasMore(false);
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  };

  const loadMore = async () => {
    if (loading() || loadingMore() || !hasMore()) return;
    await loadEvents({ reset: false });
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

    const fetchKey = marketId;
    if (lastTargetedSelectionFetchKey === fetchKey) {
      return;
    }

    // Deep-linked market may be outside the loaded page window — fetch it
    // directly and add it to the list.
    lastTargetedSelectionFetchKey = fetchKey;
    void api.events
      .getById(marketId)
      .then((eventRow) => {
        if (!eventRow?.id) return;
        setEvents((current) => appendUniqueById(current, [eventRow]));
        applyTargetedSelection();
      })
      .catch(() => {});
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
          // Assigned event may be outside the loaded page window.
          setWeeklyAssignment(assignment);
          try {
            const eventRow = await api.events.getById(assignment.event_id);
            if (eventRow?.id) {
              setWeeklyAssignment({ ...assignment, event: eventRow });
            }
          } catch {
            /* keep assignment without pinned event */
          }
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

  // Filtering and sorting happen server-side now (the list is paginated);
  // loaded rows are already in display order.
  const filteredEvents = createMemo(() => events());

  const clearSearch = () => {
    setSearchQuery('');
    setFilter('open');
    setCategoryFilter('');
    void loadEvents({ reset: true });
  };

  // Most common categories for the dropdown: topics with at least one visible
  // event, ordered by event count. Server-counted, since the list itself is
  // paginated and never fully loaded client-side.
  const [topicOptions, setTopicOptions] = createSignal([]);
  const loadTopicOptions = async () => {
    try {
      const response = await api.topics.list();
      const rows = (response?.topics || [])
        .filter((topic) => Number(topic.event_count) > 0)
        .sort((a, b) => b.event_count - a.event_count || a.name.localeCompare(b.name));
      setTopicOptions(rows);
    } catch {
      setTopicOptions([]);
    }
  };

  const handleCategoryChange = (value) => {
    setCategoryFilter(value);
    void loadEvents({ reset: true });
  };

  // Independent toggles (multiple rows may be open). Expanding a row never
  // collapses another, so the clicked question never moves — controls fold in
  // below it, strictly in place. This is the only behaviour that guarantees no
  // movement; one-at-a-time would slam the clicked row up by the closing
  // card's height when that card is above it near the top of the page.
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
    // Refresh everything the user has loaded so far in one request.
    await loadEvents({ reset: true, windowLimit: Math.max(events().length, PAGE_SIZE) });
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
      void loadEvents({ reset: true });
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

  const handleFilterChange = async (value) => {
    setFilter(value);
    if (value === 'my-positions' && authed() && (userPositions() || []).length === 0) {
      await loadUserPositions();
    }
    void loadEvents({ reset: true });
  };

  createEffect(() => {
    if (!hasLoadedEvents()) {
      setHasLoadedEvents(true);
      void loadEvents({ reset: true });
      void loadTopicOptions();
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
              placeholder="Search titles..."
              value={searchQuery()}
              onInput={(eventTarget) => {
                const nextValue = eventTarget.currentTarget.value;
                setSearchQuery(nextValue);
                handleSearchInput(nextValue.trim());
              }}
            />

            <select
              class="events-category-filter"
              value={categoryFilter()}
              onChange={(eventTarget) => handleCategoryChange(eventTarget.currentTarget.value)}
            >
              <option value="">All categories</option>
              <For each={topicOptions()}>
                {(topic) => <option value={topic.name}>{`${topic.name} (${topic.event_count})`}</option>}
              </For>
            </select>

            <select value={filter()} onChange={(eventTarget) => void handleFilterChange(eventTarget.currentTarget.value)}>
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
                <p>{`Showing ${events().length} of ${total()} events`}</p>
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
                  {searchQuery().trim() || categoryFilter()
                    ? 'No events match your search criteria.'
                    : 'No events available. Check back later for new prediction markets!'}
                </p>
                {searchQuery().trim() || categoryFilter() ? (
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
                            <span class="event-category">
                              {(marketItem.topics || []).length > 0
                                ? marketItem.topics.join(' · ')
                                : (marketItem.category || 'General')}
                            </span>
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
          <Show when={hasMore() && !loading() && !error()}>
            <button
              type="button"
              class="secondary"
              onClick={() => void loadMore()}
              disabled={loadingMore()}
            >
              {loadingMore() ? 'Loading…' : 'Load More'}
            </button>
          </Show>
          <button
            type="button"
            class="secondary"
            onClick={() => void refreshSelected()}
            disabled={loading()}
          >
            {loading() ? 'Loading...' : 'Refresh Markets'}
          </button>
        </div>
      </div>
    </section>
  );
}
