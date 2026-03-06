import van from "vanjs-core";
import Button from '../common/Button.js';
import { tokenState } from '../../services/tokenService';

const { div, h3, h4, p, span, small, ul, li } = van.tags;

export default function RPBalance({ horizontal = false }) {
  const balance = van.state(null);
  const loading = van.state(true);
  const error = van.state(null);
  const lastToken = van.state('__not-set__');

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

      // Fetch the live LMSR ledger split plus rank summary.
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
        rp_staked: userResponse.rp_staked || 0,
        total_reputation: userResponse.total_reputation ?? (
          Number(userResponse.rp_balance || 0) + Number(userResponse.rp_staked || 0)
        ),
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

  // Load balance once on mount and when auth token changes.
  van.derive(() => {
    const token = tokenState.val || '';
    if (lastToken.val === token) return;
    lastToken.val = token;

    if (!token) {
      balance.val = null;
      loading.val = false;
      error.val = null;
      return;
    }

    loadBalance();
  });

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
    '📅 Place at least 1% weekly assignment stake (avoid 1% missed-week penalty)',
    '🎯 Build reputation by holding strong market positions',
    '💎 Stake optimal amounts (Kelly criterion)',
    '⚡ Trade actively in markets for better rates',
    '🏆 Climb leaderboards for reputation bonuses'
  ];

  return () => {
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
        
        // Horizontal layout for stats bar
        if (horizontal) {
          return div({ class: 'user-stats-horizontal' }, [
            div({ class: 'stat-item' }, [
              span({ class: 'stat-main' }, formatRP(bal.rp_balance) + ' RP'),
              span({ class: 'stat-sub' }, 'Available')
            ]),
            div({ class: 'stat-item' }, [
              span({ class: 'stat-main' }, formatRP(bal.rp_staked)),
              span({ class: 'stat-sub' }, 'Staked')
            ]),
            div({ class: 'stat-item' }, [
              span({ class: 'stat-main' }, formatRP(bal.total_reputation)),
              span({ class: 'stat-sub' }, 'Total Reputation')
            ]),
            div({ class: 'stat-item' }, [
              span({ class: 'stat-main' }, bal.rank ? `#${bal.rank}` : 'Unranked'),
              span({ class: 'stat-sub' }, 'Global Rank')
            ]),
            div({ class: 'stat-item' }, [
              span({ class: 'stat-main' }, bal.total_predictions || 0),
              span({ class: 'stat-sub' }, 'Total Predictions')
            ])
          ]);
        }
        
        // Vertical layout for sidebar/card
        return div({ class: 'rp-balance-content' }, [
          div({ class: 'balance-header' }, [
            h3('💰 Your Reputation'),
            span({ 
              class: `balance-amount ${getBalanceColorClass(bal)}`
            }, formatRP(bal.total_reputation) + ' RP')
          ]),
          
          div({ class: 'balance-stats' }, [
            div({ class: 'stat-row' }, [
              span({ class: 'stat-label' }, 'Available:'),
              span({ class: 'stat-value' }, formatRP(bal.rp_balance))
            ]),
            div({ class: 'stat-row' }, [
              span({ class: 'stat-label' }, 'Staked:'),
              span({ class: 'stat-value' }, formatRP(bal.rp_staked))
            ]),
            div({ class: 'stat-row' }, [
              span({ class: 'stat-label' }, 'Total Reputation:'),
              span({ class: 'stat-value' }, formatRP(bal.total_reputation))
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
      };
};
