import van from 'vanjs-core';
const { div, span, button, ul, li, form, a } = van.tags;
import Card from '../common/Card';
import TextInput from '../common/TextInput';
import { isAdminState, getTokenData } from '../../services/auth';
import postsStore from '../../store/posts';
import auth from '../../services/auth';
import LikeButton from './LikeButton';
import EditPostForm from './EditPostForm';

// LikeButton is now in a completely separate file for better isolation

/**
 * Single post component with optimized rendering
 */
export default function PostItem({ post }) {
  // State for comment input
  const commentInput = van.state('');
  
  // Like state and handler for the post
  const likeState = van.state(!!post.liked_by_user);
  const likeCount = van.state(Number(post.like_count) || 0);

  // Check if current user owns this post
  const isCurrentUserPost = () => {
    const tokenData = getTokenData();
    return tokenData && tokenData.userId === post.user_id;
  };

  // Check if this post is being edited
  const isEditing = () => {
    return postsStore.state.editingPostId.val === post.id;
  };

  // Handle starting edit mode
  const handleStartEdit = () => {
    postsStore.actions.startEditingPost.call(postsStore, post.id);
  };

  // Handle canceling edit mode
  const handleCancelEdit = () => {
    postsStore.actions.cancelEditingPost.call(postsStore);
  };

  // Handle like button click
  const handleLikeToggle = async (postId) => {
    try {
      const newLikeState = !likeState.val;
      likeState.val = newLikeState;
      likeCount.val = newLikeState ? likeCount.val + 1 : Math.max(0, likeCount.val - 1);
      
      // Call the store action to update the like status
      await postsStore.actions.toggleLike.call(postsStore, postId);
    } catch (error) {
      console.error('Error toggling like:', error);
      // Revert the UI state on error
      likeState.val = !likeState.val;
      likeCount.val = likeState.val ? likeCount.val + 1 : Math.max(0, likeCount.val - 1);
    }
  };
  
  // Create a bound helper function for delete
  const handleDeletePost = (postId) => {
    postsStore.actions.deletePost.call(postsStore, postId);
  };

  // Handle posting a new comment
  const handlePostComment = async (postId) => {
    const content = commentInput.val.trim();
    if (!content) return;

    try {
      await postsStore.actions.createComment.call(postsStore, postId, content);
      commentInput.val = ''; // Clear input field
      postsStore.actions.toggleCommentFormVisibility.call(postsStore, postId); // Hide form after posting via store

      // If the comments list was showing, refresh it
      if (postsStore.state.commentListVisible.val[postId]) {
         // The store action already updated the comment count and potentially the list.
      }
    } catch (error) {
      console.error("Error posting comment:", error);
    }
  };

  // Handle clicking the comment count
  const handleShowComments = (postId) => {
    postsStore.actions.toggleCommentListVisibility.call(postsStore, postId); // Toggle list visibility via store

    if (postsStore.state.commentListVisible.val[postId]) {
      const existingComments = postsStore.state.comments.val[postId];
      const isLoading = postsStore.state.commentLoading.val[postId];

      if (!existingComments && !isLoading) {
        // Not loaded and not currently loading, fetch them
        postsStore.actions.fetchComments.call(postsStore, postId)
          .catch(error => {
            console.error('Error fetching comments:', error);
          });
      }
    }
  };

  // Handle clicking the "Comment" button
  const handleShowCommentForm = (postId) => {
    postsStore.actions.toggleCommentFormVisibility.call(postsStore, postId); // Toggle form visibility via store
  };

  // Handle clicking "Expand All" / "Collapse All"
  const handleToggleExpandCollapseAll = (postId) => {
    postsStore.actions.toggleExpandCollapseAll.call(postsStore, postId);
  };

  // Comment data helper functions
  // Using these functions helps isolate reactivity to specific parts of the UI
  const getCommentListVisible = (postId) => postsStore.state.commentListVisible.val[postId] || false;
  const getCommentFormVisible = (postId) => postsStore.state.commentFormVisible.val[postId] || false;
  const getCommentLoading = (postId) => postsStore.state.commentLoading.val[postId] || false;
  const getComments = (postId) => postsStore.state.comments.val[postId] || [];
  
  // Optimized reactive rendering for comments list
  const commentsListContent = (postId) => {
    // Use our helper functions to get the current state
    if (!getCommentListVisible(postId)) return null; // Hide if state is false

    const currentComments = getComments(postId);
    const isLoading = getCommentLoading(postId);

    if (isLoading && !currentComments.length) {
      return span("Loading comments...");
    }

    if (currentComments.length > 0) {
      const commentsList = ul({ class: "comments-list" });
      currentComments.forEach(comment => {
        van.add(commentsList, PostItem({ post: comment })); // Use PostItem and pass comment as post
      });
      return commentsList;
    } else if (!isLoading) {
      return span({ class: "no-comments-yet" }, "No comments yet.");
    }
    return null; // Should not happen if isLoading is true and no comments
  };

  // Optimized reactive rendering for comment form
  const commentFormContent = (postId) => {
    // Use our helper function to get the current state
    if (!getCommentFormVisible(postId)) return null; // Hide if state is false

    const commentFormEl = form({
        class: "comment-form",
        onsubmit: (e) => {
          e.preventDefault();
          handlePostComment(postId);
        }
      },
      TextInput({
        type: "textarea",
        placeholder: "Write a comment...",
        value: commentInput,
        oninput: (value) => commentInput.val = value,
        className: "comment-input"
      }),
      button({ type: "submit" }, "Post")
    );
    return commentFormEl;
  };

  
  // We're using the separated LikeButton component now

  // If post is being edited, show edit form instead
  if (isEditing()) {
    return EditPostForm({ 
      post, 
      onCancel: handleCancelEdit 
    });
  }

  return Card({
    className: "post-card",
    children: [
      div({ class: "post-header" }, [
        div({ class: "post-author" }, [
          // Make username clickable to go to user profile
          post.user_id ? 
            a({ 
              href: `#user/${post.user_id}`,
              class: "username-link",
              onclick: (e) => {
                e.preventDefault();
                window.location.hash = `user/${post.user_id}`;
              }
            }, post.username || 'Anonymous') :
            span(post.username || 'Anonymous')
        ]),
        div({ class: "post-date" }, new Date(post.created_at).toLocaleDateString())
      ]),
      div({ class: "post-content" }, post.content),
      post.image_url ? div({ class: "post-image" },
        van.tags.img({ src: post.image_url, alt: "Post image" })
      ) : null,
      div({ class: "post-stats" }, [
        span({ class: "post-stat" }, `${post.like_count || 0} likes`),
        () => span({ // Comment count - clicking shows list
          class: "post-stat comment-count",
          style: "cursor: pointer;",
          onclick: () => handleShowComments(post.id) // Use new handler
        }, `${post.comment_count || 0} comments`), // Display the count from the current post/comment object
        div({ style: "margin-left: auto;" },
          () => {
            // Only show expand/collapse for items with children
            if (!(post.comment_count > 0)) return null;
            const isExpanded = postsStore.state.allCommentsExpanded.val[post.id] || false;
            return span({
              class: "post-stat expand-all-comments",
              style: "cursor: pointer;",
              onclick: () => handleToggleExpandCollapseAll(post.id)
            }, isExpanded ? "Collapse All" : "Expand All");
          }
        )
      ]),
      div({ class: "post-actions" }, [
        button({ // Comment button - clicking shows form
          class: "post-action",
          onclick: () => handleShowCommentForm(post.id) // Use new handler
        }, "Comment"),
        // Like button component
        LikeButton({ postId: post.id }),
        // Edit button - only show for post owner
        () => isCurrentUserPost() ?
          button({
            class: "post-action edit",
            onclick: handleStartEdit
          }, "Edit") : null,
        () => isAdminState.val ?
          button({
            class: "post-action delete",
            onclick: () => handleDeletePost(post.id)
          }, "🗑️ Delete") : null
      ]),
      // Comments section - using van.derive for isolated reactivity
      van.derive(() => div({ class: "comments-section" }, [
        div({ class: "comment-form-container" }, commentFormContent(post.id)),
        div({ class: "comments-list-container" }, commentsListContent(post.id))
      ])),
    ],
  });
}