import van from 'vanjs-core';
const { div, form, textarea, label } = van.tags;
import Button from '../common/Button';
import Card from '../common/Card';
import userStore from '../../store/user';

/**
 * Component for editing user profile
 */
export default function ProfileEditor({ onCancel }) {
  const editState = van.state({
    bio: userStore.state.profile.val?.bio || '',
    submitting: false,
    error: '',
    success: ''
  });
  
  const handleSubmit = async (e) => {
    e.preventDefault();
    editState.val = {...editState.val, submitting: true, error: ''};
    
    try {
      await userStore.actions.updateUserProfile.call(userStore, editState.val.bio);
      
      editState.val = {
        ...editState.val,
        submitting: false,
        error: '',
        success: 'Profile updated successfully!'
      };
      
      // Return to profile view after brief delay
      setTimeout(() => {
        if (onCancel) onCancel();
      }, 1500);
    } catch (error) {
      editState.val = {
        ...editState.val, 
        submitting: false, 
        error: error.message || 'Failed to update profile'
      };
    }
  };
  
  return Card({
    title: "Edit Profile",
    className: "profile-editor",
    children: [
      // Error/success message
      () => editState.val.error ? 
        div({ class: "error-message" }, editState.val.error) : null,
      () => editState.val.success ? 
        div({ class: "success-message" }, editState.val.success) : null,
      
      // Edit form
      form({ onsubmit: handleSubmit, class: "profile-form" }, [
        div({ class: "form-group" }, [
          label({ for: "bio" }, "Bio:"),
          textarea({
            id: "bio",
            rows: 4,
            class: "bio-textarea",
            disabled: editState.val.submitting,
            value: editState.val.bio,
            onchange: (e) => editState.val = {...editState.val, bio: e.target.value}
          })
        ]),
        
        div({ class: "form-buttons" }, [
          Button({
            type: "submit",
            disabled: editState.val.submitting,
            className: "submit-button",
            variant: "primary", // Apply primary style to Save button
            children: editState.val.submitting ? "Saving..." : "Save Profile" // Pass text via children prop
          }),
          Button({
            type: "button",
            onclick: onCancel,
            disabled: editState.val.submitting,
            className: "cancel-button",
            children: "Cancel" // Pass text via children prop
          })
        ])
      ])
    ]
  });
}