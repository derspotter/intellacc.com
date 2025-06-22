import van from 'vanjs-core';
const { div, h3, p, h4 } = van.tags;
import Card from '../common/Card';
import Button from '../common/Button';
import api from '../../services/api';
import auth from '../../services/auth';

/**
 * User card component for displaying other users with follow/unfollow functionality
 */
export default function UserCard({ userId, userData = null, showFollowButton = true }) {
  const user = van.state(userData);
  const loading = van.state(false);
  const following = van.state(false);
  const error = van.state('');

  // Fetch user data if not provided
  if (!user.val && userId) {
    loading.val = true;
    api.users.getUser(userId)
      .then(fetchedUser => {
        user.val = fetchedUser;
        loading.val = false;
      })
      .catch(err => {
        console.error('Error fetching user:', err);
        error.val = 'Failed to load user';
        loading.val = false;
      });
  }

  // For now, don't auto-check follow status to prevent API loops
  // Follow status will be determined by the context where UserCard is used

  const handleFollowToggle = async () => {
    if (!auth.isLoggedInState.val || !user.val) return;
    
    try {
      loading.val = true;
      if (following.val) {
        await api.users.unfollow(user.val.id);
        following.val = false;
      } else {
        await api.users.follow(user.val.id);
        following.val = true;
      }
    } catch (err) {
      console.error('Error toggling follow:', err);
      error.val = 'Failed to update follow status';
    } finally {
      loading.val = false;
    }
  };

  const isCurrentUser = () => {
    if (!auth.isLoggedInState.val || !user.val) return false;
    const currentUser = auth.getTokenData();
    return currentUser && currentUser.userId === user.val.id;
  };

  return Card({
    title: "User Profile",
    className: "user-card",
    children: [
      // Error message
      () => error.val ? div({ class: "error-message" }, error.val) : null,
      
      // Loading state
      () => loading.val && !user.val ? 
        p("Loading user...") :
        
      // User content
      () => user.val ? div({ class: "user-content" }, [
        h3({ class: "username" }, user.val.username),
        user.val.email ? p({ class: "email" }, user.val.email) : null,
        div({ class: "bio-section" }, [
          h4("Bio"),
          p({ class: "bio" }, user.val.bio || "No bio provided")
        ]),
        
        // Follow button (only show if not current user and follow button enabled)
        () => showFollowButton && !isCurrentUser() && auth.isLoggedInState.val ? 
          Button({
            onclick: handleFollowToggle,
            className: `follow-button ${following.val ? 'following' : 'not-following'}`,
            variant: following.val ? "secondary" : "primary",
            disabled: loading.val,
            children: () => loading.val ? "Loading..." : (following.val ? "Unfollow" : "Follow")
          }) : null
      ]) : null
    ]
  });
}