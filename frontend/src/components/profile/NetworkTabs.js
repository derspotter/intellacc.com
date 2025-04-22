import van from 'vanjs-core';
const { div, h3, h4, p, ul, li, span } = van.tags;
import Card from '../common/Card';
import userStore from '../../store/user';
import api from '../../services/api';

/**
 * Component to display user's network (followers and following)
 */
export default function NetworkTabs() {
  // Active tab state
  const activeTab = van.state('followers');
  
  // Add error state
  const error = van.state('');
  
  // Fetch network data if needed
  if (userStore.state.followers.val.length === 0 && userStore.state.following.val.length === 0) {
    // Use a safer approach to fetch data
    setTimeout(() => {
      try {
        // Check if we're in development mode
        if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
          // Mock data for development
          userStore.state.followers.val = [
            { username: 'follower1', bio: 'I follow you' },
            { username: 'follower2', bio: 'Another follower' }
          ];
          userStore.state.following.val = [
            { username: 'following1', bio: 'You follow me' },
            { username: 'following2', bio: 'Another person you follow' }
          ];
        } else {
          // Only try to fetch if the API is available
          if (api && api.user) {
            userStore.actions.fetchFollowers.call(userStore);
            userStore.actions.fetchFollowing.call(userStore);
          }
        }
      } catch (err) {
        console.error('Error loading network data:', err);
        error.val = 'Could not load network data';
      }
    }, 0);
  }
  
  // User list component
  const UserList = ({ users }) => {
    if (!users || users.length === 0) {
      return p("No users found.");
    }
    
    return ul({ class: "user-list" }, 
      users.map(user => 
        li({ class: "user-item" }, [
          p({ class: "username" }, user.username),
          p({ class: "user-bio" }, user.bio || "No bio")
        ])
      )
    );
  };
  
  return Card({
    title: "Your Network",
    className: "network-tabs",
    children: [
      // Error message
      () => error.val ? div({ class: "error-message" }, error.val) : null,
      
      // Network stats
      div({ class: "network-stats" }, [
        div({ 
          class: `tab ${activeTab.val === 'followers' ? 'active' : ''}`,
          onclick: () => activeTab.val = 'followers'
        }, [
          "Followers: ",
          span({ class: "count" }, userStore.state.followers.val.length)
        ]),
        div({ 
          class: `tab ${activeTab.val === 'following' ? 'active' : ''}`,
          onclick: () => activeTab.val = 'following'
        }, [
          "Following: ",
          span({ class: "count" }, userStore.state.following.val.length)
        ])
      ]),
      
      // Tab content
      div({ class: "tab-content" }, [
        // Followers tab
        () => activeTab.val === 'followers' ? 
          div({ class: "followers-tab" }, [
            h4("People following you"),
            UserList({ users: userStore.state.followers.val })
          ]) : null,
        
        // Following tab
        () => activeTab.val === 'following' ? 
          div({ class: "following-tab" }, [
            h4("People you follow"),
            UserList({ users: userStore.state.following.val })
          ]) : null
      ])
    ]
  });
}