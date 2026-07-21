import { Show, createEffect, createSignal, onCleanup, onMount } from 'solid-js';
import { getCurrentUser, getLeaderboardUserRank } from '../../services/api';
import { isLoggedIn } from '../../services/tokenService';

export default function TerminalRPBalance() {
  const [data, setData] = createSignal(null);

  const load = async () => {
    if (!isLoggedIn()) {
      setData(null);
      return;
    }
    const [user, rank] = await Promise.allSettled([getCurrentUser(), getLeaderboardUserRank()]);
    const u = user.status === 'fulfilled' ? user.value : null;
    const r = rank.status === 'fulfilled' ? rank.value : null;
    if (!u && !r) return; // keep last known value on transient failure
    setData((prev) => ({
      balance: u ? (Number(u.rp_balance) || 0) : (prev?.balance ?? 0),
      rank: r ? (r.rank || null) : (prev?.rank ?? null)
    }));
  };

  createEffect(() => {
    // re-run on login/logout
    isLoggedIn();
    load();
  });

  onMount(() => {
    window.addEventListener('rp-balance-refresh', load);
    onCleanup(() => window.removeEventListener('rp-balance-refresh', load));
  });

  return (
    <Show when={data()}>
      <button
        type="button"
        data-testid="rp-readout"
        class="hover:text-bb-accent cursor-pointer max-md:text-xs max-md:text-bb-bg max-md:p-0 max-md:border-none max-md:bg-transparent"
        title="Open leaderboard"
        onClick={() => { window.location.hash = '#leaderboard'; }}
      >
        RP:{data().balance.toFixed(2)}{data().rank ? ` #${data().rank}` : ''}
      </button>
    </Show>
  );
}
