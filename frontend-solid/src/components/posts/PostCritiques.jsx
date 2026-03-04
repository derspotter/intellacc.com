import { createSignal, createResource, createEffect, onCleanup, Show, For } from 'solid-js';
import { A } from '@solidjs/router';
import api from '../../services/api';
import { getCurrentUserId } from '../../services/auth';

const fetchAnalysis = async (postId) => {
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

  const stanceColors = {
    agrees: '#28a745',
    disagrees: '#dc3545',
    related: '#6c757d'
  };

  return (
    <div class="post-critiques-container" style={{ "margin-top": "12px", "font-size": "0.9em", "border-top": "1px solid var(--border-color, #eee)", "padding-top": "8px" }}>
      <Show when={data.loading}>
        <div style={{ color: "var(--text-muted, #888)", "font-style": "italic" }}>AI is analyzing this claim...</div>
      </Show>

      <Show when={data()}>
        {(d) => {
          const s = d().status;
          const link = d().link;

          if (!s) return null;
          if (s.processing_status === 'gated_out') return null;

          if (s.processing_status === 'pending' || s.processing_status === 'retrieving' || s.processing_status === 'reasoning') {
            return <div style={{ color: "var(--text-muted, #888)", "font-style": "italic" }}>AI is currently analyzing this claim...</div>;
          }

          const hasContent = link || s.has_claim;
          if (!hasContent) return null;

          return (
            <div>
              <div style={{ display: "flex", "align-items": "center", gap: "4px", "margin-bottom": "8px" }}>
                <span style={{ "font-size": "1.2em" }}>🤖</span>
                <span style={{ "font-weight": "bold", color: "var(--text-primary, #444)" }}>Truth Analysis</span>
              </div>
              
              <div style={{ background: "var(--bg-secondary, #f8f9fa)", padding: "10px", "border-radius": "6px", border: "1px solid var(--border-color, #e9ecef)" }}>
                <Show when={link}>
                  <div style={{ "margin-bottom": "8px" }}>
                    <span style={{ "font-weight": "bold", color: "var(--text-secondary, #555)" }}>AI Matched Market: </span>
                    <A href={`/market/${link.event_id}`} style={{ color: "var(--text-link, #007bff)", "text-decoration": "none" }}>
                      {link.title}
                    </A>
                    <span style={{ color: "var(--text-muted, #888)", "margin-left": "8px", "font-size": "0.85em" }}>
                      ({Math.round(link.match_confidence * 100)}% confidence)
                    </span>
                  </div>

                  <Show when={link.stance}>
                    <div style={{ "margin-bottom": "8px" }}>
                      <span style={{ "font-weight": "bold", color: "var(--text-secondary, #555)" }}>AI Stance: </span>
                      <span style={{ color: stanceColors[link.stance] || stanceColors.related, "font-weight": "bold", "text-transform": "uppercase", "font-size": "0.8em" }}>
                        {link.stance}
                      </span>
                    </div>
                  </Show>
                </Show>

                <Show when={!link && s.has_claim}>
                  <div style={{ color: "var(--text-secondary, #666)", "margin-bottom": "8px" }}>
                    AI identified a claim but could not find a suitable prediction market.
                  </div>
                </Show>

                <Show when={isAuthor() && link && !link.confirmed}>
                  <div style={{ "margin-top": "10px", display: "flex", gap: "8px" }}>
                    <button 
                      class="confirm-btn"
                      style={{ background: "#28a745", color: "white", border: "none", padding: "4px 10px", "border-radius": "4px", cursor: "pointer", "font-size": "0.9em" }}
                      onClick={() => handleConfirm('confirm')}
                      disabled={isConfirming()}
                    >
                      {isConfirming() ? "Saving..." : "Confirm AI Match"}
                    </button>
                    <button 
                      class="reject-btn"
                      style={{ background: "transparent", color: "#dc3545", border: "1px solid #dc3545", padding: "4px 10px", "border-radius": "4px", cursor: "pointer", "font-size": "0.9em" }}
                      onClick={() => handleConfirm('override')}
                      disabled={isConfirming()}
                    >
                      Reject
                    </button>
                  </div>
                </Show>

                <Show when={link && link.confirmed}>
                  <div style={{ "margin-top": "10px", color: "#28a745", "font-size": "0.85em", "font-weight": "bold" }}>
                    ✓ Confirmed by author
                  </div>
                </Show>
              </div>
            </div>
          );
        }}
      </Show>
    </div>
  );
}
