import { createSignal, onMount, onCleanup, Show, For } from 'solid-js';
import api from '../../services/api';

const STANCES = ['agrees', 'disagrees', 'related'];
const MIN_SUGGEST_LENGTH = 8;

const formatProb = (prob) => (prob == null ? null : `${Math.round(Number(prob) * 100)}%`);

// Search-and-pick panel for attaching a market to a post. Shows AI suggestions
// for the given seed text (draft or post content) plus a manual search box.
export default function MarketPicker(props) {
  const [query, setQuery] = createSignal('');
  const [results, setResults] = createSignal([]);
  const [suggestions, setSuggestions] = createSignal([]);
  const [suggesting, setSuggesting] = createSignal(false);
  const [searching, setSearching] = createSignal(false);
  const [stance, setStance] = createSignal('related');
  const [error, setError] = createSignal('');

  let searchTimer = null;
  onCleanup(() => clearTimeout(searchTimer));

  const seed = () => String(props.seedText || '').trim();

  // Suggestions are fetched once per open (matchPreview embeds the text
  // server-side — too expensive to re-run per keystroke).
  onMount(() => {
    const text = seed();
    if (text.length < MIN_SUGGEST_LENGTH) {
      setSuggestions([]);
      return;
    }
    setSuggesting(true);
    api.posts.matchPreview(text)
      .then((res) => setSuggestions(Array.isArray(res?.markets) ? res.markets : []))
      .catch(() => setSuggestions([]))
      .finally(() => setSuggesting(false));
  });

  const runSearch = (text) => {
    if (!text) {
      setResults([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    api.events.getPage({ search: text, filter: 'open', limit: 8 })
      .then((res) => {
        const items = Array.isArray(res?.items) ? res.items : Array.isArray(res) ? res : [];
        setResults(items.slice(0, 8).map((event) => ({
          event_id: Number(event.id ?? event.event_id),
          title: event.title,
          market_prob: event.market_prob ?? null
        })));
        setError('');
      })
      .catch(() => setError('Search failed.'))
      .finally(() => setSearching(false));
  };

  const handleQueryInput = (event) => {
    const text = event.target.value;
    setQuery(text);
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => runSearch(text.trim()), 300);
  };

  const select = (market) => {
    props.onSelect?.(
      {
        event_id: Number(market.event_id),
        title: market.title,
        market_prob: market.market_prob ?? null
      },
      stance()
    );
  };

  const marketRow = (market, badge) => (
    <button
      type="button"
      class="market-picker-row"
      style={{
        display: 'flex', 'justify-content': 'space-between', 'align-items': 'center', gap: '8px',
        width: '100%', 'text-align': 'left', padding: '6px 8px', border: 'none',
        background: 'transparent', cursor: 'pointer', 'font-size': '0.85em'
      }}
      onClick={() => select(market)}
    >
      <span style={{ overflow: 'hidden', 'text-overflow': 'ellipsis', 'white-space': 'nowrap' }}>
        <Show when={badge}>
          <span class="muted" style={{ 'margin-right': '6px', 'font-size': '0.85em' }}>{badge}</span>
        </Show>
        {market.title}
      </span>
      <Show when={formatProb(market.market_prob)}>
        <span style={{ 'font-weight': 'bold', 'flex-shrink': 0 }}>{formatProb(market.market_prob)}</span>
      </Show>
    </button>
  );

  return (
    <div
      class="market-picker"
      style={{
        border: '1px solid var(--border-color, #ccc)', 'border-radius': '6px',
        padding: '8px', 'margin-top': '8px', background: 'var(--bg-secondary, #fafafa)'
      }}
    >
      <div style={{ display: 'flex', 'justify-content': 'space-between', 'align-items': 'center', gap: '8px' }}>
        <input
          type="text"
          class="market-picker-search"
          placeholder="Search markets…"
          value={query()}
          onInput={handleQueryInput}
          style={{ flex: 1, padding: '4px 8px', 'font-size': '0.9em' }}
        />
        <button type="button" class="post-action" onClick={() => props.onClose?.()}>
          Cancel
        </button>
      </div>

      <div style={{ display: 'flex', 'align-items': 'center', gap: '6px', 'margin-top': '6px', 'font-size': '0.8em' }}>
        <span class="muted">My post</span>
        <For each={STANCES}>
          {(option) => (
            <button
              type="button"
              onClick={() => setStance(option)}
              style={{
                padding: '2px 8px', 'border-radius': '10px', cursor: 'pointer',
                border: '1px solid var(--border-color, #ccc)',
                background: stance() === option ? 'var(--text-link, #007bff)' : 'transparent',
                color: stance() === option ? '#fff' : 'inherit'
              }}
            >
              {option === 'related' ? 'is related' : option}
            </button>
          )}
        </For>
      </div>

      <Show when={error()}>
        <p class="error" style={{ margin: '6px 0 0', 'font-size': '0.8em' }}>{error()}</p>
      </Show>

      <div style={{ 'margin-top': '6px', 'max-height': '220px', 'overflow-y': 'auto' }}>
        <Show when={query().trim()}>
          <Show when={!searching()} fallback={<p class="muted" style={{ 'font-size': '0.8em', margin: '4px 8px' }}>Searching…</p>}>
            <Show when={results().length > 0} fallback={<p class="muted" style={{ 'font-size': '0.8em', margin: '4px 8px' }}>No markets found.</p>}>
              <For each={results()}>{(market) => marketRow(market)}</For>
            </Show>
          </Show>
        </Show>

        <Show when={!query().trim()}>
          <Show when={suggesting()}>
            <p class="muted" style={{ 'font-size': '0.8em', margin: '4px 8px' }}>Finding related markets…</p>
          </Show>
          <For each={suggestions()}>{(market) => marketRow(market, '✨')}</For>
          <Show when={!suggesting() && suggestions().length === 0}>
            <p class="muted" style={{ 'font-size': '0.8em', margin: '4px 8px' }}>
              {seed().length >= MIN_SUGGEST_LENGTH
                ? 'No suggestions — try the search box.'
                : 'Type your post first for suggestions, or search directly.'}
            </p>
          </Show>
        </Show>
      </div>
    </div>
  );
}
