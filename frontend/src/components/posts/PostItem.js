import van from 'vanjs-core';
const { div, span, button, ul, li, form } = van.tags;
import Card from '../common/Card';
import TextInput from '../common/TextInput';
import { isAdminState } from '../../services/auth';
import postsStore from '../../store/posts';
import auth from '../../services/auth';

/**
 * Single post component
 */
export default function PostItem({ post }) {
  // State for comment input
  const commentInput = van.state('');

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

  // Handle posting a new comment
  const handlePostComment = async (postId) => {
    const content = commentInput.val.trim();
    if (!content) return;

    try {
      await postsStore.actions.createComment.call(postsStore, postId, content);
      commentInput.val = ''; // Clear input field
      postsStore.actions.toggleCommentFormVisibility.call(postsStore, postId); // Hide form after posting via store
      // No need to clear container here, reactivity handles it

      // If the comments list was showing, refresh it
      if (postsStore.state.commentListVisible.val[postId]) {
         // Re-fetch or just update locally? Let's re-render based on store state.
         // The store action already updated the comment count and potentially the list.
         // No explicit render call needed, reactivity handles it
      }
      // Note: The comment count span updates reactively via the store.

    } catch (error) {
      console.error("Error posting comment:", error);
      // Show error to user? (Optional)
      // Maybe add error message to commentFormContainer?
      // van.add(commentFormContainer, span({ style: "color: red;" }, `Error: ${error.message}`)); // Add error reactively?
    }
  };

  // Handle clicking the comment count
  const handleShowComments = (postId) => {
    postsStore.actions.toggleCommentListVisibility.call(postsStore, postId); // Toggle list visibility via store
    // No need to clear containers here, reactivity handles it

    if (postsStore.state.commentListVisible.val[postId]) {
      const existingComments = postsStore.state.comments.val[postId];
      const isLoading = postsStore.state.commentLoading.val[postId];

      if (!existingComments && !isLoading) {
        // Not loaded and not currently loading, fetch them
        postsStore.actions.fetchComments.call(postsStore, postId)
          .catch(error => {
            console.error('Error fetching comments:', error);
            // Handle error display reactively?
          });
      }
    }
  };

  // Handle clicking the "Comment" button
  const handleShowCommentForm = (postId) => {
    postsStore.actions.toggleCommentFormVisibility.call(postsStore, postId); // Toggle form visibility via store
    // No need to clear containers here, reactivity handles it
  };

  // Handle clicking "Expand All" / "Collapse All"
  const handleToggleExpandCollapseAll = (postId) => {
    postsStore.actions.toggleExpandCollapseAll.call(postsStore, postId);
  };

  // Reactive rendering for comments list
  const commentsListContent = (postId) => {
    if (!postsStore.state.commentListVisible.val[postId]) return null; // Hide if state is false

    const currentComments = postsStore.state.comments.val[postId] || [];
    const isLoading = postsStore.state.commentLoading.val[postId];

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
      return span("No comments yet.");
    }
    return null; // Should not happen if isLoading is true and no comments
  };

  // Reactive rendering for comment form
  const commentFormContent = (postId) => {
    if (!postsStore.state.commentFormVisible.val[postId]) return null; // Hide if state is false

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
        () => span({ // Comment count - clicking shows list
          class: "post-stat comment-count",
          style: "cursor: pointer;",
          onclick: () => handleShowComments(post.id) // Use new handler
        }, `${post.comment_count || 0} comments`), // Display the count from the current post/comment object
        // New span for expand all
        // Wrapper div for right-alignment
        div({ style: "margin-left: auto;" },
          // Reactive "Expand/Collapse All" button
          () => {
            const isExpanded = postsStore.state.allCommentsExpanded.val[post.id] || false;
            return span({
              class: "post-stat expand-all-comments", // Class still useful
              style: "cursor: pointer;",
              onclick: () => handleToggleExpandCollapseAll(post.id) // Use toggle handler
            }, isExpanded ? "Collapse All" : "Expand All");
          }
        )
      ]),
      div({ class: "post-actions" }, [
        button({ // Comment button - clicking shows form
          class: "post-action",
          onclick: () => handleShowCommentForm(post.id) // Use new handler
        }, "💬 Comment"),
        () => {
          // Prioritize the store's like status over the post's liked_by_user field
          // This ensures that toggled state is reflected immediately in the UI
          const isLiked = postsStore.state.likeStatus.val[post.id] !== undefined
              ? postsStore.state.likeStatus.val[post.id]
              : post.liked_by_user;

          console.log(`Rendering like button for post ${post.id}: Store status=${postsStore.state.likeStatus.val[post.id]}, Post status=${post.liked_by_user}, Using=${isLiked}`);

          return button({
            class: "post-action like-button",
            onclick: (e) => {
              e.target.classList.add('animate-like');
              setTimeout(() => e.target.classList.remove('animate-like'), 300);
              handleLikeToggle(post.id);
            }
          }, isLiked ? "🩶 Like" : "🤍 Like");
        },
        () => isAdminState.val ?
          button({
            class: "post-action delete",
            onclick: () => handleDeletePost(post.id)
          }, "🗑️ Delete") : null
      ]),
      // Reactive comments list and form container
      () => div({ class: "comments-section" }, [
        div({ class: "comment-form-container" }, commentFormContent(post.id)),
        div({ class: "comments-list-container" }, commentsListContent(post.id))
      ])
    ]
  });
}
