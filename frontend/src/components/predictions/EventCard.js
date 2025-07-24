import van from "vanjs-core";
import Button from '../common/Button.js';
import api from '../../services/api.js';
import { registerSocketEventHandler } from '../../services/socket.js';

const { div, h3, p, span, small, input, label, form, button } = van.tags;

export default function EventCard({ event, onStakeUpdate, hideTitle = false }) {
  const userPosition = van.state(null);
  const withdrawalTrigger = van.state(0); // Counter to force re-renders
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
  let kellyInitialized = false;
  
  

  // Use reactive market data that can be updated via WebSocket
  const marketState = van.state({
    market_prob: parseFloat(event.market_prob || 0.5),
    cumulative_stake: parseFloat(event.cumulative_stake || 0),
    liquidity_b: parseFloat(event.liquidity_b || 5000),
    unique_traders: 0, // Not available in backend data yet
    total_trades: 0    // Not available in backend data yet
  });

  // Register Socket.IO handler for real-time market updates
  // Note: unregisterSocketHandler could be called for cleanup, but EventCards are cached
  const unregisterSocketHandler = registerSocketEventHandler('marketUpdate', (data) => {
    console.log('📈 Market update received for EventCard:', data);
    
    // Only update if this is for our event
    if (data.eventId === event.id) {
      console.log('📈 Updating market state for event', event.id, 'new prob:', data.market_prob);
      
      marketState.val = {
        ...marketState.val,
        market_prob: data.market_prob,
        cumulative_stake: data.cumulative_stake || marketState.val.cumulative_stake
      };
      
      // Recalculate user position values with new market prices
      if (userPosition.val) {
        const yesShares = userPosition.val.yes_shares;
        const noShares = userPosition.val.no_shares;
        const totalStaked = (yesShares * marketState.val.market_prob) + (noShares * (1 - marketState.val.market_prob));
        const unrealizedPnl = (yesShares * marketState.val.market_prob) + (noShares * (1 - marketState.val.market_prob)) - totalStaked;
        
        userPosition.val = {
          ...userPosition.val,
          total_staked: totalStaked,
          unrealized_pnl: unrealizedPnl
        };
        
        console.log('📈 Updated position values with new market price');
      }
    }
  });

  const loadUserPosition = async () => {
    console.log('🔍 loadUserPosition START for event:', event.id);
    console.log('🔍 Current userPosition.val:', userPosition.val);
    
    // Check if token is expired and clear it
    const token = localStorage.getItem('token');
    if (token) {
      try {
        const payload = JSON.parse(atob(token.split('.')[1]));
        if (payload.exp * 1000 < Date.now()) {
          console.log('Token expired, clearing localStorage');
          localStorage.removeItem('token');
          localStorage.removeItem('userId');
        }
      } catch (e) {
        console.log('Invalid token, clearing localStorage');
        localStorage.removeItem('token');
        localStorage.removeItem('userId');
      }
    }
    
    // Get userId from localStorage
    const userId = localStorage.getItem('userId');
    if (!userId) {
      console.log('No userId found, skipping position load');
      return;
    }
    console.log('Loading position for userId:', userId, 'Event ID:', event.id);
    
    try {
      loading.val = true;
      error.val = null;
      
      // Try to get user position from backend proxy (bypasses CORS)
      const url = `/api/events/${event.id}/shares?user_id=${userId}`;
      console.log('📡 About to fetch URL:', url);
      console.log('📡 Full URL would be:', window.location.origin + url);
      
      // Add timeout and better error handling
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000); // 5 second timeout
      
      try {
        const positionResponse = await fetch(url, {
          signal: controller.signal,
          headers: {
            'Content-Type': 'application/json'
            // Explicitly no Authorization header to avoid expired token issues
          }
        });
        
        clearTimeout(timeoutId);
        console.log('✅ Fetch completed! Status:', positionResponse.status);
        
        if (positionResponse.ok) {
          const position = await positionResponse.json();
          console.log('📊 Raw position data:', JSON.stringify(position));
          
          // Convert string numbers to numbers and add calculated fields
          const yesShares = parseFloat(position.yes_shares || 0);
          const noShares = parseFloat(position.no_shares || 0);
          console.log('📊 Parsed shares - YES:', yesShares, 'NO:', noShares);
          
          // Only set position if user actually has shares
          if (yesShares > 0 || noShares > 0) {
            const totalStaked = (yesShares * marketState.val.market_prob) + (noShares * (1 - marketState.val.market_prob));
            const unrealizedPnl = (yesShares * marketState.val.market_prob) + (noShares * (1 - marketState.val.market_prob)) - totalStaked;
            
            const newPosition = {
              yes_shares: yesShares,
              no_shares: noShares,
              total_staked: totalStaked,
              unrealized_pnl: unrealizedPnl
            };
            
            console.log('🔄 SETTING NEW POSITION:', newPosition);
            userPosition.val = newPosition;
            withdrawalTrigger.val++; // Force withdrawal buttons to re-render
            console.log('✅ POSITION SET! userPosition.val:', userPosition.val);
            console.log('✅ This should trigger withdrawal button render!');
            console.log('🔄 WITHDRAWAL TRIGGER incremented to:', withdrawalTrigger.val);
          } else {
            console.log('❌ User has no shares in this event');
            userPosition.val = null;
            withdrawalTrigger.val++; // Force withdrawal buttons to re-render when position becomes null
            console.log('🔄 WITHDRAWAL TRIGGER incremented to:', withdrawalTrigger.val);
          }
        } else {
          const errorText = await positionResponse.text();
          console.log('❌ Position API error:', positionResponse.status, errorText);
          userPosition.val = null;
        }
        
      } catch (fetchError) {
        clearTimeout(timeoutId);
        if (fetchError.name === 'AbortError') {
          console.error('Fetch timeout for URL:', url);
        } else {
          console.error('Fetch error for URL:', url, fetchError);
        }
      }
      
    } catch (err) {
      console.error('ERROR in loadUserPosition for event', event.id, ':', err);
      console.error('Error details:', err.message, err.stack);
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
        console.log('No userId for Kelly suggestion, skipping');
        return;
      }
      
      console.log('Getting Kelly suggestion for belief:', belief, 'userId:', userId, 'eventId:', event.id, 'hasToken:', !!token);
      
      if (token) {
        const response = await fetch(`/api/events/${event.id}/kelly?belief=${belief}&user_id=${userId}`, {
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
          console.log('Kelly data set from API:', kellyData.val);
          // Force a re-render by triggering the reactive state
          kellyData.val = {...kellyData.val};
          if (updateCallback) updateCallback();
          return;
        } else {
          console.log('Kelly API failed with status:', response.status);
        }
      }
      
      // Create fallback Kelly calculation when no token or API fails
      console.log('Using fallback Kelly calculation');
      const marketProb = parseFloat(marketState.val.market_prob) || 0.5;
      const edge = belief - marketProb;
      const userBalance = 1000; // Default balance for calculation
      const kellyOptimal = Math.max(0, Math.abs(edge) * userBalance * 0.25); // Conservative 25% Kelly
      kellyData.val = {
        kelly_optimal: kellyOptimal,
        quarter_kelly: kellyOptimal * 0.25,
        edge: edge,
        balance: userBalance,
        expected_log_growth: edge * 0.1
      };
      console.log('Kelly data set from fallback:', kellyData.val);
      // Force a re-render by triggering the reactive state  
      kellyData.val = {...kellyData.val};
      if (updateCallback) updateCallback();
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
      
      const response = await fetch(`/api/events/${event.id}/update`, {
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
        console.log('✅ Stake placed successfully! Result:', result);
        
        // Refresh user position
        console.log('🔄 About to reload user position after stake...');
        await loadUserPosition();
        console.log('🔄 User position reloaded after stake');
        
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
    console.log('🔥 WITHDRAWAL BUTTON CLICKED!', shareType, amount);
    if (!amount || amount <= 0) {
      console.log('❌ Invalid amount, returning:', amount);
      return;
    }
    
    // Confirmation dialog
    const currentPrice = shareType === 'yes' ? marketState.val.market_prob : (1 - marketState.val.market_prob);
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
      

      const response = await fetch(`/api/events/${event.id}/sell`, {
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
        console.log('🔄 Sell response:', result);
        
        // Handle different response formats
        const payout = parseFloat(result.payout || result.new_balance || 0);
        const successMsg = `Successfully sold ${amount.toFixed(2)} ${shareType.toUpperCase()} shares for ${payout.toFixed(2)} RP`;
        console.log(successMsg);
        
        // Refresh user position
        console.log('🔄 Refreshing position after withdrawal...');
        await loadUserPosition();
        console.log('🔄 Position refresh completed. New position:', userPosition.val);
        
        // Notify parent of update
        onStakeUpdate?.(result);
      } else {
        const errorText = await response.text();
        console.log('❌ Sell API error:', response.status, errorText);
        try {
          const errorData = JSON.parse(errorText);
          error.val = errorData.message || 'Failed to sell shares';
        } catch (e) {
          error.val = `Failed to sell shares: ${response.status} ${errorText}`;
        }
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
    const yesValue = position.yes_shares * marketState.val.market_prob;
    const noValue = position.no_shares * (1 - marketState.val.market_prob);
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
    
    const response = await fetch(`/api/events/${event.id}/sell`, {
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
      const errorText = await response.text();
      console.log('❌ sellShares API error:', response.status, errorText);
      try {
        const errorData = JSON.parse(errorText);
        throw new Error(errorData.message || 'Failed to sell shares');
      } catch (e) {
        throw new Error(`Failed to sell shares: ${response.status} ${errorText}`);
      }
    }
  };

  // Debug: Always log when EventCard is created
  console.log('=== EventCard CREATED for event:', event.id, event.title);
  console.log('DEBUG EventCard - userId:', localStorage.getItem('userId'), 'token exists:', !!localStorage.getItem('token'));
  
  // Load user position once on mount
  console.log('🚀 Loading user position on mount');
  loadUserPosition().then(() => {
    console.log('🚀 loadUserPosition completed successfully');
  }).catch(err => {
    console.error('🚀 loadUserPosition failed:', err);
  });

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

  return () => div({ class: 'event-card' }, [
      // Event Header - conditional based on hideTitle prop
      hideTitle ? null : div({ class: 'event-header' }, [
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
        div({ class: 'market-stats' }, [
          div({ class: 'stat' }, [
            span({ class: 'stat-label' }, 'Current Probability:'),
            span({ 
              class: 'stat-value probability',
              style: () => {
                // Interpolate between blue and red based on probability
                const prob = marketState.val.market_prob;
                const red = Math.round(prob * 255);
                const blue = Math.round((1 - prob) * 255);
                return `color: rgb(${red}, 0, ${blue})`;
              }
            }, () => formatPercentage(marketState.val.market_prob))
          ]),
          div({ class: 'stat' }, [
            span({ class: 'stat-label' }, 'Total Staked:'),
            span({ class: 'stat-value' }, () => formatRP(marketState.val.cumulative_stake))
          ]),
          div({ class: 'stat' }, [
            span({ class: 'stat-label' }, 'Liquidity Parameter:'),
            span({ class: 'stat-value' }, () => marketState.val.liquidity_b.toString())
          ]),
          div({ class: 'stat' }, [
            span({ class: 'stat-label' }, 'Event Type:'),
            span({ class: 'stat-value' }, event.event_type || 'binary')
          ])
        ])
      ]),
      
      // User Position Stats - Always present, visibility controlled by CSS
      div({ 
        class: 'user-position',
        style: () => {
          withdrawalTrigger.val; // Force dependency on trigger
          const visible = userPosition.val !== null;
          console.log('🎲 Position visibility:', visible, 'position:', userPosition.val, 'trigger:', withdrawalTrigger.val);
          return visible ? 'display: block;' : 'display: none;';
        }
      }, [
        div({ class: 'position-stats' }, [
          div({ class: 'stat' }, [
            span({ class: 'stat-label' }, 'YES Shares:'),
            span({ class: 'stat-value' }, () => userPosition.val ? userPosition.val.yes_shares.toFixed(2) : '0.00')
          ]),
          div({ class: 'stat' }, [
            span({ class: 'stat-label' }, 'NO Shares:'),
            span({ class: 'stat-value' }, () => userPosition.val ? userPosition.val.no_shares.toFixed(2) : '0.00')
          ]),
          div({ class: 'stat' }, [
            span({ class: 'stat-label' }, 'Your Stake:'),
            span({ class: 'stat-value' }, () => userPosition.val ? formatRP(userPosition.val.total_staked) : '0.00 RP')
          ]),
          div({ class: 'stat' }, [
            span({ class: 'stat-label' }, 'Unrealized P&L:'),
            span({ 
              class: () => `stat-value ${userPosition.val && userPosition.val.unrealized_pnl >= 0 ? 'positive' : 'negative'}`
            }, () => userPosition.val ? formatRP(userPosition.val.unrealized_pnl) : '0.00 RP')
          ])
        ])
      ]),
      
      // Withdrawal buttons - Always present in DOM, outside position conditional
      div({ class: 'withdrawal-actions' }, [
        // YES button - always present, visibility controlled by CSS
        button({
          type: 'button',
          class: 'button withdrawal-btn secondary',
          style: () => {
            withdrawalTrigger.val; // Force dependency on trigger
            const visible = userPosition.val && userPosition.val.yes_shares > 0;
            console.log('🔄 YES button visibility:', visible, 'shares:', userPosition.val?.yes_shares || 0, 'trigger:', withdrawalTrigger.val);
            return visible ? 'display: inline-block;' : 'display: none;';
          },
          onclick: () => {
            console.log('🔥 YES withdrawal button clicked!');
            handleWithdrawal('yes', userPosition.val.yes_shares);
          }
        }, () => {
          if (!userPosition.val || userPosition.val.yes_shares <= 0) return 'Sell All YES (0.00)';
          return `Sell All YES (${userPosition.val.yes_shares.toFixed(2)})`;
        }),
        
        // NO button - always present, visibility controlled by CSS
        button({
          type: 'button', 
          class: 'button withdrawal-btn secondary',
          style: () => {
            withdrawalTrigger.val; // Force dependency on trigger  
            const visible = userPosition.val && userPosition.val.no_shares > 0;
            console.log('🔄 NO button visibility:', visible, 'shares:', userPosition.val?.no_shares || 0, 'trigger:', withdrawalTrigger.val);
            return visible ? 'display: inline-block;' : 'display: none;';
          },
          onclick: () => {
            console.log('🔥 NO withdrawal button clicked!');
            handleWithdrawal('no', userPosition.val.no_shares);
          }
        }, () => {
          if (!userPosition.val || userPosition.val.no_shares <= 0) return 'Sell All NO (0.00)';
          return `Sell All NO (${userPosition.val.no_shares.toFixed(2)})`;
        }),
        
        // Full withdrawal button - always present, visibility controlled by CSS
        button({
          type: 'button',
          class: 'button withdrawal-btn primary',
          style: () => {
            withdrawalTrigger.val; // Force dependency on trigger
            const visible = userPosition.val && (userPosition.val.yes_shares > 0 || userPosition.val.no_shares > 0);
            console.log('🔄 FULL button visibility:', visible, 'position:', userPosition.val, 'trigger:', withdrawalTrigger.val);
            return visible ? 'display: inline-block;' : 'display: none;';
          },
          onclick: () => {
            console.log('🔥 FULL withdrawal button clicked!');
            handleFullWithdrawal();
          }
        }, 'Exit All Positions')
      ]),
      
      // Betting Interface
      () => localStorage.getItem('token') ? div({ class: 'betting-interface' }, [
        form({ 
          class: 'betting-form',
          onsubmit: handleStake
        }, [
          div({ class: 'form-row horizontal-row' }, [
            div({ class: 'form-field' }, [
              label('Bet Direction:'),
              div({ class: 'direction-buttons' }, [
                button({
                  type: 'button', 
                  class: () => `direction-btn no-btn ${betDirection.val === 'no' ? 'active' : ''}`,
                  onclick: () => betDirection.val = 'no'
                }, 'NO'),
                button({
                  type: 'button',
                  class: () => `direction-btn yes-btn ${betDirection.val === 'yes' ? 'active' : ''}`,
                  onclick: () => betDirection.val = 'yes'
                }, 'YES')
              ])
            ]),
            div({ class: 'form-field' }, [
              label('Stake Amount (RP):'),
              input({
                type: 'number',
                step: '0.01',
                min: '0.01',
                placeholder: 'Enter stake amount',
                value: () => stakeAmount.val, // Reactive binding
                class: 'stake-input',
                oninput: (e) => {
                  stakeAmount.val = e.target.value; // Direct state update
                }
              })
            ])
          ]),
          
          div({ class: 'form-row' }, [
            label('Your Belief Probability:'),
            (() => {
              // Create display elements
              const percentageSpan = span({ class: 'belief-percentage' }, `${(beliefProbability * 100).toFixed(1)}%`);
              const hintSmall = small({ class: 'belief-hint' }, 
                `Market: ${(marketState.val.market_prob * 100).toFixed(1)}% | Your edge: ${((beliefProbability - marketState.val.market_prob) * 100).toFixed(1)}%`
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
                hintSmall.textContent = `Market: ${(marketState.val.market_prob * 100).toFixed(1)}% | Your edge: ${((beliefProbability - marketState.val.market_prob) * 100).toFixed(1)}%`;
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
              
              // Get initial Kelly suggestion (only once)
              if (!kellyInitialized && localStorage.getItem('token') && marketState) {
                kellyInitialized = true;
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
          
          div({ class: 'kelly-suggestion' }, [
            div({ class: 'kelly-header' }, [
              span('Kelly Optimal Suggestion'),
              div({ class: 'kelly-buttons' }, [
                Button({
                  type: 'button',
                  className: 'kelly-apply-btn primary',
                  onclick: () => {
                    if (kellyData.val) {
                      stakeAmount.val = kellyData.val.kelly_optimal.toFixed(2);
                    }
                  },
                  children: 'Apply Kelly'
                })
              ])
            ]),
            div({ class: 'kelly-details' }, [
              div({ class: 'kelly-stat' }, [
                span({ class: 'kelly-label' }, 'Optimal Kelly:'),
                span({ class: 'kelly-amount' }, kellyData.val ? formatRP(kellyData.val.kelly_optimal) : '--')
              ]),
              div({ class: 'kelly-stat' }, [
                span({ class: 'kelly-label' }, 'Your Edge:'),
                span({ 
                  class: `kelly-edge positive` 
                }, kellyData.val ? `${Math.abs(kellyData.val.edge * 100).toFixed(1)}%` : '--')
              ])
            ])
          ]),
          
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
    ]);
};