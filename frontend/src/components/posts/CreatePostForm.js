import van from 'vanjs-core';
const { div, pre } = van.tags;
import Button from '../common/Button';
import Card from '../common/Card';
import TextInput from '../common/TextInput';
import postsStore from '../../store/posts';

export default function CreatePostForm() {
  // Add state for debugging info
  const text = van.state("");
  const error = van.state("");
  const debugInfo = van.state("");
  const imageFile = van.state(null);
  const imagePreview = van.state(null);

  const clearImage = (inputEl) => {
    imageFile.val = null;
    if (imagePreview.val) {
      URL.revokeObjectURL(imagePreview.val);
    }
    imagePreview.val = null;
    if (inputEl) inputEl.value = '';
  };
  
  const fileInputId = 'create-post-file';
  const fileInput = van.tags.input({
    id: fileInputId,
    class: 'file-input',
    type: 'file',
    accept: 'image/*',
    onchange: (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) {
        clearImage(e.target);
        return;
      }
      if (imagePreview.val) {
        URL.revokeObjectURL(imagePreview.val);
      }
      imageFile.val = file;
      imagePreview.val = URL.createObjectURL(file);
    }
  });
  
  return Card({
    title: "Create Post",
    className: "create-post-card",
    children: [
      // Error display
      () => error.val ? div({ class: "error-message" }, error.val) : null,
      
      // Textarea
      TextInput({
        type: 'textarea',
        placeholder: "What's on your mind?",
        value: text,
        oninput: value => text.val = value,
        rows: 3,
        className: "comment-input"
      }),

      div({ class: "create-post-attachments" }, [
        div({ class: "file-row" }, [
          van.tags.button({
            type: 'button',
            className: 'file-button',
            onclick: () => fileInput.click()
          }, () => imageFile.val ? "Change File" : "Browse..."),
          () => imageFile.val ? van.tags.span({ class: "file-name" }, imageFile.val.name) : null
        ]),
        fileInput,
        () => imagePreview.val ? div({ class: "attachment-preview" }, [
          van.tags.img({ src: imagePreview.val, alt: "Selected upload" }),
          van.tags.button({
            type: 'button',
            className: 'attachment-remove',
            onclick: () => clearImage(fileInput)
          }, "Remove")
        ]) : null
      ]),
      
      // Action buttons
      div({ class: "form-actions" }, [
        // Enhanced post button with direct style attributes
        van.tags.button({
          type: "button",
          onclick: async () => {
            if (!text.val.trim()) {
              error.val = "Post content cannot be empty";
              return;
            }
            
            error.val = "";
            debugInfo.val = "Sending post...";
            
            try {
              let imageAttachmentId = null;
              if (imageFile.val) {
                debugInfo.val = "Uploading image...";
                const uploadResult = await postsStore.actions.uploadPostImage.call(postsStore, imageFile.val);
                imageAttachmentId = uploadResult?.attachmentId || null;
              }
              await postsStore.actions.createPost.call(postsStore, text.val, imageAttachmentId);
              text.val = "";
              clearImage(fileInput);
              debugInfo.val = "Post created successfully!";
            } catch (err) {
              // Detailed error information
              error.val = `Error: ${err.message}`;
              debugInfo.val = `Full error: ${JSON.stringify(err, null, 2)}`;
              console.error("POST ERROR OBJECT:", err);
            }
          },
          style: `
            background-color: #0000ff;
            color: white;
            font-weight: bold;
            border: none;
            padding: 8px 16px;
            font-size: 16px;
            min-width: 100px;
            cursor: pointer;
            font-family: 'Courier New', monospace;
          `
        }, "POST"),
      ]),
      
      // Debug information display
      () => debugInfo.val ? 
        div({ class: "debug-info", style: "margin-top: 10px; font-size: 12px; overflow: auto; max-height: 200px; background: #f7f7f7; padding: 8px; border-radius: 4px;" }, [
          div({ style: "font-weight: bold" }, "Debug Info:"),
          pre({ style: "margin: 0; white-space: pre-wrap;" }, debugInfo.val)
        ]) : null
    ]
  });
}
