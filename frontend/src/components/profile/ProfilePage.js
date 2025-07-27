import van from 'vanjs-core';
const { div, h1, button } = van.tags;
import { Await } from 'vanjs-ui';
import ProfileCard from './ProfileCard';
import ProfileEditor from './ProfileEditor';
import FollowButton from './FollowButton';
import api from '../../services/api';
import auth from '../../services/auth';
import userStore from '../../store/user';

/**
 * Universal profile page component - works for both current user and public profiles
 * @param {Object} props
 * @param {number} [props.userId] - User ID to display profile for (if not provided, shows current user)
 */
export default function ProfilePage({ userId } = {}) {
  const isCurrentUser = !userId;
  const editMode = van.state(false);

  const ProfileContent = (user) => {
    const displayName = isCurrentUser ? "My Profile" : `${user.username}'s Profile`;
    
    return div({ class: "profile-page" }, [
      // Back button only for public profiles, positioned at top
      !isCurrentUser ? button({
        onclick: () => window.history.back(),
        className: "back-button"
      }, "← Back") : null,
      
      h1(displayName),
      div({ class: "profile-container" }, [
        div({ class: "profile-column main" }, [
          // Show ProfileEditor when editing current user, otherwise show ProfileCard
          () => isCurrentUser && editMode.val
            ? ProfileEditor({ onCancel: () => editMode.val = false })
            : ProfileCard({ 
                user: isCurrentUser ? null : user, // Pass null for current user to use store data
                onEdit: isCurrentUser ? () => editMode.val = true : null,
                followButton: isCurrentUser ? null : FollowButton({ user })
              }),
          
        ]),
      ])
    ]);
  };

  if (isCurrentUser) {
    // For current user, use existing user store data
    return ProfileContent();
  } else {
    // For public profiles, fetch user data
    const userPromise = api.users.getUser(userId);
    
    // Use VanUI Await for loading states
    return Await({
      value: userPromise,
      Loading: () => div({ class: "loading" }, "Loading user profile..."),
      Error: (error) => div({ class: "error" }, [
        h1("User Not Found"),
        div("The user you're looking for doesn't exist or you don't have permission to view their profile."),
        button({
          onclick: () => window.location.hash = 'home'
        }, "Go to Home")
      ])
    }, (user) => ProfileContent(user));
  }
}