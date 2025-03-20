import van from 'vanjs-core';
const { form, textarea, div } = van.tags;
import Button from '../common/Button';
import Card from '../common/Card';
import postsStore from '../../store/posts';  // Direct store import

/**
 * Form for creating new posts
 */
export default function CreatePostForm() {
  const formState = van.state({
    content: '',
    image_url: '',
    submitting: false,
    error: '',
    success: ''
  });
  
  const handleSubmit = async (e) => {
    e.preventDefault();
    
    if (!formState.val.content.trim()) {
      formState.val = {...formState.val, error: 'Post content cannot be empty'};
      return;
    }
    
    formState.val = {...formState.val, submitting: true, error: ''};
    
    try {
      // Just use the store directly
      await postsStore.actions.createPost.call(postsStore, 
        formState.val.content, 
        formState.val.image_url || null
      );
      
      // Reset form on success
      formState.val = {
        content: '',
        image_url: '',
        submitting: false,
        error: '',
        success: 'Post created successfully!'
      };
      
      // Clear success message after 3 seconds
      setTimeout(() => {
        formState.val = {...formState.val, success: ''};
      }, 3000);
    } catch (error) {
      formState.val = {
        ...formState.val, 
        submitting: false, 
        error: error.message || 'Failed to create post'
      };
    }
  };
  
  return Card({
    title: "Create Post",
    className: "create-post-card",
    children: [
      // Error/success message
      () => formState.val.error ? 
        div({ class: "error-message" }, formState.val.error) : null,
      () => formState.val.success ? 
        div({ class: "success-message" }, formState.val.success) : null,
        
      // Post form
      form({ onsubmit: handleSubmit, class: "post-form" }, [
        div({ class: "form-group" }, [
          textarea({
            placeholder: "What's on your mind?",
            value: formState.val.content,
            onchange: (e) => formState.val = {...formState.val, content: e.target.value},
            disabled: formState.val.submitting,
            rows: 3,
            class: "post-textarea"
          })
        ]),
        
        div({ class: "form-actions" }, [
          Button({
            type: "submit",
            disabled: formState.val.submitting,
            className: "submit-button"
          }, formState.val.submitting ? "Posting..." : "Post")
        ])
      ])
    ]
  });
}