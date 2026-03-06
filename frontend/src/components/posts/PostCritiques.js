import van from 'vanjs-core';
const { div, span, button, a } = van.tags;
import api from '../../services/api';
import auth from '../../services/auth';

export default function PostCritiques({ postId, authorId }) {
  const status = van.state(null);
  const link = van.state(null);
  const isLoading = van.state(true);
  const isConfirming = van.state(false);

  const isAuthor = () => {
    const currentUserId = auth.getUserId();
    return currentUserId && Number(currentUserId) === Number(authorId);
  };

  const loadData = async () => {
    if (!auth.getToken()) {
      status.val = null;
      link.val = null;
      isLoading.val = false;
      return;
    }

    try {
      const [statusRes, linkRes] = await Promise.all([
        api.posts.getAnalysisStatus(postId).catch(() => null),
        api.posts.getMarketLink(postId).catch(() => null)
      ]);
      
      status.val = statusRes || null;
      if (linkRes && linkRes.linked_market) {
        link.val = linkRes.linked_market;
      } else {
        link.val = null;
      }

      // Poll if still processing
      if (statusRes && ['pending', 'retrieving', 'reasoning'].includes(statusRes.processing_status)) {
        setTimeout(loadData, 5000);
      }
    } catch (err) {
      console.error('Failed to load analysis for post', postId, err);
    } finally {
      isLoading.val = false;
    }
  };

  const handleConfirm = async (action) => {
    if (!link.val) return;
    isConfirming.val = true;
    try {
      await api.posts.confirmMarketLink(postId, link.val.event_id, action, link.val.stance);
      // Optimistically update
      link.val = { ...link.val, confirmed: action === 'confirm' };
    } catch (err) {
      console.error('Failed to confirm market link:', err);
    } finally {
      isConfirming.val = false;
    }
  };

  const handleMarketClick = async (e, eventId) => {
    e.preventDefault();
    try {
      await api.posts.marketClick(postId, eventId);
    } catch (err) {
      console.error('Failed to register market click:', err);
    }
    window.location.hash = `#market/${eventId}`;
  };

  // Initial load
  if (auth.getToken()) {
    loadData();
  } else {
    isLoading.val = false;
  }

  return div({ class: "post-critiques-container", style: "margin-top: 8px;" },
    () => {
      const s = status.val;
      if (isLoading.val || !s) return span(); // No analysis available
      
      if (s.processing_status === 'gated_out') return span(); // Not a claim

      // Loading state
      if (s.processing_status === 'pending' || s.processing_status === 'retrieving' || s.processing_status === 'reasoning') {
        return div({ style: "color: #888; font-size: 0.85em; font-style: italic;" }, "AI is matching markets...");
      }

      // No link found
      if (!link.val) return span();

      // Render simple chip
      return div({ style: "display: flex; flex-wrap: wrap; gap: 8px; align-items: center;" },
        a({
          href: `#market/${link.val.event_id}`,
          class: "market-chip",
          style: "background: rgba(0, 123, 255, 0.1); color: #007bff; padding: 4px 10px; border-radius: 16px; font-size: 0.85em; text-decoration: none; cursor: pointer;",
          onclick: (e) => handleMarketClick(e, link.val.event_id)
        }, 
          span({ class: "market-chip-title" }, link.val.title),
          " ",
          span({ class: "market-chip-prob", style: "font-weight: bold;" }, 
            link.val.market_prob != null ? `${Math.round(link.val.market_prob * 100)}%` : ''
          )
        ),
        
        // Confirmation Actions (Author Only)
        isAuthor() && !link.val.confirmed ? div({ style: "display: flex; gap: 4px;" },
          button({ 
            title: "Confirm this match",
            style: "background: #28a745; color: white; border: none; padding: 2px 8px; border-radius: 12px; cursor: pointer; font-size: 0.75em; display: flex; align-items: center; justify-content: center;",
            onclick: () => handleConfirm('confirm'),
            disabled: isConfirming.val
          }, "✓"),
          button({ 
            title: "Reject this match",
            style: "background: transparent; color: #dc3545; border: 1px solid #dc3545; padding: 2px 8px; border-radius: 12px; cursor: pointer; font-size: 0.75em; display: flex; align-items: center; justify-content: center;",
            onclick: () => handleConfirm('override'),
            disabled: isConfirming.val
          }, "✕")
        ) : null
      );
    }
  );
}
