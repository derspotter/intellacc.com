import van from "vanjs-core";
import Card from '../common/Card.js';
import Button from '../common/Button.js';
import TextInput from '../common/TextInput.js';
import api from '../../services/api.js';

const { div, h3, h4, p, span, small, input, label, form } = van.tags;

export default function EventCard({ event, onStakeUpdate }) {
  const userPosition = van.state(null);
  const kellyData = van.state(null);
  const loading = van.state(false);
  const error = van.state(null);
  
  // Betting form state
  const stakeAmount = van.state('');
  const betDirection = van.state('yes'); // 'yes' or 'no'
  const submitting = van.state(false);

  // Use market data from the event object directly
  const marketState = {
    market_prob: parseFloat(event.market_prob || 0.5),
    cumulative_stake: parseFloat(event.cumulative_stake || 0),
    liquidity_b: parseFloat(event.liquidity_b || 5000),
    unique_traders: 0, // Not available in backend data yet
    total_trades: 0    // Not available in backend data yet
  };

  const loadUserPosition = async () => {
    const userId = localStorage.getItem('userId');
    if (!userId) return;
    
    try {
      loading.val = true;
      error.val = null;
      
      // Try to get user position from prediction engine
      const positionResponse = await fetch(`http://localhost:3001/events/${event.id}/shares?user_id=${userId}`);
      if (positionResponse.ok) {
        const position = await positionResponse.json();
        userPosition.val = position;
      }
      
    } catch (err) {
      console.error('Error loading user position:', err);
      // Don't show error for missing position data
    } finally {
      loading.val = false;
    }
  };

  const getKellySuggestion = async (belief) => {
    try {
      const response = await fetch(`http://localhost:3001/events/${event.id}/kelly?belief=${belief}`);
      if (response.ok) {
        const kelly = await response.json();
        kellyData.val = kelly;
      }
    } catch (err) {
      console.error('Error getting Kelly suggestion:', err);
    }
  };

  const handleStake = async (e) => {
    e.preventDefault();
    if (!stakeAmount.val || submitting.val) return;
    
    try {
      submitting.val = true;
      error.val = null;
      
      const token = localStorage.getItem('token');
      
      // Get user ID from token or API call
      let userId;
      try {
        // Try to get from localStorage first
        userId = localStorage.getItem('userId');
        
        // If not available, get from current user endpoint
        if (!userId) {
          const userResponse = await api.users.getProfile();
          userId = userResponse.id;
          // Cache it for future use
          localStorage.setItem('userId', userId);
        }
      } catch (err) {
        error.val = 'Unable to get user information';
        return;
      }
      
      const response = await fetch(`http://localhost:3001/events/${event.id}/update`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({
          user_id: parseInt(userId),
          stake: parseFloat(stakeAmount.val),
          target_prob: betDirection.val === 'yes' ? 1.0 : 0.0
        })
      });
      
      if (response.ok) {
        const result = await response.json();
        // Refresh user position
        await loadUserPosition();
        // Clear form
        stakeAmount.val = '';
        // Notify parent of update
        onStakeUpdate?.(result);
      } else {
        const errorData = await response.json();
        error.val = errorData.message || 'Failed to place stake';
      }
      
    } catch (err) {
      console.error('Error placing stake:', err);
      error.val = err.message;
    } finally {
      submitting.val = false;
    }
  };

  // Load user position on component mount if logged in
  loadUserPosition();

  const formatDate = (dateString) => {
    return new Date(dateString).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  };

  const formatPercentage = (value) => {
    const numValue = typeof value === 'string' ? parseFloat(value) : value;
    return `${(numValue * 100).toFixed(1)}%`;
  };

  const formatRP = (value) => {
    const numValue = typeof value === 'string' ? parseFloat(value) : value;
    return `${numValue.toFixed(2)} RP`;
  };

  return () => Card({
    className: 'event-card',
    children: [
      // Event Header
      div({ class: 'event-header' }, [
        h3({ class: 'event-title' }, event.title),
        div({ class: 'event-meta' }, [
          span({ class: 'event-category' }, event.category || 'General'),
          span({ class: 'event-closing' }, [
            '📅 Closes: ',
            formatDate(event.closing_date)
          ])
        ])
      ]),
      
      // Market State
      div({ class: 'market-state' }, [
        h4('📊 Market State'),
        div({ class: 'market-stats' }, [
          div({ class: 'stat' }, [
            span({ class: 'stat-label' }, 'Current Probability:'),
            span({ 
              class: 'stat-value probability' 
            }, formatPercentage(marketState.market_prob))
          ]),
          div({ class: 'stat' }, [
            span({ class: 'stat-label' }, 'Total Staked:'),
            span({ class: 'stat-value' }, formatRP(marketState.cumulative_stake))
          ]),
          div({ class: 'stat' }, [
            span({ class: 'stat-label' }, 'Liquidity Parameter:'),
            span({ class: 'stat-value' }, formatRP(marketState.liquidity_b))
          ]),
          div({ class: 'stat' }, [
            span({ class: 'stat-label' }, 'Event Type:'),
            span({ class: 'stat-value' }, event.event_type || 'binary')
          ])
        ])
      ]),
      
      // User Position
      () => userPosition.val ? div({ class: 'user-position' }, [
        h4('💼 Your Position'),
        div({ class: 'position-stats' }, [
          div({ class: 'stat' }, [
            span({ class: 'stat-label' }, 'YES Shares:'),
            span({ class: 'stat-value' }, userPosition.val.yes_shares.toFixed(4))
          ]),
          div({ class: 'stat' }, [
            span({ class: 'stat-label' }, 'NO Shares:'),
            span({ class: 'stat-value' }, userPosition.val.no_shares.toFixed(4))
          ]),
          div({ class: 'stat' }, [
            span({ class: 'stat-label' }, 'Total Staked:'),
            span({ class: 'stat-value' }, formatRP(userPosition.val.total_staked))
          ]),
          div({ class: 'stat' }, [
            span({ class: 'stat-label' }, 'Unrealized P&L:'),
            span({ 
              class: `stat-value ${userPosition.val.unrealized_pnl >= 0 ? 'positive' : 'negative'}`
            }, formatRP(userPosition.val.unrealized_pnl))
          ])
        ])
      ]) : null,
      
      // Betting Interface
      () => localStorage.getItem('token') ? div({ class: 'betting-interface' }, [
        h4('🎲 Place Stake'),
        form({ 
          class: 'betting-form',
          onsubmit: handleStake
        }, [
          div({ class: 'form-row' }, [
            label('Bet Direction:'),
            div({ class: 'direction-buttons' }, [
              Button({
                type: 'button',
                className: () => `direction-btn ${betDirection.val === 'yes' ? 'active' : ''}`,
                onclick: () => betDirection.val = 'yes',
                children: 'YES'
              }),
              Button({
                type: 'button', 
                className: () => `direction-btn ${betDirection.val === 'no' ? 'active' : ''}`,
                onclick: () => betDirection.val = 'no',
                children: 'NO'
              })
            ])
          ]),
          
          div({ class: 'form-row' }, [
            TextInput({
              label: 'Stake Amount (RP)',
              type: 'number',
              step: '0.01',
              min: '0.01',
              placeholder: 'Enter stake amount',
              value: stakeAmount,
              onInput: (value) => {
                stakeAmount.val = value;
                // Get Kelly suggestion based on current market and stake
                if (value && marketState) {
                  const belief = betDirection.val === 'yes' ? 0.6 : 0.4; // Default belief
                  getKellySuggestion(belief);
                }
              }
            })
          ]),
          
          () => kellyData.val ? div({ class: 'kelly-suggestion' }, [
            small({ class: 'kelly-info' }, [
              '💡 Kelly optimal: ',
              span({ class: 'kelly-amount' }, formatRP(kellyData.val.kelly_optimal)),
              ' (edge: ',
              span({ class: 'kelly-edge' }, `${(kellyData.val.edge * 100).toFixed(1)}%`),
              ')'
            ])
          ]) : null,
          
          () => error.val ? div({ class: 'error-message' }, error.val) : null,
          
          div({ class: 'form-actions' }, [
            Button({
              type: 'submit',
              className: 'primary',
              disabled: () => !stakeAmount.val || submitting.val,
              children: () => submitting.val ? 'Placing Stake...' : 'Place Stake'
            })
          ])
        ])
      ]) : div({ class: 'login-prompt' }, [
        p('Log in to place stakes and participate in markets'),
        Button({
          onclick: () => window.location.hash = 'login',
          children: 'Log In'
        })
      ])
    ]
  });
};