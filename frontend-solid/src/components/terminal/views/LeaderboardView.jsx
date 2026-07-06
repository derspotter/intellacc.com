import { createEffect, createSignal, For, Show } from 'solid-js';
import {
  getLeaderboardFollowers,
  getLeaderboardFollowing,
  getLeaderboardGlobal,
  getLeaderboardNetwork,
  getLeaderboardUserRank
} from '../../../services/api';
import { getCurrentUserId, isAuthenticated } from '../../../services/auth';

const TABS = [
  { key: 'global', label: 'GLOBAL' },
  { key: 'followers', label: 'FOLLOWERS' },
  { key: 'following', label: 'FOLLOWING' },
  { key: 'network', label: 'NETWORK' }
];

const FETCHERS = {
  global: getLeaderboardGlobal,
  followers: getLeaderboardFollowers,
  following: getLeaderboardFollowing,
  network: getLeaderboardNetwork
};

const fmtRP = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(2) : '0.00';
};

export default function LeaderboardView() {
  const [tab, setTab] = createSignal('global');
  const [rows, setRows] = createSignal([]);
  const [myRank, setMyRank] = createSignal(null);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal('');

  const isMe = (userId) => {
    const current = getCurrentUserId();
    return current != null && String(userId) === String(current);
  };

  createEffect(() => {
    const t = tab();
    setLoading(true);
    setError('');
    Promise.all([
      FETCHERS[t](25),
      isAuthenticated() ? getLeaderboardUserRank().catch(() => null) : Promise.resolve(null)
    ])
      .then(([entries, rank]) => {
        setRows(Array.isArray(entries?.leaderboard) ? entries.leaderboard : (entries || []));
        setMyRank(rank || null);
      })
      .catch((e) => {
        setError(e?.message || 'FAILED TO LOAD LEADERBOARD');
        setRows([]);
      })
      .finally(() => setLoading(false));
  });

  return (
    <div class="h-full flex flex-col font-mono text-sm">
      <div class="shrink-0 flex border-b border-bb-border bg-bb-panel text-xs select-none">
        <For each={TABS}>
          {(t) => (
            <button
              type="button"
              onClick={() => setTab(t.key)}
              class={`px-4 py-2 border-r border-bb-border uppercase ${
                tab() === t.key
                  ? 'bg-bb-accent/15 text-bb-accent font-bold'
                  : 'text-bb-muted hover:text-bb-text hover:bg-white/5'
              }`}
            >
              [{t.label}]
            </button>
          )}
        </For>
        <Show when={myRank()}>
          <div class="ml-auto px-4 py-2 text-bb-tmux">
            YOUR RANK: #{myRank().rank || '--'} // {fmtRP(myRank().total_reputation)} RP
          </div>
        </Show>
      </div>

      <div class="grid grid-cols-[6ch_minmax(0,1fr)_max-content_max-content] px-3 py-1 border-b border-bb-border text-bb-muted bg-bb-panel text-xs">
        <div>RANK</div>
        <div>USER</div>
        <div class="px-3 text-right">PRED</div>
        <div class="text-right">REP (RP)</div>
      </div>

      <div class="flex-1 overflow-y-auto custom-scrollbar">
        <Show when={!loading()} fallback={<div class="p-4 text-bb-muted animate-pulse">RUNNING QUERY...</div>}>
          <Show when={!error()} fallback={<div class="p-4 text-market-down text-xs">ERROR // {error().toUpperCase()}</div>}>
            <Show
              when={rows().length > 0}
              fallback={<div data-testid="leaderboard-empty" class="p-4 text-bb-muted">NO RANKED USERS</div>}
            >
              <div data-testid="leaderboard-rows">
                <For each={rows()}>
                  {(entry, index) => (
                    <div
                      class={`grid grid-cols-[6ch_minmax(0,1fr)_max-content_max-content] px-3 py-1 border-b border-bb-border/20 text-xs ${
                        isMe(entry.user_id) ? 'bg-bb-accent/10 text-bb-accent' : index() % 2 === 0 ? 'bg-bb-bg' : 'bg-[#0a0a0a]'
                      }`}
                    >
                      <div class="text-bb-muted">#{index() + 1}</div>
                      <div class="truncate font-bold">@{entry.username || `USER ${entry.user_id}`}</div>
                      <div class="px-3 text-right text-bb-muted">{entry.total_predictions ?? '--'}</div>
                      <div class="text-right text-market-up font-bold">{fmtRP(entry.total_reputation)}</div>
                    </div>
                  )}
                </For>
              </div>
            </Show>
          </Show>
        </Show>
      </div>
    </div>
  );
}
