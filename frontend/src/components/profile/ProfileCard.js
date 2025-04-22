import van from 'vanjs-core';
const { div, h3, p, h4 } = van.tags;
import Card from '../common/Card';
import Button from '../common/Button';
import userStore from '../../store/user';

/**
 * User profile card component
 */
export default function ProfileCard({ onEdit }) {
  // Fetch user profile if needed
  if (!userStore.state.profile.val) {
    setTimeout(() => userStore.actions.fetchUserProfile.call(userStore), 0);
  }
  
  return Card({
    title: "Profile",
    className: "profile-card",
    children: [
      // Loading state
      () => !userStore.state.profile.val ? 
        p("Loading profile...") :
        div({ class: "profile-content" }, [
          h3({ class: "username" }, userStore.state.profile.val.username),
          p({ class: "email" }, userStore.state.profile.val.email),
          div({ class: "bio-section" }, [
            h4("Bio"),
            p({ class: "bio" }, userStore.state.profile.val.bio || "No bio provided")
          ]),
          Button({
            onclick: onEdit,
            className: "edit-profile-button",
            variant: "primary", // Add primary variant
            children: "Edit Profile" // Pass text via children prop
          })
        ])
    ]
  });
}