import van from 'vanjs-core';
const { div, span, button, ul, li, form, a } = van.tags;
import Card from '../common/Card';
import TextInput from '../common/TextInput';
import { isAdminState, getTokenData } from '../../services/auth';
import postsStore from '../../store/posts';
import auth from '../../services/auth';
import LikeButton from './LikeButton';

import AiContentBadge from '../common/AiContentBadge';

// LikeButton is now in a completely separate file for better isolation

/**
 * Single post component with optimized rendering
 */
export default function PostItem({ post }) {
  const attachmentUrl = van.state(postsStore.state.attachmentUrls[post.image_attachment_id] || null);

  // --- Loading Attachment URL ---
  if (post.image_attachment_id && !attachmentUrl.val) {
    postsStore.actions.ensureAttachmentUrl.call(postsStore, post.image_attachment_id)
      .then((url) => {
        attachmentUrl.val = url;
      })
      .catch((err) => {
        console.error('Failed to load attachment:', err);
      });
  }

  // --- General State ---
  const commentInput = van.state('');
  const likeState = van.state(!!post.liked_by_user);
  const likeCount = van.state(Number(post.like_count) || 0);

  // --- Edit Mode State (Inlined from EditPostForm) ---
  const editedContent = van.state(post.content || '');
  const isSubmitting = van.state(false);
  const editError = van.state('');
  const imageFile = van.state(null);
  const imagePreview = van.state(null);
  const removeImage = van.state(false);

  // --- Helpers ---
  const isCurrentUserPost = () => {
    const tokenData = getTokenData();
    return tokenData && tokenData.userId === post.user_id;
  };

  const isEditing = () => {
    return postsStore.state.editingPostId.val === post.id;
  };

  // --- Edit Handlers ---
  const clearSelectedImage = (inputEl) => {
    imageFile.val = null;
    if (imagePreview.val) {
      URL.revokeObjectURL(imagePreview.val);
    }
    imagePreview.val = null;
    if (inputEl) inputEl.value = '';
  };

  const fileInputId = `edit-post-file-${post.id}`;
  const fileInput = van.tags.input({
    id: fileInputId,
    class: 'file-input',
    type: 'file',
    style: "display: none;", // Ensure hidden
    accept: 'image/*',
    onchange: (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) {
        clearSelectedImage(e.target);
        return;
      }
      if (imagePreview.val) {
        URL.revokeObjectURL(imagePreview.val);
      }
      imageFile.val = file;
      imagePreview.val = URL.createObjectURL(file);
      removeImage.val = false;
    }
  });

  const handleStartEdit = () => {
    // Reset edit state when starting
    editedContent.val = post.content || '';
    editError.val = '';
    removeImage.val = false;
    clearSelectedImage(fileInput);
    postsStore.actions.startEditingPost.call(postsStore, post.id);
  };

  const handleCancelEdit = () => {
    // Clean up
    clearSelectedImage(fileInput);
    removeImage.val = false;
    editError.val = '';
    postsStore.actions.cancelEditingPost.call(postsStore);
  };

  const handleSave = async (e) => {
    if (e) e.preventDefault();

    const content = editedContent.val.trim();
    if (!content) {
      editError.val = 'Post content cannot be empty';
      return;
    }

    isSubmitting.val = true;
    editError.val = '';

    try {
      let nextAttachmentId;
      if (imageFile.val) {
        const uploadResult = await postsStore.actions.uploadPostImage.call(postsStore, imageFile.val);
        nextAttachmentId = uploadResult?.attachmentId || null;
      } else if (removeImage.val) {
        nextAttachmentId = null;
      }

      const options = {};
      if (nextAttachmentId !== undefined) {
        options.image_attachment_id = nextAttachmentId;
      }
      // If we are supplying a new attachment or removing one, clear the legacy url field if it existed
      if (imageFile.val || removeImage.val) {
        options.image_url = null;
      }

      await postsStore.actions.updatePost.call(postsStore, post.id, content, options);
      handleCancelEdit(); // Stop editing on success
    } catch (err) {
      console.error('Error updating post:', err);
      editError.val = err.message || 'Failed to update post.';
    } finally {
      isSubmitting.val = false;
    }
  };

  // --- Interaction Handlers ---
  const handleLikeToggle = async (postId) => {
    try {
      const newLikeState = !likeState.val;
      likeState.val = newLikeState;
      likeCount.val = newLikeState ? likeCount.val + 1 : Math.max(0, likeCount.val - 1);
      await postsStore.actions.toggleLike.call(postsStore, postId);
    } catch (error) {
      console.error('Error toggling like:', error);
      likeState.val = !likeState.val; // Revert
      likeCount.val = likeState.val ? likeCount.val + 1 : Math.max(0, likeCount.val - 1);
    }
  };

  const handleDeletePost = (postId) => {
    postsStore.actions.deletePost.call(postsStore, postId);
  };

  const handlePostComment = async (postId) => {
    const content = commentInput.val.trim();
    if (!content) return;

    try {
      await postsStore.actions.createComment.call(postsStore, postId, content);
      commentInput.val = '';
      postsStore.actions.toggleCommentFormVisibility.call(postsStore, postId);
    } catch (error) {
      console.error("Error posting comment:", error);
    }
  };

  const handleShowComments = (postId) => {
    postsStore.actions.toggleCommentListVisibility.call(postsStore, postId);
    if (postsStore.state.commentListVisible.val[postId]) {
      const existingComments = postsStore.state.comments.val[postId];
      const isLoading = postsStore.state.commentLoading.val[postId];
      if (!existingComments && !isLoading) {
        postsStore.actions.fetchComments.call(postsStore, postId)
          .catch(error => console.error('Error fetching comments:', error));
      }
    }
  };

  const handleShowCommentForm = (postId) => {
    postsStore.actions.toggleCommentFormVisibility.call(postsStore, postId);
  };

  const handleToggleExpandCollapseAll = (postId) => {
    postsStore.actions.toggleExpandCollapseAll.call(postsStore, postId);
  };

  // --- Comment Selection Helpers ---
  const getCommentListVisible = (postId) => postsStore.state.commentListVisible.val[postId] || false;
  const getCommentFormVisible = (postId) => postsStore.state.commentFormVisible.val[postId] || false;
  const getCommentLoading = (postId) => postsStore.state.commentLoading.val[postId] || false;
  const getComments = (postId) => postsStore.state.comments.val[postId] || [];

  const commentsListContent = (postId) => {
    if (!getCommentListVisible(postId)) return null;
    const currentComments = getComments(postId);
    const isLoading = getCommentLoading(postId);

    if (isLoading && !currentComments.length) return span("Loading comments...");
    if (currentComments.length > 0) {
      const commentsList = ul({ class: "comments-list" });
      currentComments.forEach(comment => van.add(commentsList, PostItem({ post: comment })));
      return commentsList;
    } else if (!isLoading) {
      return span({ class: "no-comments-yet" }, "No comments yet.");
    }
    return null;
  };

  const commentFormContent = (postId) => {
    if (!getCommentFormVisible(postId)) return null;
    return form({
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
  };

  // --- Render ---
  return Card({
    className: "post-card",
    children: [
      // 1. Header (Static)
      div({ class: "post-header" }, [
        div({ class: "post-author" }, [
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
        div({ class: "post-meta" }, [
          span({ class: "post-header-likes" }, `${post.like_count || 0} like${(post.like_count === 1) ? '' : 's'}`),
          span({ 
            class: "post-header-comments",
            style: "cursor: pointer;",
            onclick: () => handleShowComments(post.id)
          }, `${post.comment_count || 0} comment${(post.comment_count === 1) ? '' : 's'}`),
          div({ class: "post-header-expand-wrap" },
            () => {
              if (!(post.comment_count > 0)) return null;
              const isExpanded = postsStore.state.allCommentsExpanded.val[post.id] || false;
              return span({
                class: "post-header-expand",
                style: "cursor: pointer;",
                onclick: (e) => {
                  e.stopPropagation();
                  handleToggleExpandCollapseAll(post.id);
                }
              }, isExpanded ? "Collapse All" : "Expand All");
            }
          ),
          div({ class: "post-date" }, new Date(post.created_at).toLocaleDateString()),
          AiContentBadge({
            aiProbability: post.ai_probability,
            aiFlagged: post.ai_is_flagged,
            detectedModel: post.ai_detected_model
          })
        ])
      ]),

      // 2. Error Message (Edit Mode)
      () => (isEditing() && editError.val) ? div({ class: "error-message" }, editError.val) : null,

      // 3. Content Area (Toggle)
      div({ class: "post-content-area" },
        () => {
          if (isEditing()) {
            // Edit Mode: Textarea + Browse button (like Create Post)
            // Use initial post.content for rows to avoid re-creating textarea on every keystroke
            const initialLineCount = (post.content || '').split('\n').length;
            return div({ class: "edit-content-wrapper" }, [
              van.tags.textarea({
                class: "edit-textarea",
                style: "width: 100%; resize: none; overflow-y: hidden; box-sizing: border-box; min-height: 0;",
                rows: Math.max(1, initialLineCount),
                disabled: isSubmitting,
                value: editedContent,
                oninput: (e) => {
                  editedContent.val = e.target.value;
                  // Auto-resize logic to keep it perfectly tight
                  e.target.style.height = 'auto';
                  e.target.style.height = (e.target.scrollHeight + 2) + 'px'; // +2 for borders (box-sizing: border-box)
                },
                created: (el) => {
                  if (!el) return;
                  // Ensure height is correct on mount
                  setTimeout(() => {
                    if (!el?.style) return;
                    el.style.height = 'auto';
                    el.style.height = (el.scrollHeight + 2) + 'px'; // +2 for borders
                  }, 0);
                }
              }),
              // Browse button under textarea (like Create Post)
              div({ class: "edit-file-row" }, [
                button({
                  type: 'button',
                  class: 'file-button',
                  onclick: () => fileInput.click(),
                  disabled: isSubmitting
                }, "Browse..."),
                fileInput
              ])
            ]);
          } else {
            // View Mode: Text + hidden Browse row to reserve space
            const content = String(post.content || '');
            const isExpanded = () => !!postsStore.state.expandedContent.val[post.id];
            const isHoverExpanded = () => !!postsStore.state.hoverExpandedContent.val[post.id];
            // Heuristic: show a toggle when content is likely to exceed the clamped preview.
            const isLong = content.length > 240 || content.split('\n').length > 6;
            const canHoverExpand = () => {
              try {
                // Prefer a touch capability check over matchMedia hover/pointer, which is not
                // consistently reported across browsers and automation environments.
                if (navigator.maxTouchPoints && navigator.maxTouchPoints > 0) return false;
                if ('ontouchstart' in window) return false;
                return true;
              } catch {
                return false;
              }
            };

            const startHoverTimer = () => {
              if (!canHoverExpand()) return;
              if (isExpanded()) return;
              if (isHoverExpanded()) return;
              if (!isLong) return;
              postsStore.actions.startHoverExpandTimer.call(postsStore, post.id);
            };

            const clearHoverTimer = () => {
              postsStore.actions.clearHoverExpand.call(postsStore, post.id);
            };

            return div({ class: "post-content-wrapper" }, [
              div({
                class: () => `post-content ${isExpanded() ? 'expanded' : 'clamped'}${(!isExpanded() && isHoverExpanded()) ? ' hover-expanded' : ''}`,
                // Delayed hover expansion should be tied to the content area itself.
                onmouseover: (e) => {
                  if (e?.currentTarget && e?.relatedTarget && e.currentTarget.contains(e.relatedTarget)) return;
                  startHoverTimer();
                },
                onmouseout: (e) => {
                  if (e?.currentTarget && e?.relatedTarget && e.currentTarget.contains(e.relatedTarget)) return;
                  const target = e?.currentTarget;
                  setTimeout(() => {
                    if (target?.matches && target.matches(':hover')) return;
                    // If virtualization swapped DOM nodes during scroll, the pointer can still
                    // be over the *new* content element for this same post. In that case, do not
                    // collapse the hover-expansion.
                    const hoveredContent = document.querySelector('.post-content:hover');
                    const hoveredItem = hoveredContent?.closest ? hoveredContent.closest('.post-virtual-item') : null;
                    const hoveredId = hoveredItem ? Number(hoveredItem.dataset.postId) : null;
                    if (hoveredId === post.id) return;
                    clearHoverTimer();
                  }, 80);
                }
              }, div({ class: 'post-content-text' }, content)),
              // Hide the toggle while hover-expanded (ephemeral). It re-appears once the hover expansion collapses.
              () => (isLong && !isHoverExpanded()) ? button({
                type: 'button',
                class: 'post-content-toggle',
                onclick: (e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  clearHoverTimer();
                  postsStore.actions.toggleExpandedContent.call(postsStore, post.id);
                }
              }, () => isExpanded() ? 'Show less' : 'Show more') : null,
              div({ class: "edit-file-row browse-placeholder" })
            ]);
          }
        }
      ),

      // 4. Image Area (Toggle)
      div({ class: "post-image-area" },
        () => {
          if (isEditing()) {
            // Edit Mode: Previews
            if (imagePreview.val) {
              return div({ class: "attachment-preview" }, [
                van.tags.img({ src: imagePreview.val, alt: "New upload" }),
                button({ type: 'button', class: 'attachment-remove', onclick: () => clearSelectedImage(fileInput) }, "Remove")
              ]);
            }
            if ((attachmentUrl.val || post.image_url) && !removeImage.val) {
              return div({ class: "attachment-preview" }, [
                van.tags.img({ src: attachmentUrl.val || post.image_url, alt: "Current" }),
                button({ type: 'button', class: 'attachment-remove', onclick: () => { removeImage.val = true; } }, "Remove")
              ]);
            }
            if (removeImage.val) {
              return div({ class: "attachment-removed" }, [
                div("Image removed. "),
                button({ type: 'button', class: 'attachment-remove', onclick: () => { removeImage.val = false; } }, "Undo")
              ]);
            }
            return null;
          } else {
            // View Mode
            return (post.image_attachment_id || post.image_url) ? div({ class: "post-image" },
              van.tags.img({ src: () => attachmentUrl.val || post.image_url, alt: "Post image" })
            ) : null;
          }
        }
      ),

      // 5. Actions (Toggle Edit Options)
      div({ class: "post-actions" }, [
        // Always show these
        LikeButton({ postId: post.id }),
        button({ class: "post-action comment-button", onclick: () => handleShowCommentForm(post.id) }, "Comment"),

        // Toggle Edit Controls
        () => isEditing() ? span({ style: "display: contents;" }, [
          // Edit Controls: Save, Cancel (Browse moved to content area)
          button({
            class: "post-action submit-button",
            onclick: handleSave,
            disabled: isSubmitting
          }, isSubmitting.val ? "Saving..." : "Save"),

          button({
            class: "post-action cancel-button",
            onclick: handleCancelEdit,
            disabled: isSubmitting
          }, "Cancel")
        ]) : span({ style: "display: contents;" }, [
          // View Controls: Edit, Delete
          isCurrentUserPost() ?
            button({ class: "post-action edit", onclick: handleStartEdit }, "Edit") : null,
          isAdminState.val ?
            button({ class: "post-action delete", onclick: () => handleDeletePost(post.id) }, "🗑️ Delete") : null
        ])
      ]),

      // 7. Comments List and Form
      van.derive(() => div({ class: "comments-section" }, [
        div({ class: "comment-form-container" }, commentFormContent(post.id)),
        div({ class: "comments-list-container" }, commentsListContent(post.id))
      ])),
    ],
  });
}
