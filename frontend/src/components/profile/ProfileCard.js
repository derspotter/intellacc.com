import van from 'vanjs-core';
const { div, h3, p, h4 } = van.tags;
import Card from '../common/Card';
import Button from '../common/Button';
import userStore from '../../store/user';

/**
 * User profile card component - reusable for current user and public profiles
 */
export default function ProfileCard({ onEdit, user, followButton }) {
  // If no user prop provided, use current user data (existing behavior)
  const isCurrentUser = !user;
  const userData = user || userStore.state.profile.val;
  
  // Fetch current user profile if needed (only for current user)
  if (isCurrentUser && !userStore.state.profile.val) {
    setTimeout(() => userStore.actions.fetchUserProfile.call(userStore), 0);
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