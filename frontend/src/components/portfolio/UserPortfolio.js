import van from "vanjs-core";
import api from '../../services/api.js';

const { div, h2, h3, p, span, table, thead, tbody, tr, th, td, button, select, option } = van.tags;

export default function UserPortfolio() {
  const positions = van.state([]);
  const loading = van.state(true);
  const error = van.state(null);
  const filter = van.state('all'); // 'all', 'profitable', 'losing', 'active'
  const sortBy = van.state('stake'); // 'stake', 'pnl', 'shares', 'market'

  // Portfolio summary stats
  const portfolioStats = van.state({
    totalStaked: 0,
    totalValue: 0,
    totalPnL: 0,
    activePositions: 0,
    totalPositions: 0
  });

  const loadUserPositions = async () => {
    try {
      loading.val = true;
      error.val = null;
      
      const userId = localStorage.getItem('userId');
      if (!userId) {
        error.val = 'User not logged in';
        return;
      }

      // Get all user positions from backend
      const response = await fetch(`/api/users/${userId}/positions`, {
        headers: {
          'Authorization': `Bearer ${localStorage.getItem('token')}`
        }
      });

      if (response.ok) {
        const positionsData = await response.json();
        console.log('Portfolio positions loaded:', positionsData);
        
        // Process positions data
        const processedPositions = positionsData.map(pos => ({
          eventId: pos.event_id,
          eventTitle: pos.event_title,
          yesShares: parseFloat(pos.yes_shares || 0),
          noShares: parseFloat(pos.no_shares || 0),
          totalStaked: parseFloat(pos.total_staked || 0),
          currentProb: parseFloat(pos.current_prob || 0.5),
          unrealizedPnL: calculateUnrealizedPnL(pos),
          lastUpdated: pos.last_updated
        }));

        positions.val = processedPositions;
        updatePortfolioStats(processedPositions);
        
      } else {
        const errorData = await response.json();
        error.val = errorData.message || 'Failed to load portfolio';
      }
      
    } catch (err) {
      console.error('Error loading portfolio:', err);
      error.val = err.message;
    } finally {
      loading.val = false;
    }
  };

  const calculateUnrealizedPnL = (position) => {
    const yesShares = parseFloat(position.yes_shares || 0);
    const noShares = parseFloat(position.no_shares || 0);
    const currentProb = parseFloat(position.current_prob || 0.5);
    const totalStaked = parseFloat(position.total_staked || 0);
    
    const currentValue = (yesShares * currentProb) + (noShares * (1 - currentProb));
    return currentValue - totalStaked;
  };

  const updatePortfolioStats = (positionsData) => {
    const stats = positionsData.reduce((acc, pos) => {
      acc.totalStaked += pos.totalStaked;
      acc.totalValue += (pos.yesShares * pos.currentProb) + (pos.noShares * (1 - pos.currentProb));
      acc.totalPnL += pos.unrealizedPnL;
      if (pos.yesShares > 0 || pos.noShares > 0) {
        acc.activePositions++;
      }
      acc.totalPositions++;
      return acc;
    }, {
      totalStaked: 0,
      totalValue: 0,
      totalPnL: 0,
      activePositions: 0,
      totalPositions: 0
    });

    portfolioStats.val = stats;
  };

  const filteredAndSortedPositions = () => {
    let filtered = positions.val;
    
    // Apply filter
    switch (filter.val) {
      case 'active':
        filtered = filtered.filter(pos => pos.yesShares > 0 || pos.noShares > 0);
        break;
      case 'profitable':
        filtered = filtered.filter(pos => pos.unrealizedPnL > 0);
        break;
      case 'losing':
        filtered = filtered.filter(pos => pos.unrealizedPnL < 0);
        break;
    }
    
    // Apply sorting
    filtered.sort((a, b) => {
      switch (sortBy.val) {
        case 'stake':
          return b.totalStaked - a.totalStaked;
        case 'pnl':
          return b.unrealizedPnL - a.unrealizedPnL;
        case 'shares':
          return (b.yesShares + b.noShares) - (a.yesShares + a.noShares);
        case 'market':
          return a.eventTitle.localeCompare(b.eventTitle);
        default:
          return 0;
      }
    });
    
    return filtered;
  };

  const formatRP = (value) => {
    return `${value.toFixed(2)} RP`;
  };

  const formatPercentage = (value) => {
    return `${(value * 100).toFixed(1)}%`;
  };

  const formatDate = (dateString) => {
    return new Date(dateString).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  };

  // Load positions on component mount
  loadUserPositions();

  return () => div({ class: 'user-portfolio' }, [
    h2('Portfolio Overview'),
    
    // Portfolio Statistics
    div({ class: 'portfolio-stats' }, [
      div({ class: 'stat-card' }, [
        span({ class: 'stat-label' }, 'Total Staked'),
        span({ class: 'stat-value' }, formatRP(portfolioStats.val.totalStaked))
      ]),
      div({ class: 'stat-card' }, [
        span({ class: 'stat-label' }, 'Current Value'),
        span({ class: 'stat-value' }, formatRP(portfolioStats.val.totalValue))
      ]),
      div({ class: 'stat-card' }, [
        span({ class: 'stat-label' }, 'Unrealized P&L'),
        span({ 
          class: `stat-value ${portfolioStats.val.totalPnL >= 0 ? 'positive' : 'negative'}`
        }, formatRP(portfolioStats.val.totalPnL))
      ]),
      div({ class: 'stat-card' }, [
        span({ class: 'stat-label' }, 'Active Positions'),
        span({ class: 'stat-value' }, `${portfolioStats.val.activePositions} / ${portfolioStats.val.totalPositions}`)
      ])
    ]),

    // Filters and Sort Controls
    div({ class: 'portfolio-controls' }, [
      div({ class: 'control-group' }, [
        span('Filter: '),
        select({
          value: () => filter.val,
          onchange: (e) => filter.val = e.target.value
        }, [
          option({ value: 'all' }, 'All Positions'),
          option({ value: 'active' }, 'Active Only'),
          option({ value: 'profitable' }, 'Profitable'),
          option({ value: 'losing' }, 'Losing')
        ])
      ]),
      div({ class: 'control-group' }, [
        span('Sort by: '),
        select({
          value: () => sortBy.val,
          onchange: (e) => sortBy.val = e.target.value
        }, [
          option({ value: 'stake' }, 'Total Staked'),
          option({ value: 'pnl' }, 'P&L'),
          option({ value: 'shares' }, 'Total Shares'),
          option({ value: 'market' }, 'Market Name')
        ])
      ])
    ]),

    // Loading/Error States
    () => loading.val ? div({ class: 'loading' }, 'Loading portfolio...') : null,
    () => error.val ? div({ class: 'error' }, error.val) : null,

    // Positions Table
    () => !loading.val && !error.val ? div({ class: 'positions-table-container' }, [
      table({ class: 'positions-table' }, [
        thead([
          tr([
            th('Market'),
            th('YES Shares'),
            th('NO Shares'),
            th('Total Staked'),
            th('Current Prob'),
            th('Unrealized P&L'),
            th('Last Updated')
          ])
        ]),
        tbody([
          () => filteredAndSortedPositions().map(position => 
            tr({ 
              key: position.eventId,
              class: 'position-row'
            }, [
              td({ class: 'market-name' }, [
                button({
                  class: 'market-link',
                  onclick: () => {
                    window.location.hash = `predictions`;
                    // TODO: Auto-select this event in the predictions page
                  }
                }, position.eventTitle)
              ]),
              td({ class: 'shares-cell' }, position.yesShares.toFixed(2)),
              td({ class: 'shares-cell' }, position.noShares.toFixed(2)),
              td({ class: 'stake-cell' }, formatRP(position.totalStaked)),
              td({ class: 'prob-cell' }, formatPercentage(position.currentProb)),
              td({ 
                class: `pnl-cell ${position.unrealizedPnL >= 0 ? 'positive' : 'negative'}`
              }, formatRP(position.unrealizedPnL)),
              td({ class: 'date-cell' }, formatDate(position.lastUpdated))
            ])
          )
        ])
      ])
    ]) : null,

    // Empty State
    () => !loading.val && !error.val && positions.val.length === 0 ? 
      div({ class: 'empty-portfolio' }, [
        h3('No positions found'),
        p('You haven\'t placed any bets yet. Head to the predictions page to get started!')
      ]) : null
  ]);
}