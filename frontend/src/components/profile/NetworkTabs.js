import van from 'vanjs-core';
const { div, h3, h4, p, ul, li, span } = van.tags;
import Card from '../common/Card';
import userStore from '../../store/user';

/**
 * Component to display user's network (followers and following)
 */
export default function NetworkTabs() {
  // Active tab state
  const activeTab = van.state('followers');
  
  // Fetch network data if needed
  if (userStore.state.followers.val.length === 0 && userStore.state.following.val.length === 0) {
    setTimeout(() => {
      userStore.actions.fetchFollowers.call(userStore);
      userStore.actions.fetchFollowing.call(userStore);
    }, 0);
  }
  
  // User list component
  const UserList = ({ users }) => {
    if (users.length === 0) {
      return p("No users found.");
    }
    
    return ul({ class: "user-list" }, 
      users.map(user => 
        li({ class: "user-item" }, [
          div({ class: "username" }, user.username),
          div({ class: "user-bio" }, user.bio || "No bio")
        ])
      )
    );
  };
  
  return Card({
    title: "Your Network",
    className: "network-tabs",
    children: [
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