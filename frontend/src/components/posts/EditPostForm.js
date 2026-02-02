import van from 'vanjs-core';
const { div, form, textarea, button, input, img } = van.tags;
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
  const imageFile = van.state(null);
  const imagePreview = van.state(null);
  const removeImage = van.state(false);
  const attachmentUrl = van.state(post.image_attachment_id ? postsStore.state.attachmentUrls[post.image_attachment_id] : null);

  if (post.image_attachment_id && !attachmentUrl.val) {
    postsStore.actions.ensureAttachmentUrl.call(postsStore, post.image_attachment_id)
      .then(url => {
        attachmentUrl.val = url;
      })
      .catch(err => {
        console.error('Failed to load attachment preview:', err);
      });
  }

  const clearSelectedImage = (inputEl) => {
    imageFile.val = null;
    if (imagePreview.val) {
      URL.revokeObjectURL(imagePreview.val);
    }
    imagePreview.val = null;
    if (inputEl) inputEl.value = '';
  };

  const fileInputId = `edit-post-file-${post.id}`;
  const fileInput = input({
    id: fileInputId,
    class: 'file-input',
    type: 'file',
    accept: 'image/*',
    onchange: (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) {
        clearSelectedImage(e.target);
        return;
      }
      if (imagePreview.val) {
        URL.revokeObjectURL(imagePreview.val);
      }
      imageFile.val = file;
      imagePreview.val = URL.createObjectURL(file);
      removeImage.val = false;
    }
  });

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
      let nextAttachmentId;
      if (imageFile.val) {
        const uploadResult = await postsStore.actions.uploadPostImage.call(postsStore, imageFile.val);
        nextAttachmentId = uploadResult?.attachmentId || null;
      } else if (removeImage.val) {
        nextAttachmentId = null;
      }

      const options = {};
      if (nextAttachmentId !== undefined) {
        options.image_attachment_id = nextAttachmentId;
      }
      if (imageFile.val) {
        options.image_url = null;
      }
      if (removeImage.val && !imageFile.val) {
        options.image_url = null;
      }

      await postsStore.actions.updatePost.call(postsStore, post.id, content, options);
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
    removeImage.val = false;
    clearSelectedImage(fileInput);
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

        div({ class: "create-post-attachments" }, [
          div({ class: "file-row" }, [
            button({
              type: 'button',
              class: 'file-button',
              onclick: () => fileInput.click(),
              disabled: isSubmitting
            }, () => imageFile.val ? "Change File" : "Browse..."),
            () => imageFile.val ? van.tags.span({ class: "file-name" }, imageFile.val.name) : null
          ]),
          fileInput,
          () => imagePreview.val ? div({ class: "attachment-preview" }, [
            img({ src: imagePreview.val, alt: "Selected upload" }),
            button({
              type: 'button',
              class: 'attachment-remove',
              onclick: () => clearSelectedImage(fileInput),
              disabled: isSubmitting
            }, "Remove")
          ]) : null,
          () => (!imagePreview.val && (post.image_attachment_id || post.image_url) && !removeImage.val) ? div({ class: "attachment-preview" }, [
            img({ src: attachmentUrl.val || post.image_url, alt: "Current upload" }),
            button({
              type: 'button',
              class: 'attachment-remove',
              onclick: () => { removeImage.val = true; },
              disabled: isSubmitting
            }, "Remove")
          ]) : null,
          () => removeImage.val ? div({ class: "attachment-removed" }, [
            div("Image will be removed."),
            button({
              type: 'button',
              class: 'attachment-remove',
              onclick: () => { removeImage.val = false; },
              disabled: isSubmitting
            }, "Undo")
          ]) : null
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
