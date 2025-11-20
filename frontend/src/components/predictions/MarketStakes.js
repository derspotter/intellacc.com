import van from "vanjs-core";
import Card from '../common/Card.js';
import Button from '../common/Button.js';

const { div, h3, h4, p, span, small, table, thead, tbody, tr, th, td } = van.tags;

const MarketStakes = ({ eventId, title = "Market Stakes", showTitle = true }) => {
  const marketState = van.state(null);
  const recentTrades = van.state([]);
  const loading = van.state(true);
  const error = van.state(null);

  const loadMarketData = async () => {
    if (!eventId) return;
    
    try {
      loading.val = true;
      error.val = null;
      
      // Get market state
      const marketResponse = await fetch(`http://localhost:3001/events/${eventId}/market`);
      if (marketResponse.ok) {
        const market = await marketResponse.json();
        marketState.val = market;
      }
      
      // Get recent trades/updates (mock data for now)
      // TODO: Implement actual trades history endpoint
      recentTrades.val = [
        {
          id: 1,
          user: 'User123',
          direction: 'YES',
          amount: 25.50,
          timestamp: new Date(Date.now() - 5 * 60 * 1000),
          price_before: 0.45,
          price_after: 0.47
        },
        {
          id: 2,
          user: 'Trader456',
          direction: 'NO',
          amount: 15.00,
          timestamp: new Date(Date.now() - 15 * 60 * 1000),
          price_before: 0.47,
          price_after: 0.45
        }
      ];
      
    } catch (err) {
      console.error('Error loading market data:', err);
      error.val = err.message;
    } finally {
      loading.val = false;
    }
  };

  const formatPercentage = (value) => {
    const numValue = typeof value === 'string' ? parseFloat(value) : value;
    return `${(numValue * 100).toFixed(1)}%`;
  };

  const formatRP = (value) => {
    const numValue = typeof value === 'string' ? parseFloat(value) : value;
    return `${numValue.toFixed(2)} RP`;
  };

  const formatTime = (date) => {
    const now = new Date();
    const diffMs = now - date;
    const diffMins = Math.floor(diffMs / (1000 * 60));
    
    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffMins < 1440) return `${Math.floor(diffMins / 60)}h ago`;
    return date.toLocaleDateString();
  };

  // Load market data on component mount or when eventId changes
  van.derive(() => {
    if (eventId) {
      loadMarketData();
    }
  });

  return () => Card({
    className: 'market-stakes-card',
    children: [
      () => showTitle ? h3({ class: 'market-stakes-title' }, title) : null,
      
      () => {
        if (!eventId) {
          return div({ class: 'no-event' }, [
            p('No event selected'),
            small('Select an event to view market data')
          ]);
        }
        
        if (loading.val) {
          return div({ class: 'market-stakes-loading' }, [
            div({ class: 'loading-spinner' }),
            p('Loading market data...')
          ]);
        }
        
        if (error.val) {
          return div({ class: 'market-stakes-error' }, [
            h4('⚠️ Error Loading Market Data'),
            p(`Error: ${error.val}`),
            Button({
              onClick: loadMarketData,
              children: 'Retry'
            })
          ]);
        }
        
        if (!marketState.val) {
          return div({ class: 'no-market-data' }, [
            p('Market not yet initialized'),
            small('Market data will appear after first stake is placed')
          ]);
        }
        
        const market = marketState.val;
        
        return div({ class: 'market-stakes-content' }, [
          // Current Market Stats
          div({ class: 'current-market-stats' }, [
            h4('📊 Current Market'),
            div({ class: 'stats-grid' }, [
              div({ class: 'stat-item' }, [
                span({ class: 'stat-label' }, 'Probability'),
                span({ 
                  class: 'stat-value probability-value' 
                }, formatPercentage(market.market_prob))
              ]),
              div({ class: 'stat-item' }, [
                span({ class: 'stat-label' }, 'Total Volume'),
                span({ class: 'stat-value' }, formatRP(market.cumulative_stake))
              ]),
              div({ class: 'stat-item' }, [
                span({ class: 'stat-label' }, 'Liquidity'),
                span({ class: 'stat-value' }, formatRP(market.liquidity_b))
              ]),
              div({ class: 'stat-item' }, [
                span({ class: 'stat-label' }, 'Traders'),
                span({ class: 'stat-value' }, `${market.unique_traders}`)
              ])
            ])
          ]),
          
          // Recent Activity
          div({ class: 'recent-activity' }, [
            h4('🕐 Recent Activity'),
            () => recentTrades.val.length > 0 ? 
              table({ class: 'trades-table' }, [
                thead([
                  tr([
                    th('User'),
                    th('Direction'),
                    th('Amount'),
                    th('Price Impact'),
                    th('Time')
                  ])
                ]),
                tbody(
                  recentTrades.val.map(trade => tr([
                    td(trade.user),
                    td({ 
                      class: `direction ${trade.direction.toLowerCase()}`
                    }, trade.direction),
                    td(formatRP(trade.amount)),
                    td([
                      formatPercentage(trade.price_before),
                      ' → ',
                      formatPercentage(trade.price_after)
                    ]),
                    td({ class: 'time-cell' }, formatTime(trade.timestamp))
                  ]))
                )
              ]) :
              div({ class: 'no-activity' }, [
                p('No recent trading activity'),
                small('Be the first to place a stake!')
              ])
          ])
        ]);
      }
    ]
  });
};
export default MarketStakes;