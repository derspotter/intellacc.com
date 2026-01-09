import van from 'vanjs-core';
const { div, span, button, h3, p, a, table, thead, tbody, tr, th, td } = van.tags;
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
    { key: 'global', label: 'Global', icon: '🌍' },
    { key: 'followers', label: 'Followers', icon: '👥' },
    { key: 'following', label: 'Following', icon: '👤' }
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
        }, [
          span({ class: 'tab-icon' }, tab.icon),
          span({ class: 'tab-label' }, tab.label)
        ]);
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

  // Render leaderboard table row
  const renderLeaderboardRow = (entry, index) => {
    const currentUserId = getCurrentUserId();
    const isCurrentUser = entry.user_id === currentUserId;
    
    return tr({ 
      class: `leaderboard-row ${isCurrentUser ? 'current-user' : ''}` 
    }, [
      td({ class: 'rank-cell' }, `${index + 1}`),
      td({ class: 'user-cell' }, [
        a({
          href: `#user/${entry.user_id}`,
          class: 'username-link',
          onclick: (e) => {
            e.preventDefault();
            window.location.hash = `user/${entry.user_id}`;
          }
        }, entry.username),
        isCurrentUser ? span({ class: 'you-indicator' }, ' (you)') : null
      ]),
      td({ class: 'points-cell' }, formatRepPoints(entry.rep_points)),
      td({ class: 'predictions-cell' }, entry.total_predictions),
      td({ class: 'accuracy-cell' }, 
        entry.avg_log_loss ? 
          parseFloat(entry.avg_log_loss).toFixed(3) : 
          '-'
      )
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

      return table({ class: 'leaderboard-table' }, [
        thead([
          tr([
            th({ class: 'rank-header' }, 'Rank'),
            th({ class: 'user-header' }, 'User'),
            th({ class: 'points-header' }, 'Rep Points'),
            th({ class: 'predictions-col-header' }, 'Predictions'),
            th({ class: 'accuracy-header' }, 'Avg Log Loss')
          ])
        ]),
        tbody(
          leaderboardData.val.map((entry, index) => renderLeaderboardRow(entry, index))
        )
      ]);
    };
  };

  return Card({
    className: 'leaderboard-card',
    children: [
      div({ class: 'card-header' }, [
        h3('🏆 Reputation Leaderboard'),
        p({ class: 'header-subtitle' }, 'Based on unified log scoring (All-Log + PLL)')
      ]),
      renderTabs(),
      renderUserRank(),
      div({ class: 'leaderboard-content' }, renderLeaderboardContent()),
      div({ class: 'leaderboard-footer' }, [
        button({
          onclick: () => fetchLeaderboard(),
          class: 'refresh-button',
          disabled: () => loading.val
        }, () => loading.val ? 'Refreshing...' : '🔄 Refresh')
      ])
    ]
  });
}