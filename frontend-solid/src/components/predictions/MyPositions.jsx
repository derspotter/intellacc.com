import { createEffect, createMemo, createSignal, For, Show } from 'solid-js';
import { getUserPositions } from '../../services/api';
import MarketEventCard from './MarketEventCard';
import OutcomeMarketCard from './OutcomeMarketCard';
import DistributionMarketCard from './DistributionMarketCard';
import { isAuthenticated, getCurrentUserId } from '../../services/auth';
import { activateOnKey } from '../../utils/keyboard';
import { groupPositions } from '../../lib/positionGroups';

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

const isNumeric = (eventItem) => eventItem?.event_type === 'numeric';
const isMultipleChoice = (eventItem) => eventItem?.event_type === 'multiple_choice';

export default function MyPositions(props) {
  const [userPositions, setUserPositions] = createSignal([]);
  const [positionsLoading, setPositionsLoading] = createSignal(false);
  const [positionsError, setPositionsError] = createSignal('');
  const [expandedPositionIds, setExpandedPositionIds] = createSignal(new Set());
  const [hasLoadedPositions, setHasLoadedPositions] = createSignal(false);
  const [loadedPositionsUserId, setLoadedPositionsUserId] = createSignal('');

  const authed = () => isAuthenticated();

  const togglePositionExpanded = (id) => {
    setExpandedPositionIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
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
    setPositionsError('');
    try {
      const response = await getUserPositions(userId);
      setUserPositions(normalizeRows(response));
    } catch (err) {
      setUserPositions([]);
      setPositionsError(err?.message || 'Failed to load your positions.');
    } finally {
      setPositionsLoading(false);
    }
  };

  const handleTradeRefresh = () => {
    void loadUserPositions();
  };

  // One entry per invested market. Open positions sorted most-urgent-first,
  // recently resolved ones after, newest resolution first.
  // One entry per invested market (open first by closing date, then resolved
  // newest first) — shared with the profile pages via lib/positionGroups.
  const positionGroups = createMemo(() => groupPositions(userPositions()));

  // Stable row identity for <For>: iterate primitive string ids (in the same
  // open-then-resolved order as positionGroups().all) instead of the
  // rebuilt group objects above. positionGroups() creates brand-new group
  // objects on every recomputation of userPositions(), so keying <For> off
  // those objects made every row unmount/remount after each trade refresh,
  // wiping the expanded trading card's local state (success message,
  // selected outcome, stake input). Primitive values are reconciled by
  // value, so an unchanged id list keeps the rows (and their mounted
  // cards) alive across refreshes.
  const positionGroupsById = createMemo(() => positionGroups().byId);
  const positionRowIds = createMemo(() => positionGroups().all.map((g) => String(g.event.id)));

  const settledOutcomeText = (group) => {
    if (group.resolutionLabel) return group.resolutionLabel;
    const raw = String(group.event.outcome || '').toLowerCase();
    if (raw.includes('yes')) return 'YES';
    if (raw.includes('no')) return 'NO';
    return 'Resolved';
  };

  // Load positions on mount for the authed user, and whenever the logged-in
  // user changes (mirrors the pattern EventsList used before extraction).
  createEffect(() => {
    if (!hasLoadedPositions()) {
      setHasLoadedPositions(true);
      if (authed()) {
        void loadUserPositions();
      }
      return;
    }

    if (!authed()) {
      setUserPositions([]);
      setLoadedPositionsUserId('');
      return;
    }

    const userId = String(getCurrentUserId() || '');
    if (!userId) {
      return;
    }

    if (!positionsLoading() && loadedPositionsUserId() !== userId) {
      setLoadedPositionsUserId(userId);
      void loadUserPositions();
    }
  });

  return (
    <div class="my-positions-card">
      <h2>{`My Positions (${positionGroups().open.length})`}</h2>

      <Show when={positionsError()}>
        <div class="my-positions-error">
          <p>{positionsError()}</p>
          <button type="button" class="secondary" onClick={() => void loadUserPositions()}>
            Retry
          </button>
        </div>
      </Show>

      <Show when={positionsLoading() && positionRowIds().length === 0 && !positionsError()}>
        {/* Reserve row-height space while loading so real content does not
            shift the layout when it arrives (avoids CLS pop-in). */}
        <ul class="events-simple-list my-positions-skeleton" aria-hidden="true">
          <For each={[0, 1, 2]}>{() => <li class="my-positions-skeleton-row" />}</For>
        </ul>
        <span class="sr-only" role="status">Loading positions…</span>
      </Show>

      <Show when={!positionsLoading() && positionRowIds().length === 0 && !positionsError()}>
        <div class="my-positions-empty">
          <p>No open positions yet.</p>
          <a href="#predictions/markets">Browse markets</a>
        </div>
      </Show>

      <Show when={positionRowIds().length > 0}>
        <ul class="events-simple-list" data-primary-list>
          <For each={positionRowIds()}>
            {(id) => {
              const group = () => positionGroupsById().get(id);
              const rowKey = `pos-${id}`;
              const isResolved = () => group()?.kind === 'resolved';
              const prob = () => Number(group()?.event?.market_prob ?? 0.5);
              return (
                <Show when={group()}>
                  <li
                    class={`event-list-item ${isResolved() ? 'position-resolved' : ''} ${expandedPositionIds().has(rowKey) ? 'expanded' : ''}`}
                  >
                    <div
                      class="event-list-item-row"
                      data-kb-row
                      onClick={() => {
                        if (!isResolved()) togglePositionExpanded(rowKey);
                      }}
                      {...(!isResolved()
                        ? {
                            role: 'button',
                            tabindex: '0',
                            'aria-expanded': expandedPositionIds().has(rowKey),
                            onKeyDown: activateOnKey(() => togglePositionExpanded(rowKey)),
                          }
                        : { tabindex: '-1' })}
                    >
                      <div class="event-list-item-header">
                        <span class="event-title">{group().event.title}</span>
                        <Show when={!isNumeric(group().event)}>
                          <span class="event-prob">{formatProbability(group().event.market_prob || 0.5)}</span>
                        </Show>
                      </div>
                      <Show when={!isNumeric(group().event)}>
                        <div class="event-prob-bar" aria-hidden="true">
                          <div class="event-prob-bar-fill" style={{ width: `${Math.round(prob() * 100)}%` }} />
                        </div>
                      </Show>
                      <div class="event-list-item-meta">
                        <Show
                          when={!isNumeric(group().event)}
                          fallback={
                            <Show when={group().numericBins > 0}>
                              <span class="event-category">
                                {`Distribution · ${group().numericBins} bins · ${group().numericShares.toFixed(1)} sh`}
                              </span>
                            </Show>
                          }
                        >
                          <Show when={group().outcomes.length > 0}>
                            <span class="event-category">
                              {group().outcomes.map((o) => `${o.label} ×${o.shares.toFixed(1)}`).join(' · ')}
                            </span>
                          </Show>
                        </Show>
                        <Show when={!isResolved()}>
                          <span class="event-date">{`Closes: ${formatDate(group().event.closing_date)}`}</span>
                        </Show>
                        <Show when={group().hidden}>
                          <span class="event-unlisted-tag">Unlisted</span>
                        </Show>
                        <Show when={isResolved()}>
                          <span class="event-settled-tag">{`Settled: ${settledOutcomeText(group())}`}</span>
                        </Show>
                      </div>
                    </div>
                    <Show when={!isResolved() && expandedPositionIds().has(rowKey)}>
                      <div class="event-row-expanded">
                        <Show
                          when={isNumeric(group().event)}
                          fallback={
                            <Show
                              when={isMultipleChoice(group().event)}
                              fallback={
                                <MarketEventCard
                                  event={group().event}
                                  onTrade={handleTradeRefresh}
                                  onVerificationNotice={props.onVerificationNotice}
                                  hideTitle={true}
                                  authenticated={authed()}
                                />
                              }
                            >
                              <OutcomeMarketCard
                                event={group().event}
                                onTrade={handleTradeRefresh}
                                onVerificationNotice={props.onVerificationNotice}
                                hideTitle={true}
                              />
                            </Show>
                          }
                        >
                          <DistributionMarketCard
                            event={group().event}
                            onTrade={handleTradeRefresh}
                            onVerificationNotice={props.onVerificationNotice}
                            hideTitle={true}
                          />
                        </Show>
                      </div>
                    </Show>
                  </li>
                </Show>
              );
            }}
          </For>
        </ul>
      </Show>
    </div>
  );
}
