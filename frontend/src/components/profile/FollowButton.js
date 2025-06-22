import van from 'vanjs-core';
const { button } = van.tags;
import api from '../../services/api';
import auth from '../../services/auth';

/**
 * Reusable follow/unfollow button component
 */
export default function FollowButton({ user }) {
  const following = van.state(false);
  const followLoading = van.state(false);

  const isCurrentUser = () => {
    if (!auth.isLoggedInState.val || !user) return false;
    const currentUser = auth.getTokenData();
    return currentUser && currentUser.userId === user.id;
  };

  const checkFollowStatus = async () => {
    if (!auth.isLoggedInState.val || !user) return;
    
    try {
      const followers = await api.users.getFollowers(user.id);
      const currentUser = auth.getTokenData();
      following.val = followers.some(follower => follower.id === currentUser.userId);
    } catch (err) {
      console.error('Error checking follow status:', err);
    }
  };

  const handleFollowToggle = async () => {
    if (!auth.isLoggedInState.val || !user || followLoading.val) return;
    
    try {
      followLoading.val = true;
      if (following.val) {
        await api.users.unfollow(user.id);
        following.val = false;
      } else {
        await api.users.follow(user.id);
        following.val = true;
      }
    } catch (err) {
      console.error('Error toggling follow:', err);
    } finally {
      followLoading.val = false;
    }
  };

  // Check follow status when component mounts
  if (auth.isLoggedInState.val && !isCurrentUser()) {
    setTimeout(() => checkFollowStatus(), 0);
  }

  // Don't show button for current user or if not logged in
  if (isCurrentUser() || !auth.isLoggedInState.val) {
    return null;
  }

  return button({
    onclick: handleFollowToggle,
    className: () => `follow-button ${following.val ? 'following' : 'not-following'}`,
    disabled: () => followLoading.val
  }, () => followLoading.val ? "Loading..." : (following.val ? "Unfollow" : "Follow"));
}