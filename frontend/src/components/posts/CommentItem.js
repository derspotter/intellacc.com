import van from 'vanjs-core';
const { div, span, button } = van.tags;
import { isAdminState } from '../../services/auth';
import postsStore from '../../store/posts';

/**
 * Single comment component
 */
export default function CommentItem({ comment, postId }) {
  // Handle delete comment
  const handleDeleteComment = () => {
    postsStore.actions.deleteComment.call(postsStore, comment.id, postId);
  };
  
  return div({ class: "comment-item" }, [
    div({ class: "comment-header" }, [
      div({ class: "comment-author" }, comment.username || 'Anonymous'),
      div({ class: "comment-date" }, new Date(comment.created_at).toLocaleDateString())
    ]),
    div({ class: "comment-content" }, comment.content),
    div({ class: "comment-actions" }, [
      () => isAdminState.val ? 
        button({ 
          class: "comment-action delete", 
          onclick: handleDeleteComment
        }, "🗑️ Delete") : null
    ])
  ]);
}
