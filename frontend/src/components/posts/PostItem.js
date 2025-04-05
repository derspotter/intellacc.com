import van from 'vanjs-core';
const { div, span, button } = van.tags;
import Card from '../common/Card';
import { isAdminState } from '../../services/auth';
import postsStore from '../../store/posts';  // Import the store object directly

/**
 * Single post component
 */
export default function PostItem({ post }) {
  // Check if this post is liked
  van.derive(() => {
    postsStore.actions.checkLikeStatus.call(postsStore, post.id);
  });
  
  // Create a bound helper function for delete
  const handleDeletePost = (postId) => {
    postsStore.actions.deletePost.call(postsStore, postId);
  };
  
  // Handle like button click
  const handleLikeToggle = (postId) => {
    postsStore.actions.toggleLike.call(postsStore, postId);
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
        span({ class: "post-stat" }, `${post.comment_count || 0} comments`),
      ]),
      div({ class: "post-actions" }, [
        button({ class: "post-action", onclick: () => {} }, "💬 Comment"),
        () => {
          const isLiked = postsStore.state.likeStatus.val[post.id];
          return button({ 
            class: `post-action ${isLiked ? 'liked' : ''}`, 
            onclick: () => handleLikeToggle(post.id) 
          }, isLiked ? "❤️ Liked" : "🤍 Like");
        },
        () => isAdminState.val ? 
          button({ 
            class: "post-action delete", 
            onclick: () => handleDeletePost(post.id)
          }, "🗑️ Delete") : null
      ])
    ]
  });
}