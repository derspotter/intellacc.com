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

  // Initial load
  loadData();

  return div({ class: "post-critiques-container", style: "margin-top: 12px; font-size: 0.9em; border-top: 1px solid #eee; padding-top: 8px;" },
    () => {
      if (isLoading.val) return div({ style: "color: #888; font-style: italic;" }, "AI is analyzing this claim...");
      
      const s = status.val;
      if (!s) return span(); // No analysis available

      if (s.processing_status === 'gated_out') {
        return span(); // Not a claim, hide silently
      }

      if (s.processing_status === 'pending' || s.processing_status === 'retrieving' || s.processing_status === 'reasoning') {
        return div({ style: "color: #888; font-style: italic;" }, "AI is currently analyzing this claim...");
      }

      const elements = [];

      // Link section
      if (link.val) {
        elements.push(
          div({ style: "margin-bottom: 8px;" },
            span({ style: "font-weight: bold; color: #555;" }, "AI Matched Market: "),
            a({ 
              href: `#market/${link.val.event_id}`, 
              style: "color: #007bff; text-decoration: none;"
            }, link.val.title),
            span({ style: "color: #888; margin-left: 8px; font-size: 0.85em;" }, 
              `(${Math.round(link.val.match_confidence * 100)}% confidence)`
            )
          )
        );
      } else if (s.has_claim) {
        elements.push(
          div({ style: "color: #666; margin-bottom: 8px;" }, "AI identified a claim but could not find a suitable prediction market.")
        );
      }

      // Stance
      if (link.val && link.val.stance) {
        const stanceColors = {
          agrees: '#28a745',
          disagrees: '#dc3545',
          related: '#6c757d'
        };
        elements.push(
          div({ style: "margin-bottom: 8px;" },
            span({ style: "font-weight: bold; color: #555;" }, "AI Stance: "),
            span({ style: `color: ${stanceColors[link.val.stance] || '#6c757d'}; font-weight: bold; text-transform: uppercase; font-size: 0.8em;` }, 
              link.val.stance
            )
          )
        );
      }

      // Confirmation Actions (Author Only)
      if (isAuthor() && link.val && !link.val.confirmed) {
        elements.push(
          div({ style: "margin-top: 10px; display: flex; gap: 8px;" },
            button({ 
              class: "confirm-btn",
              style: "background: #28a745; color: white; border: none; padding: 4px 10px; border-radius: 4px; cursor: pointer; font-size: 0.9em;",
              onclick: () => handleConfirm('confirm'),
              disabled: isConfirming.val
            }, isConfirming.val ? "Saving..." : "Confirm AI Match"),
            button({ 
              class: "reject-btn",
              style: "background: transparent; color: #dc3545; border: 1px solid #dc3545; padding: 4px 10px; border-radius: 4px; cursor: pointer; font-size: 0.9em;",
              onclick: () => handleConfirm('override'),
              disabled: isConfirming.val
            }, "Reject")
          )
        );
      } else if (link.val && link.val.confirmed) {
        elements.push(
          div({ style: "margin-top: 10px; color: #28a745; font-size: 0.85em; font-weight: bold;" }, 
            "✓ Confirmed by author"
          )
        );
      }

      if (elements.length === 0) return span();
      
      return div(
        div({ style: "display: flex; align-items: center; gap: 4px; margin-bottom: 8px;" },
          span({ style: "font-size: 1.2em;" }, "🤖"),
          span({ style: "font-weight: bold; color: #444;" }, "Truth Analysis")
        ),
        div({ style: "background: #f8f9fa; padding: 10px; border-radius: 6px; border: 1px solid #e9ecef;" }, elements)
      );
    }
  );
}
