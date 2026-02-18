import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from 'solid-js';
import {
  requestBlob,
  getPostComments,
  createComment,
  likePost,
  unlikePost
} from '../../services/api';

const normalizePosts = (payload) => {
  if (!payload) return [];
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload.items)) return payload.items;
  if (Array.isArray(payload.data)) return payload.data;
  return [];
};

const isAuthenticated = () => {
  try {
    return !!localStorage.getItem('token');
  } catch {
    return false;
  }
};

export default function PostItem(props) {
  const post = () => props.post || {};
  const hasAttachment = () => !!post().image_attachment_id;
  const [attachmentSrc, setAttachmentSrc] = createSignal(null);
  const [likeCount, setLikeCount] = createSignal(0);
  const [likedByUser, setLikedByUser] = createSignal(false);
  const [commentCount, setCommentCount] = createSignal(0);
  const [commentText, setCommentText] = createSignal('');
  const [commentSubmitting, setCommentSubmitting] = createSignal(false);
  const [commentsLoading, setCommentsLoading] = createSignal(false);
  const [commentsVisible, setCommentsVisible] = createSignal(false);
  const [comments, setComments] = createSignal([]);
  const [commentsLoaded, setCommentsLoaded] = createSignal(false);
  const [actionError, setActionError] = createSignal('');
  const [commentsError, setCommentsError] = createSignal('');

  createEffect(() => {
    const current = post();
    setLikeCount(Number(current.like_count) || 0);
    setLikedByUser(Boolean(current.liked_by_user));
    setCommentCount(Number(current.comment_count) || 0);
  });

  const author = () => post().username || `user-${post().user_id || 'unknown'}`;
  const meta = createMemo(() => {
    const date = post().created_at ? new Date(post().created_at).toLocaleString() : '';
    return `${likeCount()} likes · ${date}`;
  });

  const applyPostPatch = (patch) => {
    const nextPost = typeof patch === 'function' ? patch(post()) : patch;
    props.onPostUpdate?.(post().id, nextPost);
  };

  const clearActionError = () => setActionError('');

  const handleLike = async () => {
    clearActionError();
    if (!isAuthenticated()) {
      setActionError('Sign in to like posts.');
      return;
    }

    const nextLiked = !likedByUser();
    const nextCount = nextLiked ? likeCount() + 1 : Math.max(0, likeCount() - 1);

    setLikedByUser(nextLiked);
    setLikeCount(nextCount);
    applyPostPatch({
      ...post(),
      liked_by_user: nextLiked,
      like_count: nextCount
    });

    try {
      if (nextLiked) {
        await likePost(post().id);
      } else {
        await unlikePost(post().id);
      }
    } catch (error) {
      const rollbackCount = nextLiked ? nextCount - 1 : nextCount + 1;
      setLikedByUser(!nextLiked);
      setLikeCount(Math.max(0, rollbackCount));
      setActionError(error?.message || 'Failed to update like.');
      applyPostPatch({
        ...post(),
        liked_by_user: !nextLiked,
        like_count: Math.max(0, rollbackCount)
      });
    }
  };

  const loadComments = async () => {
    if (commentsLoaded()) {
      return;
    }

    if (!isAuthenticated()) {
      setCommentsError('Sign in to view comments.');
      return;
    }

    try {
      setCommentsLoading(true);
      setCommentsError('');
      const response = await getPostComments(post().id);
      setComments(normalizePosts(response));
      setCommentsLoaded(true);
    } catch (error) {
      setCommentsError(error?.message || 'Failed to load comments.');
    } finally {
      setCommentsLoading(false);
    }
  };

  const toggleComments = async () => {
    setCommentsVisible((next) => !next);
    if (!commentsVisible()) {
      await loadComments();
    }
  };

  const submitComment = async (event) => {
    event.preventDefault();
    const content = commentText().trim();
    if (!content) {
      setCommentsError('Comment cannot be empty.');
      return;
    }
    if (!isAuthenticated()) {
      setCommentsError('Sign in to comment.');
      return;
    }

    try {
      setCommentSubmitting(true);
      setCommentsError('');
      const newComment = await createComment(post().id, content);
      setComments((current) => [newComment, ...current]);
      setCommentText('');
      const nextCount = commentCount() + 1;
      setCommentCount(nextCount);
      if (!commentsLoaded()) {
        setCommentsLoaded(true);
      }
      if (!commentsVisible()) {
        setCommentsVisible(true);
      }
      applyPostPatch({ ...post(), comment_count: nextCount });
    } catch (error) {
      setCommentsError(error?.message || 'Failed to add comment.');
    } finally {
      setCommentSubmitting(false);
    }
  };

  const resolveAttachmentSrc = () => {
    if (!hasAttachment()) {
      return null;
    }
    return `/attachments/${post().image_attachment_id}`;
  };

  onMount(() => {
    const src = resolveAttachmentSrc();
    if (!src) {
      return;
    }

    requestBlob(src)
      .then((blob) => {
        const nextUrl = URL.createObjectURL(blob);
        setAttachmentSrc(nextUrl);
      })
      .catch((error) => {
        console.error('Failed to load post attachment', error);
      });
  });

  onCleanup(() => {
    const current = attachmentSrc();
    if (current) {
      URL.revokeObjectURL(current);
    }
  });

  return (
    <article class="feed-item">
      <header class="feed-item-header">
        <h2>{author()}</h2>
        <span class="meta">{meta()}</span>
      </header>
      <p>{post().content || 'No content'}</p>
      <Show when={post().ai_is_flagged}>
        <p class="ai-warning">AI-flagged content</p>
      </Show>
      <Show when={attachmentSrc()}>
        <img src={attachmentSrc()} alt="" class="post-attachment" />
      </Show>
      <p class="meta">posted by {author()}</p>

      <div class="post-actions">
        <button type="button" class={`like-btn ${likedByUser() ? 'active' : ''}`} onClick={handleLike}>
          {likedByUser() ? 'Liked' : 'Like'} ({likeCount()})
        </button>
        <button type="button" class="comment-toggle-btn" onClick={toggleComments}>
          {commentsVisible() ? 'Hide comments' : `Comments (${commentCount()})`}
        </button>
      </div>
      <Show when={actionError()}>
        <p class="error">{actionError()}</p>
      </Show>

      <Show when={commentsVisible()}>
        <section class="comment-section">
          <Show when={commentsLoading()}>
            <p class="muted">Loading comments…</p>
          </Show>
          <Show when={commentsError()}>
            <p class="error">{commentsError()}</p>
          </Show>

          <form class="comment-form" onSubmit={submitComment}>
            <label htmlFor={`solid-post-comment-${post().id}`} class="sr-only">
              Add a comment
            </label>
            <textarea
              id={`solid-post-comment-${post().id}`}
              rows={2}
              value={commentText()}
              onInput={(event) => setCommentText(event.target.value)}
              disabled={commentSubmitting()}
              placeholder="Write a comment..."
            />
            <button type="submit" disabled={commentSubmitting()}>
              {commentSubmitting() ? 'Posting…' : 'Post comment'}
            </button>
          </form>

          <ul class="comments-list">
            <For each={comments()}>
              {(comment) => (
                <li>
                  <p class="comment-author">{comment.username || `user-${comment.user_id || 'unknown'}`}</p>
                  <p>{comment.content || ''}</p>
                </li>
              )}
            </For>
            <Show when={!commentsLoading() && comments().length === 0}>
              <li class="empty-comments">No comments yet.</li>
            </Show>
          </ul>
        </section>
      </Show>
    </article>
  );
}
