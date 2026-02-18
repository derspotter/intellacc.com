import {
  createEffect,
  createMemo,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show
} from 'solid-js';
import {
  requestBlob,
  getPostComments,
  createComment,
  likePost,
  unlikePost,
  updatePost,
  deletePost,
  uploadPostImage
} from '../../services/api';
import { getCurrentUserId, isAdmin, isAuthenticated } from '../../services/auth';

const normalizePosts = (payload) => {
  if (!payload) return [];
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload.items)) return payload.items;
  if (Array.isArray(payload.data)) return payload.data;
  return [];
};

const MAX_ATTACHMENT_SIZE = 4_000_000;

const safeUrl = () => {
  try {
    return window?.URL || null;
  } catch {
    return null;
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

  const [isEditing, setIsEditing] = createSignal(false);
  const [editContent, setEditContent] = createSignal('');
  const [editAttachment, setEditAttachment] = createSignal(null);
  const [editAttachmentPreview, setEditAttachmentPreview] = createSignal(null);
  const [editRemovingAttachment, setEditRemovingAttachment] = createSignal(false);
  const [editSubmitting, setEditSubmitting] = createSignal(false);
  const [editError, setEditError] = createSignal('');

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

  const isMine = () => String(post().user_id) === getCurrentUserId();
  const canEdit = () => isMine() || isAdmin();

  const applyPostPatch = (patch) => {
    const nextPost = typeof patch === 'function' ? patch(post()) : patch;
    props.onPostUpdate?.(post().id, nextPost);
  };

  const clearActionError = () => setActionError('');
  const clearEditError = () => setEditError('');

  const resetEditState = () => {
    const current = editAttachmentPreview();
    if (current) {
      safeUrl()?.revokeObjectURL(current);
    }

    setEditAttachment(null);
    setEditAttachmentPreview(null);
    setEditRemovingAttachment(false);
    setEditContent('');
    setEditSubmitting(false);
    setEditError('');
    setIsEditing(false);
  };

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

  const handleStartEdit = () => {
    clearEditError();
    setEditContent(post().content || '');
    setEditAttachment(null);
    setEditAttachmentPreview(null);
    setEditRemovingAttachment(false);
    setIsEditing(true);
  };

  const handleCancelEdit = () => {
    resetEditState();
  };

  const handleEditAttachmentChange = (event) => {
    const file = event.target?.files?.[0] || null;
    if (!file) {
      return;
    }

    if (!file.type.startsWith('image/')) {
      setEditError('Only image files are supported.');
      return;
    }
    if (file.size > MAX_ATTACHMENT_SIZE) {
      setEditError('File is too large. Limit is 4MB.');
      return;
    }

    const previous = editAttachmentPreview();
    if (previous) {
      safeUrl()?.revokeObjectURL(previous);
    }
    setEditAttachment(file);
    setEditAttachmentPreview(safeUrl()?.createObjectURL(file) || null);
    setEditRemovingAttachment(false);
    setEditError('');
  };

  const handleSaveEdit = async () => {
    const content = editContent().trim();
    if (!content) {
      setEditError('Post content cannot be empty.');
      return;
    }

    try {
      setEditSubmitting(true);
      setEditError('');
      const payload = { content };

      const attachmentFile = editAttachment();
      if (attachmentFile) {
        const uploaded = await uploadPostImage(attachmentFile);
        payload.image_attachment_id = uploaded?.attachmentId || null;
      } else if (editRemovingAttachment()) {
        payload.image_attachment_id = null;
      }

      if (attachmentFile || editRemovingAttachment()) {
        payload.image_url = null;
      }

      const updated = await updatePost(post().id, payload);
      if (updated) {
        applyPostPatch(updated);
        setEditAttachmentPreview(null);
      } else {
        applyPostPatch({
          ...post(),
          content,
          image_attachment_id: payload.image_attachment_id || post().image_attachment_id,
          image_url: payload.image_url || post().image_url
        });
      }

      resetEditState();
    } catch (error) {
      setEditError(error?.message || 'Failed to update post.');
    } finally {
      setEditSubmitting(false);
    }
  };

  const handleDelete = async () => {
    if (!window.confirm('Delete this post?')) {
      return;
    }

    try {
      await deletePost(post().id);
      props.onPostDelete?.(post().id);
    } catch (error) {
      setActionError(error?.message || 'Failed to delete post.');
    }
  };

  createEffect(() => {
    const nextAttachmentId = post().image_attachment_id || null;
    const current = attachmentSrc();

    if (current) {
      URL.revokeObjectURL(current);
      setAttachmentSrc(null);
    }

    if (!nextAttachmentId) {
      return;
    }

    requestBlob(`/attachments/${nextAttachmentId}`)
      .then((blob) => {
        const nextUrl = URL.createObjectURL(blob);
        setAttachmentSrc(nextUrl);
      })
      .catch((error) => {
        console.error('Failed to load post attachment', error);
      });
  });

  onCleanup(() => {
    const attachment = attachmentSrc();
    if (attachment) {
      URL.revokeObjectURL(attachment);
    }

    const preview = editAttachmentPreview();
    if (preview) {
      URL.revokeObjectURL(preview);
    }
  });

  return (
    <article class="feed-item">
      <header class="feed-item-header">
        <h2>{author()}</h2>
        <span class="meta">{meta()}</span>
      </header>

      <Show when={isEditing()} fallback={
        <p class="post-content-block">{post().content || 'No content'}</p>
      }>
        <section class="post-edit-form">
          <textarea
            value={editContent()}
            onInput={(event) => setEditContent(event.target.value)}
            disabled={editSubmitting()}
            rows={4}
          />
          <div class="edit-attachment-controls">
            <label class="file-picker">
              <input
                type="file"
                accept="image/*"
                onChange={handleEditAttachmentChange}
                disabled={editSubmitting()}
              />
              <span>{editAttachment() ? 'Change image' : 'Replace image'}</span>
            </label>
            <Show when={hasAttachment() || editAttachment()}>
              <button
                type="button"
                class="ghost"
                onClick={() => setEditRemovingAttachment((value) => !value)}
                disabled={editSubmitting()}
              >
                {editRemovingAttachment() ? 'Undo remove' : 'Remove image'}
              </button>
            </Show>
          </div>
          <Show when={editAttachmentPreview()}>
            <img
              src={editAttachmentPreview()}
              class="post-attachment-preview"
              alt="Updated attachment"
            />
          </Show>
          <Show when={editRemovingAttachment() && !editAttachmentPreview()}>
            <p class="muted">Image will be removed.</p>
          </Show>
          <Show when={editError()}>
            <p class="error">{editError()}</p>
          </Show>
          <div class="post-edit-actions">
            <button type="button" onClick={handleSaveEdit} disabled={editSubmitting()}>
              {editSubmitting() ? 'Saving…' : 'Save'}
            </button>
            <button type="button" onClick={handleCancelEdit} disabled={editSubmitting()}>
              Cancel
            </button>
          </div>
        </section>
      </Show>

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
        <Show when={canEdit()}>
          <button type="button" class="edit-btn" onClick={handleStartEdit}>
            Edit
          </button>
          <button type="button" class="delete-btn" onClick={handleDelete}>
            Delete
          </button>
        </Show>
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
