import van from 'vanjs-core';
const { div, form, textarea, button } = van.tags;
import Card from '../common/Card';
import postsStore from '../../store/posts';

/**
 * Form component for editing a post
 */
export default function EditPostForm({ post, onCancel }) {
  // Local state for the form
  const editedContent = van.state(post.content || '');
  const isSubmitting = van.state(false);
  const error = van.state('');

  // Handle form submission
  const handleSubmit = async (e) => {
    e.preventDefault();
    
    const content = editedContent.val.trim();
    if (!content) {
      error.val = 'Post content cannot be empty';
      return;
    }

    isSubmitting.val = true;
    error.val = '';

    try {
      await postsStore.actions.updatePost.call(postsStore, post.id, content);
      onCancel(); // Close the edit form after successful update
    } catch (err) {
      console.error('Error updating post:', err);
      error.val = err.message || 'Failed to update post. Please try again.';
    } finally {
      isSubmitting.val = false;
    }
  };

  // Handle cancel
  const handleCancel = () => {
    // Reset form state
    editedContent.val = post.content || '';
    error.val = '';
    onCancel();
  };

  return Card({
    className: "edit-post-form",
    children: [
      div({ class: "edit-post-header" }, "Edit Post"),
      
      // Error message
      () => error.val ? 
        div({ class: "error-message" }, error.val) : null,
      
      // Edit form
      form({ 
        class: "edit-form",
        onsubmit: handleSubmit
      }, [
        div({ class: "form-group" }, [
          textarea({
            class: "edit-textarea",
            placeholder: "What's on your mind?",
            rows: 4,
            disabled: isSubmitting,
            value: editedContent,
            oninput: (e) => editedContent.val = e.target.value
          })
        ]),
        
        div({ class: "form-buttons" }, [
          button({
            type: "submit",
            class: "submit-button",
            disabled: () => isSubmitting.val || !editedContent.val.trim()
          }, () => isSubmitting.val ? "Saving..." : "Save"),
          
          button({
            type: "button",
            class: "cancel-button",
            onclick: handleCancel,
            disabled: isSubmitting
          }, "Cancel")
        ])
      ])
    ]
  });
}