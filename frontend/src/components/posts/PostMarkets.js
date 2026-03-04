import van from 'vanjs-core';
const { div, span, a } = van.tags;
import api from '../../services/api';

export default function PostMarkets({ postId }) {
  const markets = van.state([]);
  const isLoading = van.state(true);
  const error = van.state(null);

  console.log('PostMarkets mounting for postId:', postId);

  // Fetch markets on mount
  api.posts.getMarkets(postId)
    .then((res) => {
      console.log('PostMarkets loaded for postId:', postId, res);
      markets.val = res.markets || res || [];
    })
    .catch((err) => {
      console.error('Failed to load markets for post', postId, err);
      error.val = err;
    })
    .finally(() => {
      isLoading.val = false;
    });

  const handleMarketClick = async (e, eventId) => {
    e.preventDefault();
    try {
      await api.posts.marketClick(postId, eventId);
    } catch (err) {
      console.error('Failed to register market click:', err);
    }
    // Navigate to market
    window.location.hash = `#market/${eventId}`;
  };

  return div({ class: "post-markets-container" },
    () => {
      if (isLoading.val || markets.val.length === 0) return span();

      return div({ class: "post-markets-list", style: "display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px;" },
        markets.val.map(market => 
          a({
            href: `#market/${market.event_id}`,
            class: "market-chip",
            style: "background: rgba(0, 123, 255, 0.1); color: #007bff; padding: 4px 10px; border-radius: 16px; font-size: 0.85em; text-decoration: none; cursor: pointer;",
            onclick: (e) => handleMarketClick(e, market.event_id)
          }, 
            span({ class: "market-chip-title" }, market.title),
            " ",
            span({ class: "market-chip-prob", style: "font-weight: bold;" }, 
              market.market_prob != null ? `${Math.round(market.market_prob * 100)}%` : ''
            )
          )
        )
      );
    }
  );
}
