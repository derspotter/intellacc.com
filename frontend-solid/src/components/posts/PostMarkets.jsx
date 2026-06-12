import { createSignal, createResource, Show, For } from 'solid-js';
import api from '../../services/api';
import { isAuthenticated } from '../../services/auth';

const fetchMarkets = async (postId) => {
  if (!isAuthenticated()) {
    return [];
  }
  try {
    const res = await api.posts.getMarkets(postId);
    return res.markets || res || [];
  } catch (err) {
    console.error('Failed to load markets for post', postId, err);
    return [];
  }
};

// Persuasive Alpha attribution: did trades referred by this post move markets?
const fetchSignalSummary = async (postId) => {
  if (!isAuthenticated()) {
    return null;
  }
  try {
    return await api.posts.getSignalSummary(postId);
  } catch (err) {
    return null;
  }
};

export default function PostMarkets(props) {
  const [markets] = createResource(() => props.postId, fetchMarkets);
  const [signal] = createResource(() => props.postId, fetchSignalSummary);

  const movedMarkets = () => Number(signal()?.episode_count || 0) > 0;
  const moveLabel = () => {
    const data = signal() || {};
    const movePp = Math.round(Number(data.max_prob_move || 0) * 100);
    const marketWord = Number(data.market_count) === 1 ? 'a market' : `${data.market_count} markets`;
    return `Moved ${marketWord}${movePp > 0 ? ` · biggest move ${movePp} pp` : ''}`;
  };

  const handleMarketClick = async (e, eventId) => {
    // We let the link navigation happen naturally, just record the click asynchronously
    try {
      await api.posts.marketClick(props.postId, eventId);
    } catch (err) {
      console.error('Failed to register market click:', err);
    }
  };

  return (
    <Show when={markets() && markets().length > 0}>
      <div class="post-markets-container" style={{ margin: '8px 0' }}>
        <div class="post-markets-list" style={{ display: 'flex', 'flex-wrap': 'wrap', gap: '8px' }}>
          <For each={markets()}>
            {(market) => (
              <a
                href={`#predictions`}
                class="market-chip"
                style={{
                  background: 'var(--bg-secondary, rgba(0, 123, 255, 0.1))',
                  color: 'var(--text-primary, #007bff)',
                  padding: '4px 10px',
                  'border-radius': 'var(--border-radius)',
                  'font-size': '0.85em',
                  'text-decoration': 'none',
                  cursor: 'pointer',
                  border: '1px solid var(--border-color, rgba(0,0,0,0.1))'
                }}
                onClick={(e) => handleMarketClick(e, market.event_id)}
              >
                <span class="market-chip-title">{market.title}</span>
                {' '}
                <Show when={market.market_prob != null}>
                  <span class="market-chip-prob" style={{ 'font-weight': 'bold' }}>
                    {Math.round(market.market_prob * 100)}%
                  </span>
                </Show>
              </a>
            )}
          </For>
        </div>
        <Show when={movedMarkets()}>
          <div class="post-signal-badge" title="Readers traded on linked markets via this post and the market moved meaningfully">
            📈 {moveLabel()}
          </div>
        </Show>
      </div>
    </Show>
  );
}
