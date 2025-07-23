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
  let beliefProbability = 0.7; // Use plain JS variable to avoid reactive updates
  const submitting = van.state(false);
  
  // Debounce Kelly suggestions to prevent spam
  let kellyTimeout;
  
  

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
    console.log('loadUserPosition called for event', event.id, 'userId:', userId);
    if (!userId) return;
    
    try {
      loading.val = true;
      error.val = null;
      
      // Try to get user position from prediction engine
      const positionResponse = await fetch(`http://localhost:3001/events/${event.id}/shares?user_id=${userId}`);
      console.log('Position response status:', positionResponse.status);
      if (positionResponse.ok) {
        const position = await positionResponse.json();
        console.log('User position loaded:', position);
        
        // Convert string numbers to numbers and add calculated fields
        const yesShares = parseFloat(position.yes_shares || 0);
        const noShares = parseFloat(position.no_shares || 0);
        const totalStaked = (yesShares * marketState.market_prob) + (noShares * (1 - marketState.market_prob));
        const unrealizedPnl = (yesShares * marketState.market_prob) + (noShares * (1 - marketState.market_prob)) - totalStaked;
        
        userPosition.val = {
          yes_shares: yesShares,
          no_shares: noShares,
          total_staked: totalStaked,
          unrealized_pnl: unrealizedPnl
        };
        console.log('Processed position:', userPosition.val);
      } else {
        console.log('No position found or error:', await positionResponse.text());
      }
      
    } catch (err) {
      console.error('Error loading user position:', err);
      // Don't show error for missing position data
    } finally {
      loading.val = false;
    }
  };

  const getKellySuggestion = async (belief, updateCallback) => {
    try {
      const token = localStorage.getItem('token');
      let userId = localStorage.getItem('userId');
      
      if (!userId) {
        // Get user ID if not cached
        const userResponse = await api.users.getProfile();
        userId = userResponse.id;
        localStorage.setItem('userId', userId);
      }
      
      console.log('Getting Kelly suggestion for belief:', belief, 'userId:', userId, 'eventId:', event.id);
      
      const response = await fetch(`http://localhost:3001/events/${event.id}/kelly?belief=${belief}&user_id=${userId}`, {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });
      
      if (response.ok) {
        const kelly = await response.json();
        // Transform API response to expected format
        kellyData.val = {
          kelly_optimal: parseFloat(kelly.kelly_suggestion),
          quarter_kelly: parseFloat(kelly.quarter_kelly),
          edge: belief - parseFloat(kelly.current_prob),
          balance: parseFloat(kelly.balance),
          expected_log_growth: (belief - parseFloat(kelly.current_prob)) * 0.1
        };
        console.log('Kelly data set:', kellyData.val);
        // Force a re-render by triggering the reactive state
        kellyData.val = {...kellyData.val};
        if (updateCallback) updateCallback();
      } else {
        // Create fallback Kelly calculation
        const marketProb = parseFloat(marketState.market_prob) || 0.5;
        const edge = belief - marketProb;
        const userBalance = 990; // Use current balance - could fetch from API
        const kellyOptimal = Math.max(0, Math.abs(edge) * userBalance * 0.25); // Conservative 25% Kelly
        kellyData.val = {
          kelly_optimal: kellyOptimal,
          quarter_kelly: kellyOptimal * 0.25,
          edge: edge,
          balance: userBalance,
          expected_log_growth: edge * 0.1
        };
        // Force a re-render by triggering the reactive state  
        kellyData.val = {...kellyData.val};
        if (updateCallback) updateCallback();
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
          target_prob: betDirection.val === 'yes' ? 0.99 : 0.01
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

  const handleWithdrawal = async (shareType, amount) => {
    if (!amount || amount <= 0) return;
    
    // Confirmation dialog
    const currentPrice = shareType === 'yes' ? marketState.market_prob : (1 - marketState.market_prob);
    const estimatedPayout = (amount * currentPrice).toFixed(2);
    
    const confirmed = confirm(
      `Confirm withdrawal:\n\n` +
      `Sell ${amount.toFixed(2)} ${shareType.toUpperCase()} shares\n` +
      `Estimated payout: ${estimatedPayout} RP\n` +
      `Current market price: ${(currentPrice * 100).toFixed(1)}%\n\n` +
      `Do you want to proceed?`
    );
    
    if (!confirmed) return;
    
    try {
      submitting.val = true;
      error.val = null;
      
      const token = localStorage.getItem('token');
      let userId = localStorage.getItem('userId');
      
      if (!userId) {
        const userResponse = await api.users.getProfile();
        userId = userResponse.id;
        localStorage.setItem('userId', userId);
      }
      
      const response = await fetch(`http://localhost:3001/events/${event.id}/sell`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({
          user_id: parseInt(userId),
          share_type: shareType,
          amount: parseFloat(amount)
        })
      });
      
      if (response.ok) {
        const result = await response.json();
        // Show success message with payout amount
        const successMsg = `Successfully sold ${amount.toFixed(2)} ${shareType.toUpperCase()} shares for ${result.payout.toFixed(2)} RP`;
        console.log(successMsg);
        
        // Refresh user position
        await loadUserPosition();
        
        // Notify parent of update
        onStakeUpdate?.(result);
      } else {
        const errorData = await response.json();
        error.val = errorData.message || 'Failed to sell shares';
      }
      
    } catch (err) {
      console.error('Error selling shares:', err);
      error.val = err.message;
    } finally {
      submitting.val = false;
    }
  };

  const handleFullWithdrawal = async () => {    
    if (!userPosition.val) return;
    
    // Confirmation dialog for full withdrawal
    const position = userPosition.val;
    const yesValue = position.yes_shares * marketState.market_prob;
    const noValue = position.no_shares * (1 - marketState.market_prob);
    const totalEstimatedPayout = (yesValue + noValue).toFixed(2);
    
    const confirmed = confirm(
      `Confirm full withdrawal:\n\n` +
      `Sell ALL positions in this market\n` +
      `YES shares: ${position.yes_shares.toFixed(2)}\n` +
      `NO shares: ${position.no_shares.toFixed(2)}\n` +
      `Estimated total payout: ${totalEstimatedPayout} RP\n\n` +
      `This action cannot be undone. Do you want to proceed?`
    );
    
    if (!confirmed) return;
    
    try {
      submitting.val = true;
      error.val = null;
      
      const position = userPosition.val;
      let totalPayout = 0;
      
      // Sell YES shares if any
      if (position.yes_shares > 0) {
        const yesResult = await sellShares('yes', position.yes_shares);
        if (yesResult.success) {
          totalPayout += parseFloat(yesResult.payout);
        }
      }
      
      // Sell NO shares if any
      if (position.no_shares > 0) {
        const noResult = await sellShares('no', position.no_shares);
        if (noResult.success) {
          totalPayout += parseFloat(noResult.payout);
        }
      }
      
      console.log(`Full withdrawal completed. Total payout: ${totalPayout.toFixed(2)} RP`);
      
      // Refresh user position
      await loadUserPosition();
      
    } catch (err) {
      console.error('Error during full withdrawal:', err);
      error.val = err.message;
    } finally {
      submitting.val = false;
    }
  };

  const sellShares = async (shareType, amount) => {
    const token = localStorage.getItem('token');
    let userId = localStorage.getItem('userId');
    
    if (!userId) {
      const userResponse = await api.users.getProfile();
      userId = userResponse.id;
      localStorage.setItem('userId', userId);
    }
    
    const response = await fetch(`http://localhost:3001/events/${event.id}/sell`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({
        user_id: parseInt(userId),
        share_type: shareType,
        amount: parseFloat(amount)
      })
    });
    
    if (response.ok) {
      return await response.json();
    } else {
      const errorData = await response.json();
      throw new Error(errorData.message || 'Failed to sell shares');
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
      () => {
        console.log('User position check:', userPosition.val);
        return userPosition.val ? div({ class: 'user-position' }, [
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
        ]),
        // Withdrawal buttons
        (userPosition.val.yes_shares > 0 || userPosition.val.no_shares > 0) ? div({ class: 'withdrawal-actions' }, [
          userPosition.val.yes_shares > 0 ? Button({
            type: 'button',
            className: 'withdrawal-btn secondary',
            onclick: () => handleWithdrawal('yes', userPosition.val.yes_shares),
            children: `Sell All YES (${userPosition.val.yes_shares.toFixed(2)})`
          }) : null,
          userPosition.val.no_shares > 0 ? Button({
            type: 'button', 
            className: 'withdrawal-btn secondary',
            onclick: () => handleWithdrawal('no', userPosition.val.no_shares),
            children: `Sell All NO (${userPosition.val.no_shares.toFixed(2)})`
          }) : null,
          Button({
            type: 'button',
            className: 'withdrawal-btn primary',
            onclick: handleFullWithdrawal,
            children: 'Exit All Positions'
          })
        ]) : null
      ]) : null;
      },
      
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
            label('Your Belief Probability:'),
            (() => {
              // Create display elements
              const percentageSpan = span({ class: 'belief-percentage' }, `${(beliefProbability * 100).toFixed(1)}%`);
              const hintSmall = small({ class: 'belief-hint' }, 
                `Market: ${(marketState.market_prob * 100).toFixed(1)}% | Your edge: ${((beliefProbability - marketState.market_prob) * 100).toFixed(1)}%`
              );
              
              // Create slider
              const slider = input({
                type: 'range',
                min: '0.01',
                max: '0.99',
                step: '0.01',
                value: beliefProbability,
                class: 'belief-slider'
              });
              
              // Update display manually to avoid reactive re-renders
              const updateDisplay = () => {
                percentageSpan.textContent = `${(beliefProbability * 100).toFixed(1)}%`;
                hintSmall.textContent = `Market: ${(marketState.market_prob * 100).toFixed(1)}% | Your edge: ${((beliefProbability - marketState.market_prob) * 100).toFixed(1)}%`;
              };
              
              slider.oninput = (e) => {
                beliefProbability = parseFloat(e.target.value);
                updateDisplay();
                // Debounce Kelly suggestion updates
                if (kellyTimeout) clearTimeout(kellyTimeout);
                kellyTimeout = setTimeout(() => {
                  if (marketState && localStorage.getItem('token')) {
                    console.log('Calling Kelly suggestion with belief:', beliefProbability);
                    getKellySuggestion(beliefProbability);
                  }
                }, 300);
              };
              
              // Get initial Kelly suggestion
              if (localStorage.getItem('token') && marketState) {
                getKellySuggestion(beliefProbability);
              }
              
              return div({ class: 'belief-slider-container' }, [
                slider,
                div({ class: 'belief-display' }, [
                  percentageSpan,
                  hintSmall
                ])
              ]);
            })()
          ]),
          
          div({ class: 'form-row' }, [
            label('Stake Amount (RP):'),
            input({
              type: 'number',
              step: '0.01',
              min: '0.01',
              placeholder: 'Enter stake amount',
              value: () => stakeAmount.val,
              oninput: (e) => {
                const value = e.target.value;
                stakeAmount.val = value;
                console.log('Stake amount changed to:', value, 'stakeAmount.val:', stakeAmount.val);
                // Get Kelly suggestion when stake amount changes
                if (beliefProbability && marketState) {
                  getKellySuggestion(beliefProbability);
                }
              },
              class: 'stake-input'
            })
          ]),
          
          () => {
            // Debug: Always show this section
            return div({ class: 'kelly-debug-section', style: 'border: 1px solid #ccc; padding: 10px; margin: 10px 0;' }, [
              div({ style: 'font-size: 12px; color: #666; margin-bottom: 5px;' }, 
                `Debug: kellyData.val = ${kellyData.val ? 'OBJECT' : 'NULL'}`
              ),
              kellyData.val ? div({ class: 'kelly-suggestion' }, [
                div({ class: 'kelly-header' }, [
                  span('🎯 Kelly Optimal Suggestion'),
                  div({ class: 'kelly-buttons' }, [
                    Button({
                      type: 'button',
                      className: 'kelly-apply-btn secondary',
                      onclick: () => {
                        stakeAmount.val = kellyData.val.quarter_kelly.toFixed(2);
                      },
                      children: '1/4 Kelly'
                    }),
                    Button({
                      type: 'button',
                      className: 'kelly-apply-btn primary',
                      onclick: () => {
                        stakeAmount.val = kellyData.val.kelly_optimal.toFixed(2);
                      },
                      children: 'Full Kelly'
                    })
                  ])
                ]),
                div({ class: 'kelly-details' }, [
                  div({ class: 'kelly-stat' }, [
                    span({ class: 'kelly-label' }, 'Full Kelly:'),
                    span({ class: 'kelly-amount' }, formatRP(kellyData.val.kelly_optimal))
                  ]),
                  div({ class: 'kelly-stat' }, [
                    span({ class: 'kelly-label' }, 'Conservative (1/4):'),
                    span({ class: 'kelly-amount conservative' }, formatRP(kellyData.val.quarter_kelly))
                  ]),
                  div({ class: 'kelly-stat' }, [
                    span({ class: 'kelly-label' }, 'Your Edge:'),
                    span({ 
                      class: `kelly-edge ${kellyData.val.edge > 0 ? 'positive' : 'negative'}` 
                    }, `${(kellyData.val.edge * 100).toFixed(1)}%`)
                  ]),
                  div({ class: 'kelly-stat' }, [
                    span({ class: 'kelly-label' }, 'Balance:'),
                    span({ class: 'kelly-balance' }, formatRP(kellyData.val.balance))
                  ])
                ])
              ]) : div({ style: 'color: #999; font-style: italic;' }, 'Move the belief slider to see Kelly suggestions')
            ]);
          },
          
          () => error.val ? div({ class: 'error-message' }, error.val) : null,
          
          div({ class: 'form-actions' }, [
            Button({
              type: 'submit',
              className: 'primary',
              disabled: () => {
                const disabled = !stakeAmount.val || submitting.val;
                console.log('Button disabled:', disabled, 'stakeAmount.val:', stakeAmount.val, 'submitting.val:', submitting.val);
                return disabled;
              },
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