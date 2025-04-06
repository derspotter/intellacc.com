import van from 'vanjs-core';
const { div, span, button, ul, li } = van.tags;
import Card from '../common/Card';
import { isAdminState } from '../../services/auth';
import postsStore from '../../store/posts';
import auth from '../../services/auth';

/**
 * Single post component
 */
export default function PostItem({ post }) {
  // First create a DOM element reference for the comments container
  const commentsContainer = div({ class: "comments-section" });
  
  // Track if comments are showing
  let commentsShown = false;
  
  // Debug log for like status 
  console.log(`Post ${post.id} - liked_by_user:`, post.liked_by_user, 'store likeStatus:', postsStore.state.likeStatus.val[post.id]);

  // Create a bound helper function for delete
  const handleDeletePost = (postId) => {
    postsStore.actions.deletePost.call(postsStore, postId);
  };
  
  // Handle like button click
  const handleLikeToggle = (postId) => {
    postsStore.actions.toggleLike.call(postsStore, postId);
  };
  
  // Toggle comments visibility
  const handleToggleComments = (postId) => {
    console.log('Toggle comments for post:', postId);
    
    // If comments are already shown, hide them by emptying the container
    if (commentsShown) {
      commentsContainer.innerHTML = '';
      commentsShown = false;
      return;
    }
    
    // Now we're showing comments
    commentsShown = true;
    
    // Show loading first
    commentsContainer.innerHTML = 'Loading comments...';
    
    // Get comments for this post (fetch if needed)
    const existingComments = postsStore.state.comments.val[postId] || [];
    const isLoading = postsStore.state.commentLoading.val[postId];
    
    if (existingComments.length > 0) {
      // We already have comments, render them
      commentsContainer.innerHTML = '';
      const commentsList = ul({ class: "comments-list" });
      
      // Add up to 5 comments
      existingComments.slice(0, 5).forEach(comment => {
        const commentItem = li({ class: "comment-item" },
          span({ class: "comment-author" }, `${comment.username || 'Anonymous'}: `),
          span({ class: "comment-content" }, comment.content)
        );
        van.add(commentsList, commentItem);
      });
      
      van.add(commentsContainer, commentsList);
    } 
    else if (!isLoading) {
      // Fetch comments if not loading already
      postsStore.actions.fetchComments.call(postsStore, postId)
        .then(comments => {
          // Clear the container first
          commentsContainer.innerHTML = '';
          
          if (comments && comments.length > 0) {
            // Render the comments
            const commentsList = ul({ class: "comments-list" });
            
            // Add up to 5 comments
            comments.slice(0, 5).forEach(comment => {
              const commentItem = li({ class: "comment-item" },
                span({ class: "comment-author" }, `${comment.username || 'Anonymous'}: `),
                span({ class: "comment-content" }, comment.content)
              );
              van.add(commentsList, commentItem);
            });
            
            van.add(commentsContainer, commentsList);
          } else {
            // No comments
            van.add(commentsContainer, "No comments yet.");
          }
        })
        .catch(error => {
          console.error('Error fetching comments:', error);
          commentsContainer.innerHTML = 'Error loading comments.';
        });
    }
  };

  return Card({
    className: "post-card",
    children: [
      div({ class: "post-header" }, [
        div({ class: "post-author" }, post.username || 'Anonymous'),
        div({ class: "post-date" }, new Date(post.created_at).toLocaleDateString())
      ]),
      div({ class: "post-content" }, post.content),
      post.image_url ? div({ class: "post-image" }, 
        van.tags.img({ src: post.image_url, alt: "Post image" })
      ) : null,
      div({ class: "post-stats" }, [
        span({ class: "post-stat" }, `${post.like_count || 0} likes`),
        span({ 
          class: "post-stat comment-count", 
          style: "cursor: pointer;",
          onclick: () => handleToggleComments(post.id) 
        }, `${post.comment_count || 0} comments`),
      ]),
      div({ class: "post-actions" }, [
        button({ 
          class: "post-action", 
          onclick: () => handleToggleComments(post.id)
        }, "💬 Comment"),
        () => {
          // Prioritize the store's like status over the post's liked_by_user field
          // This ensures that toggled state is reflected immediately in the UI
          const isLiked = postsStore.state.likeStatus.val[post.id] !== undefined 
              ? postsStore.state.likeStatus.val[post.id] 
              : post.liked_by_user;
              
          console.log(`Rendering like button for post ${post.id}: Store status=${postsStore.state.likeStatus.val[post.id]}, Post status=${post.liked_by_user}, Using=${isLiked}`);
              
          return button({
            class: "post-action like-button", // Remove dynamic 'liked' class
            onclick: (e) => {
              // Add a small animation effect
              e.target.classList.add('animate-like');
              setTimeout(() => e.target.classList.remove('animate-like'), 300);
              
              handleLikeToggle(post.id);
            }
          }, isLiked ? "❤️ Like" : "🤍 Like"); // Always show "Like", just change the heart
        },
        () => isAdminState.val ? 
          button({ 
            class: "post-action delete", 
            onclick: () => handleDeletePost(post.id)
          }, "🗑️ Delete") : null
      ]),
      // Include the comments container directly in the DOM tree
      commentsContainer
    ]
  });
}
