import van from 'vanjs-core';
const { div, span, button, h3, p, a, ul, li } = van.tags;
import Card from '../common/Card';
import api from '../../services/api';
import { getTokenData } from '../../services/auth';

export default function LeaderboardCard() {
  // State for view type and data
  const showGlobal = van.state(true);
  const showFollowers = van.state(false);
  const showFollowing = van.state(false);
  const leaderboardData = van.state([]);
  const loading = van.state(false);
  const error = van.state(null);
  const userRank = van.state(null);

  // Tab configuration - simplified to 3 toggleable options
  const tabs = [
    { key: 'global', label: 'Global' },
    { key: 'followers', label: 'Followers' },
    { key: 'following', label: 'Following' }
  ];

  // Fetch leaderboard data based on current selections
  const fetchLeaderboard = async () => {
    loading.val = true;
    error.val = null;
    
    try {
      let response;
      
      // Determine which type to fetch based on current selections
      if (showGlobal.val) {
        response = await api.leaderboard.getGlobal(10);
        // Fetch user rank for global leaderboard
        try {
          const rankResponse = await api.leaderboard.getUserRank();
          userRank.val = rankResponse;
        } catch (rankError) {
          console.warn('Could not fetch user rank:', rankError);
        }
      } else if (showFollowers.val && showFollowing.val) {
        // Both followers and following = network
        response = await api.leaderboard.getNetwork(10);
      } else if (showFollowers.val) {
        response = await api.leaderboard.getFollowers(10);
      } else if (showFollowing.val) {
        response = await api.leaderboard.getFollowing(10);
      } else {
        // Default to global if nothing selected
        response = await api.leaderboard.getGlobal(10);
        showGlobal.val = true;
      }
      
      leaderboardData.val = response.leaderboard || [];
    } catch (err) {
      console.error('Error fetching leaderboard:', err);
      error.val = err.message || 'Failed to load leaderboard';
      leaderboardData.val = [];
    } finally {
      loading.val = false;
    }
  };

  // Handle tab toggling
  const toggleTab = (tabKey) => {
    if (tabKey === 'global') {
      // Global is exclusive - turn off others
      showGlobal.val = true;
      showFollowers.val = false;
      showFollowing.val = false;
      userRank.val = null; // Clear previous rank
    } else if (tabKey === 'followers') {
      // Toggle followers, turn off global
      showGlobal.val = false;
      showFollowers.val = !showFollowers.val;
      userRank.val = null;
    } else if (tabKey === 'following') {
      // Toggle following, turn off global
      showGlobal.val = false;
      showFollowing.val = !showFollowing.val;
      userRank.val = null;
    }
    
    fetchLeaderboard();
  };

  // Format reputation points for display
  const formatRepPoints = (points) => {
    return parseFloat(points || 1.0).toFixed(1);
  };

  // Get current user ID for highlighting
  const getCurrentUserId = () => {
    const tokenData = getTokenData();
    return tokenData?.userId;
  };

  // Initial load
  fetchLeaderboard();

  // Render tab buttons
  const renderTabs = () => {
    return div({ class: 'leaderboard-tabs' }, 
      tabs.map(tab => {
        const isActive = () => {
          if (tab.key === 'global') return showGlobal.val;
          if (tab.key === 'followers') return showFollowers.val;
          if (tab.key === 'following') return showFollowing.val;
          return false;
        };
        
        return button({
          class: () => `tab-button ${isActive() ? 'active' : ''}`,
          onclick: () => toggleTab(tab.key)
        }, tab.label);
      })
    );
  };

  // Render user rank info (for global leaderboard)
  const renderUserRank = () => {
    return () => {
      if (!showGlobal.val || !userRank.val) return null;
      
      const rank = userRank.val;
      return div({ class: 'user-rank-info' }, [
        span({ class: 'rank-label' }, 'Your Rank: '),
        span({ class: 'rank-value' }, `#${rank.rank || 'Unranked'}`),
        span({ class: 'rank-points' }, `(${formatRepPoints(rank.rep_points)} pts)`)
      ]);
    };
  };

  const formatLogLoss = (value) => {
    if (value === null || value === undefined) return '-';
    const n = Number(value);
    return Number.isFinite(n) ? n.toFixed(3) : '-';
  };

  // Render compact leaderboard row (mobile-safe, no wide table)
  const renderLeaderboardEntry = (entry, index) => {
    const currentUserId = getCurrentUserId();
    const isCurrentUser = entry.user_id === currentUserId;
    
    return li({
      class: () => `leaderboard-entry ${isCurrentUser ? 'current-user' : ''}`
    }, [
      span({ class: 'leaderboard-rank' }, `${index + 1}`),
      div({ class: 'leaderboard-user' }, [
        a({
          href: `#user/${entry.user_id}`,
          class: 'leaderboard-username',
          onclick: (e) => {
            e.preventDefault();
            window.location.hash = `user/${entry.user_id}`;
          }
        }, entry.username),
        isCurrentUser ? span({ class: 'you-indicator' }, 'you') : null,
        div({ class: 'leaderboard-meta' }, [
          span({ class: 'leaderboard-meta-item' }, `Pred: ${entry.total_predictions ?? '-'}`),
          span({ class: 'leaderboard-meta-item' }, `LogLoss: ${formatLogLoss(entry.avg_log_loss)}`)
        ])
      ]),
      div({ class: 'leaderboard-points' }, [
        span({ class: 'leaderboard-points-value' }, formatRepPoints(entry.rep_points)),
        span({ class: 'leaderboard-points-label' }, 'RP')
      ])
    ]);
  };

  // Render leaderboard content
  const renderLeaderboardContent = () => {
    return () => {
      if (loading.val) {
        return div({ class: 'leaderboard-loading' }, 'Loading leaderboard...');
      }

      if (error.val) {
        return div({ class: 'leaderboard-error' }, [
          p(`Error: ${error.val}`),
          button({ 
            onclick: () => fetchLeaderboard(),
            class: 'retry-button'
          }, 'Retry')
        ]);
      }

      if (leaderboardData.val.length === 0) {
        return div({ class: 'leaderboard-empty' }, 
          showGlobal.val ? 
            'No users with predictions yet.' :
            'No users in your network have made predictions yet.'
        );
      }

      return ul({ class: 'leaderboard-list-compact' },
        leaderboardData.val.map((entry, index) => renderLeaderboardEntry(entry, index))
      );
    };
  };

  return Card({
    className: 'leaderboard-card',
    children: [
      div({ class: 'leaderboard-header-row' }, [
        div({ class: 'card-header' }, [
          h3('Reputation Leaderboard'),
          p({ class: 'header-subtitle' }, 'Unified log scoring (All-Log + PLL)')
        ]),
        button({
          onclick: () => fetchLeaderboard(),
          class: 'refresh-button leaderboard-refresh',
          disabled: () => loading.val,
          title: 'Refresh leaderboard'
        }, () => loading.val ? 'Refreshing...' : '🔄')
      ]),
      renderTabs(),
      renderUserRank(),
      div({ class: 'leaderboard-content' }, renderLeaderboardContent()),
      div({ class: 'leaderboard-footer' })
    ]
  });
}
