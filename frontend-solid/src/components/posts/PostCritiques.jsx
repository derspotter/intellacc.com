import { createSignal, createResource, createEffect, onCleanup, Show, For } from 'solid-js';
import { A } from '@solidjs/router';
import api from '../../services/api';
import { getCurrentUserId, isAuthenticated } from '../../services/auth';

const fetchAnalysis = async (postId) => {
  if (!isAuthenticated()) {
    return { status: null, link: null };
  }
  try {
    const [statusRes, linkRes] = await Promise.all([
      api.posts.getAnalysisStatus(postId).catch(() => null),
      api.posts.getMarketLink(postId).catch(() => null)
    ]);
    
    return {
      status: statusRes || null,
      link: (linkRes && linkRes.linked_market) ? linkRes.linked_market : null
    };
  } catch (err) {
    console.error('Failed to load analysis for post', postId, err);
    return { status: null, link: null };
  }
};

export default function PostCritiques(props) {
  const [data, { mutate, refetch }] = createResource(() => props.postId, fetchAnalysis);
  const [isConfirming, setIsConfirming] = createSignal(false);

  createEffect(() => {
    const currentData = data();
    if (currentData && currentData.status) {
      const status = currentData.status.processing_status;
      if (['pending', 'retrieving', 'reasoning'].includes(status)) {
        const timer = setTimeout(refetch, 5000);
        onCleanup(() => clearTimeout(timer));
      }
    }
  });

  const isAuthor = () => {
    const currentUserId = getCurrentUserId();
    return currentUserId === props.authorId;
  };

  const handleConfirm = async (action) => {
    const currentData = data();
    if (!currentData || !currentData.link) return;
    
    setIsConfirming(true);
    try {
      await api.posts.confirmMarketLink(props.postId, currentData.link.event_id, action, currentData.link.stance);
      mutate({
        ...currentData,
        link: { ...currentData.link, confirmed: action === 'confirm' }
      });
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
    window.location.hash = `#market/${eventId}`;
  };

  return (
    <div class="post-critiques-container" style={{ "margin-top": "8px" }}>
      <Show when={data.loading}>
        <div style={{ color: "var(--text-muted, #888)", "font-size": "0.85em", "font-style": "italic" }}>AI is matching markets...</div>
      </Show>

      <Show when={data()}>
        {(d) => {
          const s = d().status;
          const link = d().link;

          if (!s || s.processing_status === 'gated_out') return null;

          if (['pending', 'retrieving', 'reasoning'].includes(s.processing_status)) {
            return <div style={{ color: "var(--text-muted, #888)", "font-size": "0.85em", "font-style": "italic" }}>AI is matching markets...</div>;
          }

          if (!link) return null;

          return (
            <div style={{ display: "flex", "flex-wrap": "wrap", gap: "8px", "align-items": "center" }}>
              <a 
                href={`#market/${link.event_id}`}
                class="market-chip"
                style={{
                  background: "var(--bg-secondary, rgba(0, 123, 255, 0.1))",
                  color: "var(--text-link, #007bff)",
                  padding: "4px 10px",
                  "border-radius": "16px",
                  "font-size": "0.85em",
                  "text-decoration": "none",
                  cursor: "pointer",
                  display: "inline-flex",
                  "align-items": "center",
                  gap: "4px"
                }}
                onClick={(e) => handleMarketClick(e, link.event_id)}
              >
                <span class="market-chip-title">{link.title}</span>
                <Show when={link.market_prob != null}>
                  <span class="market-chip-prob" style={{ "font-weight": "bold" }}>
                    {Math.round(link.market_prob * 100)}%
                  </span>
                </Show>
              </a>

              {/* Confirmation Actions (Author Only) */}
              <Show when={isAuthor() && !link.confirmed}>
                <div style={{ display: "flex", gap: "4px" }}>
                  <button 
                    title="Confirm this match"
                    style={{ background: "#28a745", color: "white", border: "none", padding: "2px 8px", "border-radius": "12px", cursor: "pointer", "font-size": "0.75em", display: "flex", "align-items": "center", "justify-content": "center" }}
                    onClick={() => handleConfirm('confirm')}
                    disabled={isConfirming()}
                  >
                    ✓
                  </button>
                  <button 
                    title="Reject this match"
                    style={{ background: "transparent", color: "#dc3545", border: "1px solid #dc3545", padding: "2px 8px", "border-radius": "12px", cursor: "pointer", "font-size": "0.75em", display: "flex", "align-items": "center", "justify-content": "center" }}
                    onClick={() => handleConfirm('override')}
                    disabled={isConfirming()}
                  >
                    ✕
                  </button>
                </div>
              </Show>
            </div>
          );
        }}
      </Show>
    </div>
  );
}
