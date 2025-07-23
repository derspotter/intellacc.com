import van from "vanjs-core";
import Card from '../common/Card.js';
import Button from '../common/Button.js';
import api from '../../services/api.js';

const { div, h3, h4, p, span, small, ul, li } = van.tags;

export default function RPBalance() {
  const balance = van.state(null);
  const loading = van.state(true);
  const error = van.state(null);

  const loadBalance = async () => {
    try {
      loading.val = true;
      error.val = null;
      
      const token = localStorage.getItem('token');
      if (!token) {
        balance.val = null;
        loading.val = false;
        return;
      }

      // Get current user's actual RP balance (not reputation points)
      // Direct API calls for debugging
      const userResponse = await fetch('/api/me', {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      }).then(res => res.json());
      
      const leaderboardResponse = await fetch('/api/leaderboard/rank', {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      }).then(res => res.json());
      
      balance.val = {
        rp_balance: userResponse.rp_balance, // Actual betting balance
        rep_points: leaderboardResponse.rep_points, // Reputation points
        rank: leaderboardResponse.rank,
        total_predictions: leaderboardResponse.total_predictions
      };
    } catch (err) {
      console.error('Error loading RP balance:', err);
      error.val = err.message;
      balance.val = null;
    } finally {
      loading.val = false;
    }
  };

  // Load balance on component mount
  loadBalance();

  const formatRP = (value) => {
    if (typeof value === 'string') return parseFloat(value).toFixed(2);
    return value?.toFixed(2) || '0.00';
  };

  const getBalanceColorClass = (balance) => {
    if (!balance || !balance.rp_balance) return 'neutral';
    if (balance.rp_balance >= 1500) return 'excellent';
    if (balance.rp_balance >= 1000) return 'good';
    if (balance.rp_balance >= 500) return 'fair';
    return 'poor';
  };

  const getEarningTips = () => [
    '📅 Complete weekly assignments (+50 RP each)',
    '🎯 Make accurate predictions (log loss scoring)',
    '💎 Stake optimal amounts (Kelly criterion)',
    '⚡ Trade actively in markets for better rates',
    '🏆 Climb leaderboards for reputation bonuses'
  ];

  return Card({
    className: 'rp-balance-card',
    children: [
      () => {
        if (loading.val) {
          return div({ class: 'rp-balance-loading' }, [
            div({ class: 'loading-spinner' }),
            p('Loading your balance...')
          ]);
        }
        
        if (error.val) {
          return div({ class: 'rp-balance-error' }, [
            h3('⚠️ Error Loading Balance'),
            p(`Error: ${error.val}`),
            Button({
              onclick: loadBalance,
              children: 'Retry'
            })
          ]);
        }
        
        if (!balance.val) {
          return div({ class: 'rp-balance-empty' }, [
            h3('💰 Your Balance'),
            p('Unable to load balance. Please log in and try again.'),
            Button({
              onclick: () => window.location.hash = '#login',
              children: 'Log In'
            })
          ]);
        }
        
        const bal = balance.val;
        return div({ class: 'rp-balance-content' }, [
          div({ class: 'balance-header' }, [
            h3('💰 Your RP Balance'),
            span({ 
              class: `balance-amount ${getBalanceColorClass(bal)}`
            }, formatRP(bal.rp_balance) + ' RP')
          ]),
          
          div({ class: 'balance-stats' }, [
            div({ class: 'stat-row' }, [
              span({ class: 'stat-label' }, 'Available for Betting:'),
              span({ class: 'stat-value' }, formatRP(bal.rp_balance))
            ]),
            div({ class: 'stat-row' }, [
              span({ class: 'stat-label' }, 'Reputation Points:'),
              span({ class: 'stat-value' }, bal.rep_points ? `${bal.rep_points}` : '1.0')
            ]),
            div({ class: 'stat-row' }, [
              span({ class: 'stat-label' }, 'Global Rank:'),
              span({ class: 'stat-value' }, bal.rank ? `#${bal.rank}` : 'Unranked')
            ]),
            div({ class: 'stat-row' }, [
              span({ class: 'stat-label' }, 'Total Predictions:'),
              span({ class: 'stat-value' }, bal.total_predictions || 0)
            ])
          ]),
          
          div({ class: 'earning-tips' }, [
            h4('💡 Earning Tips'),
            ul({ class: 'tips-list' }, 
              getEarningTips().map(tip => li(tip))
            )
          ]),
          
          div({ class: 'balance-actions' }, [
            Button({
              onclick: () => window.location.hash = '#profile',
              className: 'secondary',
              children: '📊 View Profile'
            }),
            Button({
              onclick: loadBalance,
              className: 'secondary',
              children: '🔄 Refresh'
            })
          ])
        ]);
      }
    ]
  });
};