import van from 'vanjs-core';
const { div, span, button } = van.tags;
import Card from '../common/Card';
import { isAdminState } from '../../services/auth';
import postsStore from '../../store/posts';  // Import the store object directly

/**
 * Single post component
 */
export default function PostItem({ post }) {
  // Create a bound helper function for delete
  const handleDeletePost = (postId) => {
    postsStore.actions.deletePost.call(postsStore, postId);
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
      div({ class: "post-actions" }, [
        button({ class: "post-action", onclick: () => {} }, "💬 Comment"),
        button({ class: "post-action", onclick: () => {} }, "👍 Like"),
        () => isAdminState.val ? 
          button({ 
            class: "post-action delete", 
            onclick: () => handleDeletePost(post.id)
          }, "🗑️ Delete") : null
      ])
    ]
  });
}