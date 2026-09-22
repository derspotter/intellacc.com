import { createSignal, Show, For } from 'solid-js';
import api from '../../services/api';
import { getCurrentUserId } from '../../services/auth';

export default function PostCritiques(props) {
  const [isConfirming, setIsConfirming] = createSignal(false);
  const currentData = () => props.data;
  const refetch = () => props.onRefresh?.();
  const loadingMessageStyle = { color: "var(--text-muted, #888)", "font-size": "0.85em", "font-style": "italic" };

  const isAuthor = () => {
    const currentUserId = getCurrentUserId();
    return currentUserId != null && props.authorId != null
      && String(currentUserId) === String(props.authorId);
  };

  const handleDetach = async (eventId) => {
    setIsConfirming(true);
    try {
      await api.posts.detachMarket(props.postId, eventId);
      refetch();
    } catch (err) {
      console.error('Failed to detach market:', err);
    } finally {
      setIsConfirming(false);
    }
  };

  const handleDismiss = async (eventId) => {
    setIsConfirming(true);
    try {
      await api.posts.dismissMarket(props.postId, eventId);
      refetch();
    } catch (err) {
      console.error('Failed to dismiss market candidate:', err);
    } finally {
      setIsConfirming(false);
    }
  };

  const handleConfirm = async (action) => {
    const currentData = props.data;
    if (!currentData || !currentData.link) return;
    
    setIsConfirming(true);
    try {
      await api.posts.confirmMarketLink(props.postId, currentData.link.event_id, action, currentData.link.stance);
      refetch();
    } catch (err) {
      console.error('Failed to confirm market link:', err);
    } finally {
      setIsConfirming(false);
    }
  };

  const handleMarketClick = async (e, eventId) => {
    e.preventDefault();
    try {
      await api.posts.marketClick(props.postId, eventId);
    } catch (err) {
      console.error('Failed to register market click:', err);
    }
    window.location.hash = `#predictions/${eventId}`;
  };

  const chipStyle = {
    display: "inline-flex",
    "align-items": "stretch",
    border: "1px solid var(--border-color, #999)",
    background: "var(--bg-secondary, rgba(0, 123, 255, 0.06))",
    "font-size": "0.85em"
  };

  const chipLinkStyle = {
    display: "inline-flex",
    "align-items": "center",
    gap: "6px",
    padding: "4px 10px",
    color: "var(--text-link, #007bff)",
    "text-decoration": "none",
    cursor: "pointer"
  };

  // Flat control segment inside the chip: its left border is the vertical
  // divider line. Deliberately rectangular — no radii (Bauhaus skin).
  const chipActionStyle = {
    display: "inline-flex",
    "align-items": "center",
    padding: "0 10px",
    border: "none",
    "border-left": "1px solid var(--border-color, #999)",
    background: "transparent",
    color: "inherit",
    "font-size": "inherit",
    cursor: "pointer"
  };

  const marketChip = (market, isLinked) => (
    <span class="market-chip" style={chipStyle}>
      <a
        href={`#predictions/${market.event_id}`}
        style={chipLinkStyle}
        onClick={(e) => handleMarketClick(e, market.event_id)}
      >
        <span class="market-chip-title">{market.title}</span>
        <Show when={market.market_prob != null}>
          <span class="market-chip-prob" style={{ "font-weight": "bold" }}>
            {Math.round(market.market_prob * 100)}%
          </span>
        </Show>
      </a>
      <Show when={isLinked && isAuthor() && !market.confirmed}>
        <button
          title="Confirm this match"
          style={{ ...chipActionStyle, color: "var(--success-color, #28a745)" }}
          onClick={() => handleConfirm('confirm')}
          disabled={isConfirming()}
        >
          ✓
        </button>
        <button
          title="Reject this match"
          style={{ ...chipActionStyle, color: "var(--danger-color, #dc3545)" }}
          onClick={() => handleConfirm('override')}
          disabled={isConfirming()}
        >
          ×
        </button>
      </Show>
      <Show when={isLinked && isAuthor() && market.confirmed && market.match_method === 'manual'}>
        <button
          title="Detach this market"
          style={{ ...chipActionStyle, color: "var(--text-muted, #888)" }}
          onClick={() => handleDetach(market.event_id)}
          disabled={isConfirming()}
        >
          ×
        </button>
      </Show>
      <Show when={!isLinked && isAuthor()}>
        <button
          title="Dismiss this suggestion"
          style={{ ...chipActionStyle, color: "var(--text-muted, #888)" }}
          onClick={() => handleDismiss(market.event_id)}
          disabled={isConfirming()}
        >
          ×
        </button>
      </Show>
    </span>
  );

  const link = () => currentData()?.link;
  const candidates = () => (currentData()?.markets || [])
    .filter((market) => !link() || String(market.event_id) !== String(link().event_id));
  const critiques = () => currentData()?.critiques || [];
  const isPending = () => ['pending', 'retrieving', 'reasoning'].includes(currentData()?.status?.processing_status);
  const critiqueLabel = (type) => String(type || 'Review note').replaceAll('_', ' ')
    .replace(/^./, (letter) => letter.toUpperCase());

  return (
    <div class="post-critiques-container" style={{ "margin-top": "8px" }}>
      <Show when={link() || candidates().length > 0}>
        <div style={{ display: "flex", "flex-wrap": "wrap", gap: "8px", "align-items": "center" }}>
          <Show when={link()} keyed>{(market) => marketChip(market, true)}</Show>
          <For each={candidates()}>{(market) => marketChip(market, false)}</For>
        </div>
      </Show>
      <Show when={isPending()}>
        <div style={loadingMessageStyle} role="status">
          {link() ? 'AI is reviewing the argument...' : 'AI is matching markets...'}
        </div>
      </Show>
      <Show when={critiques().length > 0}>
        <details class="post-ai-critiques" style={{
          "margin-top": "8px", border: "1px solid var(--border-color, #999)",
          "border-radius": "0", padding: "8px 10px", "font-size": "0.85em",
          "overflow-wrap": "anywhere"
        }}>
          <summary style={{ cursor: "pointer", "font-weight": "600" }}>
            AI critique · {critiques().length}
          </summary>
          <p style={{ color: "var(--text-muted, #888)", margin: "8px 0" }}>
            AI-generated feedback on the argument. It may be mistaken.
          </p>
          <ul style={{ margin: "8px 0 0", "padding-left": "20px" }}>
            <For each={critiques()}>{(critique) => (
              <li style={{ "margin-top": "8px" }}>
                <strong>{critiqueLabel(critique.critique_type)}</strong>
                <p style={{ margin: "4px 0", "white-space": "pre-wrap" }}>{critique.description}</p>
              </li>
            )}</For>
          </ul>
        </details>
      </Show>
    </div>
  );
}
