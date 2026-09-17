import { Show } from 'solid-js';

// Persuasive Alpha attribution badge: did trades referred by this post move
// markets? (Market chips themselves render in PostCritiques, which owns the
// linked market + candidate list in one place.)
export default function PostMarkets(props) {
  const signal = () => props.signal;

  const movedMarkets = () => Number(signal()?.episode_count || 0) > 0;
  const moveLabel = () => {
    const data = signal() || {};
    const movePp = Math.round(Number(data.max_prob_move || 0) * 100);
    const marketWord = Number(data.market_count) === 1 ? 'a market' : `${data.market_count} markets`;
    return `Moved ${marketWord}${movePp > 0 ? ` · biggest move ${movePp} pp` : ''}`;
  };

  return (
    <Show when={movedMarkets()}>
      <div class="post-markets-container" style={{ margin: '8px 0' }}>
        <div class="post-signal-badge" title="Readers traded on linked markets via this post and the market moved meaningfully">
          {moveLabel()}
        </div>
      </div>
    </Show>
  );
}
