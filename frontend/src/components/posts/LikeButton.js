import van from 'vanjs-core';
import postsStore from '../../store/posts';
const { button } = van.tags;

/**
 * Simple like button component with reactive display
 */
export default function LikeButton({ postId }) {
  const isProcessing = van.state(false);
  const like = () => postsStore.state.likeStatus[postId] || false;
   
  // Handle the like button click with store-managed reactivity
  const handleLikeToggle = async () => {
    if (isProcessing.val) return;
    try {
      isProcessing.val = true;
      await postsStore.actions.toggleLike.call(postsStore, postId);
    } catch (error) {
      console.error('Error toggling like:', error);
    } finally {
      isProcessing.val = false;
    }
  };
   
  // Create the button with a reactive binding to just this post's like status
  return button({
    class: () => `post-action like-button ${like() ? 'liked' : ''} ${isProcessing.val ? 'processing' : ''}`,
    disabled: isProcessing.val,
    onclick: (e) => {
      e.target.classList.add('animate-like');
      setTimeout(() => e.target.classList.remove('animate-like'), 300);
      handleLikeToggle();
    }
  }, () => {
    const label = like() ? 'Liked' : 'Like';
    return `${label}`;
  });
}