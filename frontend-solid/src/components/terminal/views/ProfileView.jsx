import { For, Show, createEffect, createSignal } from 'solid-js';
import {
  createDirectMessage,
  followUser,
  getCurrentUser,
  getFollowers,
  getFollowing,
  getFollowingStatus,
  getPredictions,
  getUser,
  unfollowUser
} from '../../../services/api';
import { getCurrentUserId } from '../../../services/auth';
import { isLoggedIn } from '../../../services/tokenService';

const fmtRP = (v) => `${(Number(v) || 0).toFixed(2)} RP`;

const Stat = (props) => (
  <div class="bg-bb-panel border border-bb-border p-2" data-testid={props.testid}>
    <div class="text-xxs text-bb-muted uppercase">{props.label}</div>
    <div class="text-lg font-bold text-bb-accent">{props.value}</div>
  </div>
);

export default function ProfileView(props) {
  const [profile, setProfile] = createSignal(null);
  const [predictions, setPredictions] = createSignal([]);
  const [following, setFollowing] = createSignal(null); // null | boolean
  const [network, setNetwork] = createSignal(null); // null | { followers, following }
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal('');

  let loadEpoch = 0;

  const targetId = () => (props.param ? String(props.param) : null);
  const isOwn = () => {
    const current = getCurrentUserId();
    if (!targetId()) return true;
    return current != null && String(current) === targetId();
  };

  createEffect(() => {
    const id = targetId();
    setProfile(null);
    setPredictions([]);
    setFollowing(null);
    setNetwork(null);
    setError('');
    const epoch = ++loadEpoch;
    const load = async () => {
      try {
        const p = id && !isOwn() ? await getUser(id) : await getCurrentUser();
        if (epoch !== loadEpoch) return;
        setProfile(p?.user || p);
        if (isOwn()) {
          getPredictions().then((rows) => {
            if (epoch !== loadEpoch) return;
            const items = Array.isArray(rows) ? rows : (rows?.items || rows?.predictions || []);
            setPredictions(items.slice(0, 5));
          }).catch(() => {});
        } else if (isLoggedIn()) {
          getFollowingStatus(id).then((s) => {
            if (epoch !== loadEpoch) return;
            setFollowing(Boolean(s?.isFollowing));
          }).catch(() => {});
        }
      } catch (e) {
        if (epoch !== loadEpoch) return;
        setError(e?.message || 'FAILED TO LOAD PROFILE');
      }
    };
    load();
  });

  const toggleFollow = async () => {
    const id = targetId();
    if (!id || busy()) return;
    setBusy(true);
    try {
      if (following()) {
        await unfollowUser(id);
        setFollowing(false);
      } else {
        await followUser(id);
        setFollowing(true);
      }
    } catch (e) {
      setError(e?.message || 'FOLLOW ACTION FAILED');
    } finally {
      setBusy(false);
    }
  };

  const loadNetwork = async () => {
    const id = targetId() || String(getCurrentUserId() || '');
    if (!id) return;
    try {
      const [flw, fin] = await Promise.all([
        getFollowers(id).catch(() => []),
        getFollowing(id).catch(() => [])
      ]);
      const rows = (v, keys) => Array.isArray(v) ? v : (keys.map(k => v?.[k]).find(Array.isArray) || []);
      setNetwork({
        followers: rows(flw, ['items', 'followers']),
        following: rows(fin, ['items', 'following'])
      });
    } catch { /* per-call catches above */ }
  };

  const message = async () => {
    try {
      await createDirectMessage(targetId());
      window.location.hash = '#messages';
    } catch (e) {
      setError(e?.message || 'FAILED TO START DM');
    }
  };

  return (
    <div class="p-4 font-mono text-sm max-w-3xl">
      <Show when={error()}>
        <div class="mb-3 p-2 border border-market-down/50 bg-market-down/10 text-market-down text-xs">ERROR // {error().toUpperCase()}</div>
      </Show>
      <Show when={profile()} fallback={<div class="text-bb-muted animate-pulse">RUNNING QUERY...</div>}>
        <div class="flex items-baseline justify-between border-b border-bb-border pb-2 mb-4">
          <div>
            <span class="text-bb-accent font-bold text-lg">@{profile().username}</span>
            <Show when={profile().display_name}>
              <span class="text-bb-muted ml-2">// {profile().display_name}</span>
            </Show>
          </div>
          <div class="flex gap-2 text-xs">
            <Show when={!isOwn() && isLoggedIn()}>
              <button
                type="button"
                data-testid="profile-follow"
                disabled={busy() || following() == null}
                onClick={toggleFollow}
                class="px-2 py-1 border border-bb-accent text-bb-accent hover:bg-bb-accent/20 disabled:opacity-50 uppercase font-bold"
              >
                {following() ? '[UNFOLLOW]' : '[FOLLOW]'}
              </button>
              <button
                type="button"
                data-testid="profile-message"
                onClick={message}
                class="px-2 py-1 border border-bb-border text-bb-text hover:bg-white/10 uppercase font-bold"
              >
                [MSG]
              </button>
            </Show>
          </div>
        </div>

        <Show when={profile().bio}>
          <p class="text-bb-text mb-4 whitespace-pre-wrap">{profile().bio}</p>
        </Show>

        <div class="grid grid-cols-2 md:grid-cols-3 gap-2 mb-4">
          <Stat testid="profile-stat-balance" label="Available" value={fmtRP(profile().rp_balance)} />
          <Stat testid="profile-stat-staked" label="Staked" value={fmtRP(profile().rp_staked)} />
          <Stat
            testid="profile-stat-reputation"
            label="Reputation"
            value={fmtRP(profile().total_reputation ?? (Number(profile().rp_balance) || 0) + (Number(profile().rp_staked) || 0))}
          />
        </div>

        <Show when={isOwn() && predictions().length > 0}>
          <div class="mb-4">
            <div class="text-bb-accent font-bold uppercase text-xs border-b border-bb-border pb-1 mb-2">[RECENT PREDICTIONS]</div>
            <For each={predictions()}>
              {(p) => (
                <div class="flex justify-between gap-3 py-1 border-b border-bb-border/20 text-xs">
                  <span class="truncate">{p.event || p.title || `EVENT ${p.event_id}`}</span>
                  <span class="text-bb-muted shrink-0 uppercase">{p.outcome || 'PENDING'}</span>
                </div>
              )}
            </For>
          </div>
        </Show>

        <Show
          when={network()}
          fallback={
            <button
              type="button"
              data-testid="profile-load-network"
              onClick={loadNetwork}
              class="px-2 py-1 border border-bb-border text-bb-muted hover:text-bb-accent hover:border-bb-accent uppercase text-xs font-bold"
            >
              [LOAD FOLLOWERS / FOLLOWING]
            </button>
          }
        >
          <div class="grid md:grid-cols-2 gap-4">
            <For each={[['FOLLOWERS', network().followers], ['FOLLOWING', network().following]]}>
              {([label, rows]) => (
                <div>
                  <div class="text-bb-accent font-bold uppercase text-xs border-b border-bb-border pb-1 mb-2">[{label}: {rows.length}]</div>
                  <Show when={rows.length > 0} fallback={<div class="text-bb-muted text-xs">NONE</div>}>
                    <For each={rows}>
                      {(row) => (
                        <button
                          type="button"
                          class="block w-full text-left py-1 border-b border-bb-border/20 text-xs hover:bg-white/5"
                          onClick={() => { window.location.hash = `#user/${row.id || row.user_id}`; }}
                        >
                          <span class="font-bold">@{row.username}</span>
                          <Show when={row.accuracy_percent != null}>
                            <span class="text-bb-muted ml-2">{row.accuracy_percent}%</span>
                          </Show>
                        </button>
                      )}
                    </For>
                  </Show>
                </div>
              )}
            </For>
          </div>
        </Show>
      </Show>
    </div>
  );
}
