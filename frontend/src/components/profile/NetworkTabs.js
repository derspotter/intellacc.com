import van from 'vanjs-core';
const { div, h3, h4, p, span, button } = van.tags;
import Card from '../common/Card';
import UserCard from './UserCard';
import userStore from '../../store/user';
import auth from '../../services/auth';
import api from '../../services/api';

/**
 * Component to display user's network (followers and following)
 * @param {Object} props
 * @param {number} [props.userId] - User ID to display network for (if not provided, uses current user)
 */
export default function NetworkTabs({ userId } = {}) {
  // Determine if this is for current user or another user
  const isCurrentUser = !userId;
  const targetUserId = userId || (auth.getTokenData()?.userId);
  
  // Active tab state
  const activeTab = van.state('followers');
  
  // Local state for public user network data
  const followers = van.state([]);
  const following = van.state([]);
  const error = van.state('');
  const loading = van.state(false);
  
  // Manual load function
  const loadNetworkData = async () => {
    if (!targetUserId || loading.val) return;
    
    try {
      loading.val = true;
      error.val = '';
      
      if (isCurrentUser) {
        // Use store for current user
        await userStore.actions.fetchFollowers.call(userStore);
        await userStore.actions.fetchFollowing.call(userStore);
      } else {
        // Fetch directly for other users
        const [followersData, followingData] = await Promise.all([
          api.users.getFollowers(targetUserId),
          api.users.getFollowing(targetUserId)
        ]);
        followers.val = followersData;
        following.val = followingData;
      }
    } catch (err) {
      console.error('Error loading network data:', err);
      error.val = 'Could not load network data';
    } finally {
      loading.val = false;
    }
  };
  
  // Simple user list component without follow buttons
  const UserList = ({ users, title }) => {
    if (!users || users.length === 0) {
      return div({ class: "no-users" }, `No ${title.toLowerCase()} yet.`);
    }
    
    return div({ class: "user-list" }, 
      users.map(user => 
        div({ class: "user-item simple" }, [
          div({ class: "user-info" }, [
            h4({ class: "username" }, user.username),
            p({ class: "user-bio" }, user.bio || "No bio")
          ])
        ])
      )
    );
  };
  
  // Get the appropriate data source
  const getFollowers = () => isCurrentUser ? userStore.state.followers.val : followers.val;
  const getFollowing = () => isCurrentUser ? userStore.state.following.val : following.val;
  
  return Card({
    title: isCurrentUser ? "Your Network" : "Network",
    className: "network-tabs",
    children: [
      // Error message
      () => error.val ? div({ class: "error-message" }, error.val) : null,
      
      // Load button
      button({
        onclick: loadNetworkData,
        disabled: () => loading.val,
        className: "load-network-button"
      }, () => loading.val ? "Loading..." : "Load Network Data"),
      
      // Network stats
      div({ class: "network-stats" }, [
        div({ 
          class: () => `tab ${activeTab.val === 'followers' ? 'active' : ''}`,
          onclick: () => activeTab.val = 'followers'
        }, [
          "Followers: ",
          span({ class: "count" }, () => getFollowers().length)
        ]),
        div({ 
          class: () => `tab ${activeTab.val === 'following' ? 'active' : ''}`,
          onclick: () => activeTab.val = 'following'
        }, [
          "Following: ",
          span({ class: "count" }, () => getFollowing().length)
        ])
      ]),
      
      // Tab content
      div({ class: "tab-content" }, [
        // Followers tab
        () => activeTab.val === 'followers' ? 
          div({ class: "followers-tab" }, [
            h4(isCurrentUser ? "People following you" : "Followers"),
            UserList({ users: getFollowers(), title: "followers" })
          ]) : null,
        
        // Following tab
        () => activeTab.val === 'following' ? 
          div({ class: "following-tab" }, [
            h4(isCurrentUser ? "People you follow" : "Following"),
            UserList({ users: getFollowing(), title: "following" })
          ]) : null
      ])
    ]
  });
}