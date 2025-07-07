import van from 'vanjs-core';
const { div, h3, p, h4, span } = van.tags;
import Card from '../common/Card';
import Button from '../common/Button';
import userStore from '../../store/user';
import api from '../../services/api';
import auth from '../../services/auth';

/**
 * User profile card component - reusable for current user and public profiles
 */
export default function ProfileCard({ onEdit, user, followButton }) {
  // If no user prop provided, use current user data (existing behavior)
  const isCurrentUser = !user;
  const userData = user || userStore.state.profile.val;
  
  // State for reputation data
  const reputationData = van.state(null);
  const loadingReputation = van.state(false);
  
  // Fetch current user profile if needed (only for current user)
  if (isCurrentUser && !userStore.state.profile.val) {
    setTimeout(() => userStore.actions.fetchUserProfile.call(userStore), 0);
  }
  
  // Fetch reputation data (for current user or public profiles)
  if (auth.isLoggedInState.val && !reputationData.val && !loadingReputation.val && userData) {
    loadingReputation.val = true;
    const reputationPromise = isCurrentUser 
      ? api.leaderboard.getUserRank()
      : api.scoring.getUserReputation(userData.id);
      
    reputationPromise
      .then(data => {
        reputationData.val = data;
        loadingReputation.val = false;
      })
      .catch(error => {
        console.error('Failed to fetch reputation data:', error);
        loadingReputation.val = false;
      });
  }
  
  return Card({
    title: "Profile",
    className: "profile-card",
    children: [
      // Loading state
      () => !userData ? 
        p("Loading profile...") :
        div({ class: "profile-content" }, [
          h3({ class: "username" }, userData.username),
          userData.email ? p({ class: "email" }, userData.email) : null,
          
          // Reputation section for all users
          div({ class: "reputation-section" }, [
            h4("Reputation"),
            () => loadingReputation.val ? 
              p({ class: "reputation-loading" }, "Loading reputation...") :
              reputationData.val ? div({ class: "reputation-stats" }, [
                div({ class: "reputation-item" }, [
                  span({ class: "reputation-label" }, "Points: "),
                  span({ class: "reputation-value points-value" }, reputationData.val.rep_points.toFixed(1))
                ]),
                div({ class: "reputation-item" }, [
                  span({ class: "reputation-label" }, "Global Rank: "),
                  span({ class: "reputation-value rank-value" }, reputationData.val.rank ? `#${reputationData.val.rank}` : 'Unranked')
                ]),
                div({ class: "reputation-item" }, [
                  span({ class: "reputation-label" }, "Predictions: "),
                  span({ class: "reputation-value predictions-value" }, reputationData.val.total_predictions || 0)
                ])
              ]) : p({ class: "reputation-none" }, "Make predictions to build reputation")
          ]),
          
          div({ class: "bio-section" }, [
            h4("Bio"),
            p({ class: "bio" }, userData.bio || "No bio provided")
          ]),
          // Show edit button for current user, follow button for others
          isCurrentUser ? 
            Button({
              onclick: onEdit,
              className: "edit-profile-button",
              variant: "primary",
              children: "Edit Profile"
            }) : followButton
        ])
    ]
  });
}