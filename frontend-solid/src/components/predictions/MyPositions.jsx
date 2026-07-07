import { createEffect, createMemo, createSignal, For, Show } from 'solid-js';
import { getUserPositions } from '../../services/api';
import MarketEventCard from './MarketEventCard';
import OutcomeMarketCard from './OutcomeMarketCard';
import { isAuthenticated, getCurrentUserId } from '../../services/auth';
import { activateOnKey } from '../../utils/keyboard';

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

const isMultiOutcome = (eventItem) =>
  ['multiple_choice', 'numeric'].includes(eventItem?.event_type);

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
  const positionGroups = createMemo(() => {
    const byId = new Map();
    for (const row of userPositions() || []) {
      const key = String(row.event_id);
      if (!byId.has(key)) {
        byId.set(key, {
          event: {
            id: row.event_id,
            title: row.event_title,
            closing_date: row.closing_date,
            market_prob: row.market_prob,
            cumulative_stake: row.cumulative_stake,
            liquidity_b: row.liquidity_b,
            event_type: row.event_type,
            outcome: row.outcome
          },
          kind: row.position_kind === 'resolved' ? 'resolved' : 'open',
          hidden: !!row.hidden_at,
          resolvedAt: row.resolved_at,
          resolutionLabel: row.resolution_outcome_label,
          outcomes: []
        });
      }
      const group = byId.get(key);
      if (row.outcome_label && Number(row.outcome_shares) > 0) {
        group.outcomes.push({ label: row.outcome_label, shares: Number(row.outcome_shares) });
      }
      if (Number(row.yes_shares) > 0) group.outcomes.push({ label: 'YES', shares: Number(row.yes_shares) });
      if (Number(row.no_shares) > 0) group.outcomes.push({ label: 'NO', shares: Number(row.no_shares) });
    }
    const groups = [...byId.values()];
    const open = groups
      .filter((g) => g.kind === 'open')
      .sort((a, b) => new Date(a.event.closing_date) - new Date(b.event.closing_date));
    const resolved = groups
      .filter((g) => g.kind === 'resolved')
      .sort((a, b) => new Date(b.resolvedAt) - new Date(a.resolvedAt));
    return { byId, open, resolved, all: [...open, ...resolved] };
  });

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
                        <span class="event-prob">{formatProbability(group().event.market_prob || 0.5)}</span>
                      </div>
                      <div class="event-prob-bar" aria-hidden="true">
                        <div class="event-prob-bar-fill" style={{ width: `${Math.round(prob() * 100)}%` }} />
                      </div>
                      <div class="event-list-item-meta">
                        <Show when={group().outcomes.length > 0}>
                          <span class="event-category">
                            {group().outcomes.map((o) => `${o.label} ×${o.shares.toFixed(1)}`).join(' · ')}
                          </span>
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
                          when={isMultiOutcome(group().event)}
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
