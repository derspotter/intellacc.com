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
    // bio: userStore.state.profile.val?.bio || '', // No longer driving textarea value directly
    submitting: false,
    error: '',
    success: ''
  });
  
  const bioTextareaId = "profile-bio-textarea"; // ID for the textarea
  const bioInputState = van.state(userStore.state.profile.val?.bio || '');

  const handleSubmit = async () => { // No 'e' needed if called directly
    
    const currentBio = bioInputState.val;

    editState.val = {...editState.val, submitting: true, error: '', success: ''};

    try {
      // Use the 'currentBio' obtained from the textarea for the update
      const success = await userStore.actions.updateUserProfile.call(userStore, currentBio);

      if (success) {
        onCancel(); // Call the passed-in onCancel function
        // Optionally, you might want to reset editState here if ProfileEditor is reused
        // For now, we just transition away.
        // editState.val = { submitting: false, success: '', error: '' }; // Example reset
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

  // Initial value is now set by bioInputState and the 'value' binding on textarea.
  
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
      form({ 
        // No onsubmit for now
        class: "profile-form" 
      }, [
        div({ class: "form-group" }, [
          label({ for: bioTextareaId }, "Bio:"), // Use id for 'for'
          textarea({
            id: bioTextareaId,
            rows: 4,
            class: "bio-textarea",
            disabled: editState.val.submitting,
            value: bioInputState,
            oninput: e => bioInputState.val = e.target.value
          })
        ]), // Comma added here to separate the form-group div from the form-buttons div
        div({ class: "form-buttons" }, [
          Button({
            type: "button", // Explicitly button, not submit
            onclick: handleSubmit, // Call handleSubmit directly
            disabled: editState.val.submitting,
            className: "submit-button",
            variant: "primary",
            children: editState.val.submitting ? "Saving..." : "Save Profile"
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