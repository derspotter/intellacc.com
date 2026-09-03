import { createSignal, createResource, createEffect, onCleanup, Show, For } from 'solid-js';
import { A } from '@solidjs/router';
import api from '../../services/api';
import { getCurrentUserId, isAuthenticated } from '../../services/auth';

const fetchAnalysis = async (postId) => {
  if (!isAuthenticated()) {
    return { status: null, link: null, markets: [] };
  }
  try {
    const [statusRes, linkRes, marketsRes] = await Promise.all([
      api.posts.getAnalysisStatus(postId).catch(() => null),
      api.posts.getMarketLink(postId).catch(() => null),
      api.posts.getMarkets(postId).catch(() => [])
    ]);

    const markets = Array.isArray(marketsRes?.markets)
      ? marketsRes.markets
      : Array.isArray(marketsRes)
        ? marketsRes
        : [];
    
    return {
      status: statusRes || null,
      link: (linkRes && linkRes.linked_market) ? linkRes.linked_market : null,
      markets
    };
  } catch (err) {
    console.error('Failed to load analysis for post', postId, err);
    return { status: null, link: null, markets: [] };
  }
};

export default function PostCritiques(props) {
  const [data, { refetch }] = createResource(
    () => [props.postId, props.refresh ?? 0],
    ([postId]) => fetchAnalysis(postId)
  );
  const [isConfirming, setIsConfirming] = createSignal(false);
  const currentData = () => data() || data.latest || null;
  const loadingMessageStyle = { color: "var(--text-muted, #888)", "font-size": "0.85em", "font-style": "italic" };

  createEffect(() => {
    const nextData = currentData();
    if (nextData && nextData.status) {
      const status = nextData.status.processing_status;
      if (['pending', 'retrieving', 'reasoning'].includes(status)) {
        const timer = setTimeout(refetch, 5000);
        onCleanup(() => clearTimeout(timer));
      }
    }
  });

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
    const currentData = data();
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

  return (
    <div class="post-critiques-container" style={{ "margin-top": "8px" }}>
      <Show when={currentData()} keyed>
        {(d) => {
          const s = d.status;
          const link = d.link;
          const candidates = (Array.isArray(d.markets) ? d.markets : [])
            .filter((market) => !link || String(market.event_id) !== String(link.event_id));

          // A manually attached link renders regardless of analysis status
          // (old posts may have no analysis row, casual ones gate out).
          if (!link && candidates.length === 0) {
            if (s && ['pending', 'retrieving', 'reasoning'].includes(s.processing_status)) {
              return <div style={loadingMessageStyle}>AI is matching markets...</div>;
            }
            return null;
          }

          return (
            <div style={{ display: "flex", "flex-wrap": "wrap", gap: "8px", "align-items": "center" }}>
              <Show when={link}>{marketChip(link, true)}</Show>
              <For each={candidates}>{(market) => marketChip(market, false)}</For>
            </div>
          );
        }}
      </Show>
    </div>
  );
}
