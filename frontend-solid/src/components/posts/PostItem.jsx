import {
  createEffect,
  createSignal,
  For,
  onCleanup,
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
  const [commentListVisible, setCommentListVisible] = createSignal(false);
  const [commentFormVisible, setCommentFormVisible] = createSignal(false);
  const [commentsLoading, setCommentsLoading] = createSignal(false);
  const [commentsLoaded, setCommentsLoaded] = createSignal(false);
  const [comments, setComments] = createSignal([]);
  const [actionError, setActionError] = createSignal('');
  const [commentsError, setCommentsError] = createSignal('');
  const [contentExpanded, setContentExpanded] = createSignal(false);
  const [allCommentsExpanded, setAllCommentsExpanded] = createSignal(!!props.autoExpand);

  const [isEditing, setIsEditing] = createSignal(false);
  const [editContent, setEditContent] = createSignal('');
  const [editAttachment, setEditAttachment] = createSignal(null);
  const [editAttachmentPreview, setEditAttachmentPreview] = createSignal(null);
  const [editRemovingAttachment, setEditRemovingAttachment] = createSignal(false);
  const [editSubmitting, setEditSubmitting] = createSignal(false);
  const [editError, setEditError] = createSignal('');

  const autoExpand = () => !!props.autoExpand;

  createEffect(() => {
    const current = post();
    setLikeCount(Number(current.like_count) || 0);
    setLikedByUser(Boolean(current.liked_by_user));
    setCommentCount(Number(current.comment_count) || 0);
  });

  createEffect(() => {
    if (!autoExpand()) return;
    if (!commentListVisible()) {
      setCommentListVisible(true);
    }
    setAllCommentsExpanded(true);
    if (!commentsLoaded() && !commentsLoading() && currentCommentCount() > 0) {
      void loadComments();
    }
  });

  createEffect(() => {
    const shouldExpandAll = autoExpand();
    if (allCommentsExpanded() === shouldExpandAll) {
      return;
    }

    setAllCommentsExpanded(shouldExpandAll);
    setCommentListVisible(shouldExpandAll);
    if (!shouldExpandAll) {
      return;
    }

    if (!commentsLoaded() && !commentsLoading() && currentCommentCount() > 0) {
      void loadComments();
    }
  });

  const author = () => post().username || `user-${post().user_id || 'unknown'}`;
  const isMine = () => String(post().user_id) === getCurrentUserId();
  const canEdit = () => isMine() || isAdmin();
  const currentCommentCount = () => Number(post().comment_count || 0);
  const commentCountText = () => `${commentCount()} comment${commentCount() === 1 ? '' : 's'}`;
  const likeText = () => `${likeCount()} like${likeCount() === 1 ? '' : 's'}`;
  const postDate = () => (post().created_at ? new Date(post().created_at).toLocaleDateString() : '');
  const isLongContent = () => {
    const content = String(post().content || '');
    return content.length > 240 || content.split('\n').length > 6;
  };

  const applyPostPatch = (patch) => {
    const nextPost = typeof patch === 'function' ? patch(post()) : patch;
    props.onPostUpdate?.(post().id, nextPost);
  };

  const clearActionError = () => setActionError('');
  const clearEditError = () => setEditError('');

  const clearEditAttachmentPreview = () => {
    const current = editAttachmentPreview();
    if (current) {
      safeUrl()?.revokeObjectURL(current);
    }
    setEditAttachment(null);
    setEditAttachmentPreview(null);
  };

  const clearCommentForm = () => {
    setCommentText('');
    setCommentSubmitting(false);
  };

  const resetEditState = () => {
    clearEditAttachmentPreview();
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
      const fetched = normalizePosts(response);
      setComments(fetched);
      setCommentsLoaded(true);
    } catch (error) {
      setCommentsError(error?.message || 'Failed to load comments.');
    } finally {
      setCommentsLoading(false);
    }
  };

  const toggleCommentList = async () => {
    const willOpen = !commentListVisible();
    setCommentListVisible(willOpen);
    if (willOpen && !commentsLoaded()) {
      await loadComments();
    }
  };

  const toggleCommentForm = () => {
    setCommentFormVisible((next) => !next);
  };

  const handleToggleExpandCollapseAll = async () => {
    const shouldExpand = !allCommentsExpanded();
    setAllCommentsExpanded(shouldExpand);
    setCommentListVisible(shouldExpand);
    if (!shouldExpand) {
      return;
    }

    await loadComments();
  };

  const updateCommentTree = (nodes, targetId, patch) => {
    const nextPatch = (comment) => {
      if (String(comment.id) === String(targetId)) {
        const update = typeof patch === 'function' ? patch(comment) : patch;
        return { ...comment, ...update };
      }

      const children = comment.replies || [];
      const [nextChildren, didUpdate] = updateCommentTree(children, targetId, patch);
      if (!didUpdate) {
        return comment;
      }
      return { ...comment, replies: nextChildren };
    };

    let didUpdate = false;
    const nextNodes = nodes.map((comment) => {
      const nextComment = nextPatch(comment);
      if (nextComment !== comment) {
        didUpdate = true;
      }
      return nextComment;
    });

    return [nextNodes, didUpdate];
  };

  const removeFromCommentTree = (nodes, targetId) => {
    let removed = false;
    const nextNodes = [];

    nodes.forEach((comment) => {
      if (String(comment.id) === String(targetId)) {
        removed = true;
        return;
      }

      const children = comment.replies || [];
      const [nextChildren, didRemove] = removeFromCommentTree(children, targetId);
      if (didRemove) {
        removed = true;
      }

      if (nextChildren === children) {
        nextNodes.push(comment);
      } else {
        nextNodes.push({
          ...comment,
          replies: nextChildren
        });
      }
    });

    return [nextNodes, removed];
  };

  const updateCommentInList = (targetId, patch) => {
    setComments((current) => {
      const [nextNodes, updated] = updateCommentTree(current, targetId, patch);
      return updated ? nextNodes : current;
    });
  };

  const removeCommentFromList = (targetId) => {
    let didRemove = false;
    setComments((current) => {
      const [nextNodes, removed] = removeFromCommentTree(current, targetId);
      didRemove = removed;
      return removed ? nextNodes : current;
    });

    if (!didRemove) {
      return;
    }

    const nextCount = Math.max(0, commentCount() - 1);
    setCommentCount(nextCount);
    applyPostPatch({
      ...post(),
      comment_count: nextCount
    });
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
      setCommentFormVisible(false);
      clearCommentForm();
      const nextCount = commentCount() + 1;
      setCommentCount(nextCount);
      if (!commentsLoaded()) {
        setCommentsLoaded(true);
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
    clearEditAttachmentPreview();
    setEditRemovingAttachment(false);
    setIsEditing(true);
  };

  const handleCancelEdit = () => {
    clearEditAttachmentPreview();
    setEditRemovingAttachment(false);
    setEditError('');
    setIsEditing(false);
    setEditContent('');
    setEditSubmitting(false);
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

  const handleClearEditAttachment = () => {
    setEditRemovingAttachment((next) => !next);
    if (editRemovingAttachment()) {
      setEditAttachment(null);
      setEditAttachmentPreview(null);
    }
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
      } else {
        applyPostPatch({
          ...post(),
          content,
          image_attachment_id: payload.image_attachment_id ?? post().image_attachment_id,
          image_url: payload.image_url ?? post().image_url
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

  const renderComments = () => {
    if (commentsLoading()) {
      return <p class="loading-inline muted">Loading comments…</p>;
    }

    if (!commentsLoaded() && comments().length === 0) {
      return <p class="empty-comments">No comments yet.</p>;
    }

    if (comments().length === 0) {
      return <p class="empty-comments">No comments yet.</p>;
    }

    return (
      <ul class="comments-list">
        <For each={comments()}>
          {(comment) => (
            <li>
              <PostItem
                post={comment}
                onPostUpdate={updateCommentInList}
                onPostDelete={removeCommentFromList}
                autoExpand={allCommentsExpanded()}
              />
            </li>
          )}
        </For>
      </ul>
    );
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
    <article class="post-card">
      <header class="post-header">
        <div class="post-header-main">
          <div class="post-author">
            {post().user_id ? (
              <a href={`#user/${post().user_id}`} class="username-link" onClick={(event) => {
                event.preventDefault();
                window.location.hash = `user/${post().user_id}`;
              }}>
                {author()}
              </a>
            ) : (
              <span class="username-link">{author()}</span>
            )}
          </div>
          <div class="post-meta post-meta-main">
            <span class="post-header-likes">{likeText()}</span>
            <span
              class="post-header-comments"
              role="button"
              tabindex="0"
              onClick={toggleCommentList}
            >
              {commentCountText()}
            </span>
            <span class="post-date">{postDate()}</span>
          </div>
        </div>
        <div class="post-header-sub">
          <div class="post-meta post-meta-sub">
            <div class="post-header-expand-wrap">
              <Show when={currentCommentCount() > 0}>
                <span
                  class="post-header-expand"
                  role="button"
                  tabindex="0"
                  onClick={(event) => {
                    event.stopPropagation();
                    void handleToggleExpandCollapseAll();
                  }}
                >
                  {allCommentsExpanded() ? 'Collapse All' : 'Expand All'}
                </span>
              </Show>
            </div>
            <Show when={post().ai_is_flagged}>
              <span class="ai-content-badge">AI Flagged</span>
            </Show>
          </div>
        </div>
      </header>

      <Show when={isEditing()} fallback={
        <div class="post-content-area">
          <div class="post-content-wrapper">
            <div class={`post-content ${contentExpanded() ? 'expanded' : 'clamped'}${(!contentExpanded() && isLongContent()) ? ' has-hover-overlay' : ''}`}>
              <div class="post-content-text">{post().content || 'No content'}</div>
              <Show when={!contentExpanded() && isLongContent()}>
                <div class="post-content-hover-overlay">
                  {post().content || 'No content'}
                </div>
              </Show>
            </div>
            <Show when={isLongContent()}>
              <button
                type="button"
                class="post-content-toggle"
                onClick={(event) => {
                  event.preventDefault();
                  setContentExpanded((next) => !next);
                }}
              >
                {contentExpanded() ? 'Show less' : 'Show more'}
              </button>
            </Show>
            <div class="edit-file-row browse-placeholder" />
          </div>
        </div>
      }>
        <div class="post-content-area">
          <div class="edit-content-wrapper">
            <textarea
              class="edit-textarea"
              value={editContent()}
              onInput={(event) => setEditContent(event.target.value)}
              disabled={editSubmitting()}
              rows={Math.max(1, (post().content || '').split('\n').length)}
            />
            <div class="edit-file-row">
              <button
                type="button"
                class="file-button"
                onClick={() => {
                  const input = document.getElementById(`solid-post-edit-file-${post().id}`);
                  if (input) {
                    input.click();
                  }
                }}
                disabled={editSubmitting()}
              >
                {editAttachment() ? 'Change File' : 'Browse...'}
              </button>
              <input
                id={`solid-post-edit-file-${post().id}`}
                type="file"
                class="file-input"
                accept="image/*"
                onChange={handleEditAttachmentChange}
                disabled={editSubmitting()}
              />
              <Show when={hasAttachment() || editAttachment() || editAttachmentPreview()}>
                <button
                  type="button"
                  class="attachment-remove"
                  onClick={handleClearEditAttachment}
                  disabled={editSubmitting()}
                >
                  {editRemovingAttachment() ? 'Undo remove' : 'Remove image'}
                </button>
              </Show>
            </div>
            <Show when={editError()}>
              <p class="error">{editError()}</p>
            </Show>
            <div class="post-edit-actions">
              <button
                type="button"
                class="post-action submit-button"
                onClick={handleSaveEdit}
                disabled={editSubmitting()}
              >
                {editSubmitting() ? 'Saving…' : 'Save'}
              </button>
              <button type="button" class="post-action" onClick={handleCancelEdit} disabled={editSubmitting()}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      </Show>

      <Show when={isEditing()}>
        <div class="post-image-area">
          <Show when={editAttachmentPreview()}>
            <div class="attachment-preview">
              <img src={editAttachmentPreview()} alt="Updated attachment" />
            </div>
          </Show>
          <Show when={hasAttachment() && !editAttachmentPreview() && !editRemovingAttachment()}>
            <div class="attachment-preview">
              <img src={attachmentSrc() || post().image_url} alt="Current attachment" />
            </div>
          </Show>
          <Show when={editRemovingAttachment()}>
            <div class="attachment-removed">
              Image removed. <button type="button" class="attachment-remove" onClick={handleClearEditAttachment}>Undo</button>
            </div>
          </Show>
        </div>
      </Show>

      <Show when={!isEditing()}>
        <Show when={attachmentSrc()}>
          <div class="post-image">
            <img src={attachmentSrc()} alt="Post image" />
          </div>
        </Show>
        <Show when={hasAttachment() && !attachmentSrc()}>
          <p class="muted">Image failed to load.</p>
        </Show>
      </Show>

      <Show when={actionError()}>
        <p class="error-message">{actionError()}</p>
      </Show>

      <div class="post-actions">
        <div class="post-actions-left">
          <Show when={isEditing()} fallback={
            <Show when={canEdit()}>
              <button type="button" class="post-action edit" onClick={handleStartEdit}>
                Edit
              </button>
              <Show when={isAdmin()}>
                <button type="button" class="post-action delete" onClick={handleDelete}>
                  Delete
                </button>
              </Show>
            </Show>
          }>
            <span />
          </Show>
        </div>
        <div class="post-actions-center">
          <button
            type="button"
            class="post-action like-button"
            classList={{ liked: likedByUser() }}
            onClick={handleLike}
          >
            {likedByUser() ? `Liked (${likeCount()})` : `Like (${likeCount()})`}
          </button>
        </div>
        <div class="post-actions-right">
          <button
            type="button"
            class="post-action comment-button"
            onClick={toggleCommentForm}
          >
            Comment
          </button>
        </div>
      </div>

      <div class="comments-section">
        <div class="comment-form-container">
          <Show when={commentFormVisible()}>
            <form class="comment-form" onSubmit={submitComment}>
              <label htmlFor={`solid-post-comment-${post().id}`} class="sr-only">
                Add a comment
              </label>
              <textarea
                id={`solid-post-comment-${post().id}`}
                rows={2}
                class="comment-input"
                value={commentText()}
                onInput={(event) => setCommentText(event.target.value)}
                disabled={commentSubmitting()}
                placeholder="Write a comment..."
              />
              <button type="submit" class="post-action" disabled={commentSubmitting()}>
                {commentSubmitting() ? 'Posting…' : 'Post comment'}
              </button>
            </form>
          </Show>
          <Show when={commentsError()}>
            <p class="error">{commentsError()}</p>
          </Show>
        </div>
        <div class="comments-list-container">
          <Show when={commentListVisible()}>{renderComments()}</Show>
        </div>
      </div>
    </article>
  );
}
