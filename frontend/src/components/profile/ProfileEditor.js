import van from 'vanjs-core';
const { div, form, textarea, label, button, input, img, span } = van.tags;
import Button from '../common/Button';
import Card from '../common/Card';
import userStore from '../../store/user';
import { api } from '../../services/api';

/**
 * Component for editing user profile
 */
export default function ProfileEditor({ onCancel }) {
  const editState = van.state({
    submitting: false,
    uploadingAvatar: false,
    error: '',
    success: ''
  });
  
  const bioTextareaId = "profile-bio-textarea";
  const usernameInputId = "profile-username-input";
  const avatarInputId = "profile-avatar-input";
  const usernameInputState = van.state(userStore.state.profile.val?.username || '');
  const bioInputState = van.state(userStore.state.profile.val?.bio || '');
  const avatarUrlState = van.state(userStore.state.profile.val?.avatar_url || '');

  const handleAvatarChange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    editState.val = { ...editState.val, uploadingAvatar: true, error: '', success: '' };

    try {
      const response = await api.attachments.uploadAvatar(file);
      if (response && response.avatarUrl) {
        avatarUrlState.val = response.avatarUrl;
        // Optionally fetch the full profile to sync the store
        await userStore.actions.fetchUserProfile.call(userStore);
        editState.val = { ...editState.val, uploadingAvatar: false, success: 'Avatar updated successfully.' };
      }
    } catch (err) {
      editState.val = { ...editState.val, uploadingAvatar: false, error: err.message || 'Failed to upload avatar.' };
    }
  };

  const handleSubmit = async () => { 
    
    const currentUsername = usernameInputState.val.trim();
    const currentBio = bioInputState.val;

    if (!currentUsername) {
      editState.val = {
        ...editState.val,
        submitting: false,
        error: 'Username cannot be empty',
        success: ''
      };
      return;
    }

    editState.val = {...editState.val, submitting: true, error: '', success: ''};

    try {
      const success = await userStore.actions.updateUserProfile.call(userStore, {
        bio: currentBio,
        username: currentUsername
      });

      if (success) {
        onCancel();
      } else {
        editState.val = {
          ...editState.val,
          submitting: false,
          error: (userStore.state.error && typeof userStore.state.error.val === 'string' && userStore.state.error.val) || 'Failed to update profile. Please try again.',
          success: ''
        };
      }
    } catch (error) {
      editState.val = {
        ...editState.val, 
        submitting: false, 
        error: error.message || 'An unexpected error occurred.',
        success: ''
      };
    }
  };

  return Card({
    title: "Edit Profile",
    className: "profile-editor",
    children: [
      div(
        {
          class: "error-message",
          style: () => editState.val.error ? '' : 'display: none;'
        },
        () => editState.val.error || ''
      ),
      div(
        {
          class: "success-message",
          style: () => editState.val.success ? '' : 'display: none;'
        },
        () => editState.val.success || ''
      ),
      
      form({ class: "profile-form" }, [
        div({ class: "form-group", style: "display: flex; align-items: center; gap: 1rem; margin-bottom: 1.5rem;" }, [
          () => avatarUrlState.val ? img({ src: avatarUrlState.val, style: "width: 64px; height: 64px; border-radius: 50%; object-fit: cover;" }) : div({ style: "width: 64px; height: 64px; border-radius: 50%; background: var(--bg-secondary); display: flex; align-items: center; justify-content: center;" }, "👤"),
          div([
            label({ for: avatarInputId, style: "cursor: pointer; padding: 0.5rem 1rem; background: var(--bg-secondary); border-radius: 4px; border: 1px solid var(--border-color); display: inline-block;" }, () => editState.val.uploadingAvatar ? "Uploading..." : "Change Avatar"),
            input({
              id: avatarInputId,
              type: "file",
              accept: "image/*",
              style: "display: none;",
              disabled: () => editState.val.uploadingAvatar,
              onchange: handleAvatarChange
            })
          ])
        ]),

        div({ class: "form-group" }, [
          label({ for: usernameInputId }, "Username:"),
          input({
            id: usernameInputId,
            type: "text",
            class: "username-input",
            disabled: () => editState.val.submitting,
            value: usernameInputState,
            oninput: e => usernameInputState.val = e.target.value
          })
        ]),
        div({ class: "form-group" }, [
          label({ for: bioTextareaId }, "Bio:"),
          textarea({
            id: bioTextareaId,
            rows: 4,
            class: "bio-textarea",
            disabled: () => editState.val.submitting,
            value: bioInputState,
            oninput: e => bioInputState.val = e.target.value
          })
        ]),
        div({ class: "form-buttons" }, [
          Button({
            type: "button",
            onclick: handleSubmit,
            disabled: () => editState.val.submitting,
            variant: "primary",
            children: () => editState.val.submitting ? "Saving..." : "Save Profile"
          }),
          Button({
            type: "button",
            onclick: onCancel,
            disabled: () => editState.val.submitting,
            children: "Cancel"
          })
        ])
      ])
    ]
  });
}
