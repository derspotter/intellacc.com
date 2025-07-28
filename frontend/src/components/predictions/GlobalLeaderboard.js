import van from "vanjs-core";
import Card from '../common/Card.js';
import Button from '../common/Button.js';
import api from '../../services/api.js';

const { div, h3, h4, p, span, ul, li, small } = van.tags;

export default function GlobalLeaderboard({ limit = 10 }) {
  const leaderboard = van.state([]);
  const loading = van.state(true);
  const error = van.state(null);
  const currentUserRank = van.state(null);

  const loadLeaderboard = async () => {
    try {
      loading.val = true;
      error.val = null;
      
      const token = localStorage.getItem('token');
      
      // Get global leaderboard
      const leaderboardResponse = await fetch(`/api/leaderboard/global?limit=${limit}`, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      });
      
      const leaderboardData = leaderboardResponse.ok ? await leaderboardResponse.json() : { leaderboard: [] };
      
      // Get current user's rank if logged in
      let rankData = null;
      if (token) {
        try {
          const rankResponse = await fetch('/api/leaderboard/rank', {
            headers: {
              'Authorization': `Bearer ${token}`,
              'Content-Type': 'application/json'
            }
          });
          
          if (rankResponse.ok) {
            rankData = await rankResponse.json();
          }
        } catch (rankErr) {
          console.warn('Could not fetch user rank:', rankErr);
        }
      }
      
      // Extract leaderboard array from response
      const leaderboardArray = leaderboardData.leaderboard || [];
      leaderboard.val = Array.isArray(leaderboardArray) ? leaderboardArray : [];
      currentUserRank.val = rankData;
    } catch (err) {
      console.error('Error loading leaderboard:', err);
      error.val = err.message;
    } finally {
      loading.val = false;
    }
  };

  // Load leaderboard on component mount
  loadLeaderboard();

  const formatRP = (value) => {
    if (typeof value === 'string') return parseFloat(value).toFixed(1);
    return value?.toFixed(1) || '0.0';
  };

  const getReputationLevel = (repPoints) => {
    if (repPoints >= 8) return { level: 'Oracle', color: 'oracle' };
    if (repPoints >= 6.5) return { level: 'Expert', color: 'expert' };
    if (repPoints >= 5.5) return { level: 'Skilled', color: 'skilled' };
    if (repPoints >= 4) return { level: 'Novice', color: 'novice' };
    return { level: 'Beginner', color: 'beginner' };
  };

  const getRankIcon = (rank) => {
    if (rank === 1) return '🥇';
    if (rank === 2) return '🥈';
    if (rank === 3) return '🥉';
    return `#${rank}`;
  };

  return Card({
    className: 'global-leaderboard-card',
    children: [
      div({ class: 'leaderboard-header' }, [
        h3('🏆 Global Leaderboard'),
        () => currentUserRank.val ? small({ class: 'user-rank' }, [
          'Your rank: ',
          span({ class: 'rank-value' }, currentUserRank.val.rank ? `#${currentUserRank.val.rank}` : 'Unranked'),
          ' (',
          span({ class: 'rep-value' }, formatRP(currentUserRank.val.rep_points)),
          ' RP)'
        ]) : null
      ]),
      
      () => {
        if (loading.val) {
          return div({ class: 'leaderboard-loading' }, [
            div({ class: 'loading-spinner' }),
            p('Loading leaderboard...')
          ]);
        }
        
        if (error.val) {
          return div({ class: 'leaderboard-error' }, [
            h4('⚠️ Error Loading Leaderboard'),
            p(`Error: ${error.val}`),
            Button({
              onclick: loadLeaderboard,
              children: 'Retry'
            })
          ]);
        }
        
        if (leaderboard.val.length === 0) {
          return div({ class: 'leaderboard-empty' }, [
            p('No leaderboard data available yet.'),
            small('Start making predictions to see rankings!')
          ]);
        }
        
        return div({ class: 'leaderboard-content' }, [
          ul({ class: 'leaderboard-list' }, 
            (leaderboard.val || []).map((user, index) => {
              const rank = index + 1;
              const reputation = getReputationLevel(parseFloat(user.rep_points));
              
              return li({ 
                class: `leaderboard-item ${rank <= 3 ? 'top-three' : ''}` 
              }, [
                div({ class: 'rank-section' }, [
                  span({ class: 'rank-icon' }, getRankIcon(rank))
                ]),
                
                div({ class: 'user-section' }, [
                  div({ class: 'user-info' }, [
                    span({ class: 'username' }, user.username),
                    span({ 
                      class: `reputation-badge ${reputation.color}` 
                    }, reputation.level)
                  ]),
                  div({ class: 'user-stats' }, [
                    span({ class: 'rep-points' }, [
                      formatRP(user.rep_points), ' RP'
                    ]),
                    span({ class: 'predictions-count' }, [
                      user.total_predictions || 0, ' predictions'
                    ])
                  ])
                ])
              ]);
            })
          ),
          
          div({ class: 'leaderboard-actions' }, [
            Button({
              onclick: loadLeaderboard,
              className: 'secondary',
              children: '🔄 Refresh'
            }),
            () => leaderboard.val.length >= limit ? Button({
              onclick: () => window.location.hash = '#leaderboard',
              className: 'primary',
              children: 'View Full Leaderboard'
            }) : null
          ])
        ]);
      }
    ]
  });
};