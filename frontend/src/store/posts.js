import van from 'vanjs-core';
import api from '../services/api';
import { isLoggedInState } from '../services/tokenService';
import * as vanX from 'vanjs-ext';

const postsStore = {
  // List of change listeners
  _listeners: [],
  
  // Add change listener function
  onStateChange(listener) {
    this._listeners.push(listener);
    return () => {
      this._listeners = this._listeners.filter(l => l !== listener);
    };
  },
  
  // Notify all listeners of a state change
  _notifyListeners() {
    this._listeners.forEach(listener => listener());
  },
  state: {
    posts: van.state([]),
    loading: van.state(false),
    loadingMore: van.state(false),
    error: van.state(null),
    nextCursor: van.state(null),
    hasMore: van.state(true),
    searchScope: van.state('following'),
    searchQuery: van.state(''),
    // Tracks whether we're showing real API data or a logged-out placeholder feed.
    feedMode: van.state('unknown'),
    // Persist per-post UI state across virtualization re-mounts.
    expandedContent: van.state({}),
    // Use reactive object to manage individual like statuses
    likeStatus: vanX.reactive({}),
    attachmentUrls: vanX.reactive({}),
    comments: van.state({}),      // Store comments by postId
    commentLoading: van.state({}), // Track loading state by postId
    commentListVisible: van.state({}), // Track comment list visibility by postId
    commentFormVisible: van.state({}), // Track comment form visibility by postId
    allCommentsExpanded: van.state({}), // Track if expand all is active for a post ID
    initialFetchAttempted: van.state(false), // Track if initial fetch has been attempted
    editingPostId: van.state(null) // Track which post is being edited
  },
  
  actions: {
    toggleExpandedContent(postId) {
      const cur = !!this.state.expandedContent.val[postId];
      this.state.expandedContent.val = {
        ...this.state.expandedContent.val,
        [postId]: !cur
      };
    },

    /**
     * Toggle comment list visibility for a post
     * @param {number} postId - Post ID
     */
    toggleCommentListVisibility(postId) {
      const currentStatus = this.state.commentListVisible.val[postId] || false;
      this.state.commentListVisible.val = {
        ...this.state.commentListVisible.val,
        [postId]: !currentStatus
      };
      // No longer hiding comment form when list is shown
      // This allows both the comment list and form to be visible at the same time
    },

    /**
     * Toggle comment form visibility for a post
     * @param {number} postId - Post ID
     */
    toggleCommentFormVisibility(postId) {
      const currentStatus = this.state.commentFormVisible.val[postId] || false;
      this.state.commentFormVisible.val = {
        ...this.state.commentFormVisible.val,
        [postId]: !currentStatus
      };
      // Comment list visibility is no longer affected when toggling the form
    },

    /**
     * Fetch all posts
     * @returns {Promise<Array>} Posts
     */
    async fetchPosts({ reset = true, scope, q = '' } = {}) {
      const requestedScope = isLoggedInState.val
        ? ((scope || this.state.searchScope.val || 'following'))
        : 'global';
      const normalizedScope = requestedScope === 'following' || requestedScope === 'seen' ? requestedScope : 'global';
      const query = String(q || '').trim();

      this.state.initialFetchAttempted.val = true; // Mark that an attempt to fetch is being made
      if (this.state.loading.val) return this.state.posts.val;
      try {
        this.state.loading.val = true;
        this.state.error.val = null;
        if (reset) {
          this.state.nextCursor.val = null;
          this.state.hasMore.val = true;
        }
        this.state.searchScope.val = normalizedScope;
        this.state.searchQuery.val = query;

        const page = normalizedScope === 'following'
          ? await api.posts.getFeedPage({ cursor: null, limit: 20, q: query })
          : await api.posts.getPage({
              cursor: null,
              limit: 20,
              ...(normalizedScope === 'global' ? {} : { scope: normalizedScope }),
              q: query
            });

        const items = Array.isArray(page?.items) ? page.items : [];
        this.state.posts.val = items;
        this.state.nextCursor.val = page?.nextCursor ?? null;
        this.state.hasMore.val = !!page?.hasMore;
        this.state.feedMode.val = isLoggedInState.val ? 'real' : 'public';

        // Initialize reactive like statuses for posts
        const statuses = {};
        this.state.posts.val.forEach(post => {
          if (post.liked_by_user !== undefined) statuses[post.id] = post.liked_by_user;
        });
        Object.assign(this.state.likeStatus, statuses);

        return this.state.posts.val;
      } catch (error) {
        console.error('Error fetching posts:', error);
        this.state.error.val = error.message;
        if (!isLoggedInState.val && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')) {
          this.actions.loadMockPosts.call(this);
        }
        return [];
      } finally {
        this.state.loading.val = false;
      }
    },

    async fetchMorePosts() {
      if (this.state.loadingMore.val || this.state.loading.val) return [];
      if (!this.state.hasMore.val) return [];
      if (!isLoggedInState.val && this.state.feedMode.val === 'mock') return [];

      try {
        this.state.loadingMore.val = true;
        this.state.error.val = null;
        const scope = isLoggedInState.val
          ? (this.state.searchScope.val === 'seen'
            ? 'seen'
            : (this.state.searchScope.val === 'global' ? 'global' : 'following'))
          : 'global';
        const query = String(this.state.searchQuery.val || '').trim();

        const page = scope === 'following'
          ? await api.posts.getFeedPage({ cursor: this.state.nextCursor.val, limit: 20, q: query })
          : await api.posts.getPage({
              cursor: this.state.nextCursor.val,
              limit: 20,
              ...(scope === 'global' ? {} : { scope }),
              q: query
            });

        const items = Array.isArray(page?.items) ? page.items : [];
        if (items.length === 0) {
          this.state.hasMore.val = false;
          this.state.nextCursor.val = null;
          return [];
        }

        // Dedup by id in case of retries/races.
        const seen = new Set(this.state.posts.val.map(p => p.id));
        const merged = [...this.state.posts.val];
        for (const p of items) {
          if (!seen.has(p.id)) merged.push(p);
        }
        this.state.posts.val = merged;
        this.state.nextCursor.val = page?.nextCursor ?? null;
        this.state.hasMore.val = !!page?.hasMore;
        this.state.feedMode.val = isLoggedInState.val ? 'real' : 'public';

        // Like status init for new posts
        const statuses = {};
        items.forEach(post => {
          if (post.liked_by_user !== undefined) statuses[post.id] = post.liked_by_user;
        });
        Object.assign(this.state.likeStatus, statuses);

        return items;
      } catch (error) {
        console.error('Error fetching more posts:', error);
        this.state.error.val = error.message;
        return [];
      } finally {
        this.state.loadingMore.val = false;
      }
    },

    setSearchScope(scope) {
      const requestedScope = scope === 'seen' || scope === 'global' || scope === 'following'
        ? scope
        : 'following';
      const normalizedScope = isLoggedInState.val ? requestedScope : 'global';
      this.state.searchScope.val = normalizedScope;
      if (!isLoggedInState.val) {
        this.state.searchQuery.val = '';
      }
    },

    setSearchQuery(query) {
      this.state.searchQuery.val = String(query || '').trim();
    },

    loadMockPosts() {
      this.state.posts.val = [
        { id: 1, title: "First Post", content: "This is the first post content.", username: "user1", created_at: new Date().toISOString() },
        { id: 2, title: "Second Post", content: "This is the second post with more content.", username: "user2", created_at: new Date(Date.now() - 86400000).toISOString() }
      ];
      this.state.hasMore.val = false;
      this.state.nextCursor.val = null;
      this.state.loading.val = false;
      this.state.feedMode.val = 'mock';
      return this.state.posts.val;
    },

    async createPost(content, image_attachment_id = null, image_url = null) {
      try {
        this.state.loading.val = true;
        this.state.error.val = null;
        if (!content || typeof content !== 'string' || content.trim() === '') {
          throw new Error('Post content cannot be empty');
        }
        try {
          const post = await api.posts.create(content, image_attachment_id, image_url);
          const updatedPosts = [post, ...this.state.posts.val];
          this.state.posts.val = updatedPosts;
          return post;
        } catch (apiError) {
          console.error('API Error details:', apiError);
          const errorMessage = apiError.response?.message || apiError.message || 'Server error: Could not create post';
          throw new Error(errorMessage);
        }
      } catch (error) {
        console.error('Error creating post:', error);
        this.state.error.val = error.message;
        throw error;
      } finally {
        this.state.loading.val = false;
      }
    },

    async uploadPostImage(file) {
      try {
        this.state.error.val = null;
        if (!file) {
          throw new Error('No file selected');
        }
        const result = await api.attachments.uploadPost(file);
        return result;
      } catch (error) {
        console.error('Error uploading image:', error);
        this.state.error.val = error.message;
        throw error;
      }
    },

    async ensureAttachmentUrl(attachmentId) {
      if (!attachmentId) return null;
      if (this.state.attachmentUrls[attachmentId]) {
        return this.state.attachmentUrls[attachmentId];
      }
      if (!this._attachmentUrlPromises) this._attachmentUrlPromises = {};
      if (this._attachmentUrlPromises[attachmentId]) {
        return this._attachmentUrlPromises[attachmentId];
      }

      this._attachmentUrlPromises[attachmentId] = api.attachments.download(attachmentId)
        .then(blob => {
          const url = URL.createObjectURL(blob);
          this.state.attachmentUrls[attachmentId] = url;
          return url;
        })
        .finally(() => {
          delete this._attachmentUrlPromises[attachmentId];
        });

      return this._attachmentUrlPromises[attachmentId];
    },

    async deletePost(postId) {
      try {
        if (!isLoggedInState.val) return false;
        await api.posts.delete(postId);
        this.state.posts.val = this.state.posts.val.filter(post => post.id !== postId);
        return true;
      } catch (error) {
        console.error('Error deleting post:', error);
        return false;
      }
    },

    async toggleLike(itemId) {
      console.log(`[Store Action] toggleLike called for itemId: ${itemId}`);
      if (!isLoggedInState.val) {
        console.log('[Store Action] User not logged in.');
        return false;
      }
      const current = this.state.likeStatus[itemId] || false;
      this.state.likeStatus[itemId] = !current;  // optimistic status toggle
      console.log(`[Store Action] likeStatus toggled for itemId ${itemId}: ${current} -> ${this.state.likeStatus[itemId]}`);
      console.log('[Store Action] Current likeStatus map:', this.state.likeStatus);
      // Update like_count on post
      const idx = this.state.posts.val.findIndex(p => p.id === itemId);
      let originalCount;
      if (idx !== -1) {
        originalCount = this.state.posts.val[idx].like_count || 0;
        const newCount = !current ? originalCount + 1 : Math.max(0, originalCount - 1);
        const updatedPost = { ...this.state.posts.val[idx], like_count: newCount, liked_by_user: !current };
        const newArr = [...this.state.posts.val]; newArr[idx] = updatedPost;
        this.state.posts.val = newArr;
        console.log(`[Store Action] post ${itemId} like_count updated: ${originalCount} -> ${newCount}`);
      }
      try {
        if (!current) await api.posts.likePost(itemId);
        else await api.posts.unlikePost(itemId);
        return true;
      } catch (err) {
        console.error('[Store Action] toggleLike API error:', err);
        console.log(`[Store Action] Reverting likeStatus for itemId ${itemId} back to ${current}`);
        console.log('[Store Action] Current likeStatus map after revert:', this.state.likeStatus);
        // revert
        this.state.likeStatus[itemId] = current;
        if (idx !== -1) {
          const reverted = { ...this.state.posts.val[idx], like_count: originalCount, liked_by_user: current };
          const revertArr = [...this.state.posts.val]; revertArr[idx] = reverted;
          this.state.posts.val = revertArr;
        }
        return false;
      }
    },

    async checkLikeStatus(postId) {
      try {
        if (!isLoggedInState.val || !postId) return;
        if (this.state.likeStatus[postId] !== undefined) return;
        const resp = await api.posts.getLikeStatus(postId);
        const isLiked = resp.isLiked !== undefined ? resp.isLiked : (resp.liked || false);
        this.state.likeStatus[postId] = isLiked;
        return isLiked;
      } catch (error) {
        console.error('[Store Action] checkLikeStatus error:', error);
        return false;
      }
    },

    async fetchComments(postId) {
      try {
        if (!postId) return [];
        this.state.commentLoading.val = { ...this.state.commentLoading.val, [postId]: true };
        const comments = await api.posts.getComments(postId);
        this.state.comments.val = { ...this.state.comments.val, [postId]: comments };

        // Initialize likeStatus for fetched comments
        if (Array.isArray(comments)) {
          comments.forEach(comment => {
            // Set reactive like status for each comment
            this.state.likeStatus[comment.id] = comment.liked_by_user !== undefined ? comment.liked_by_user : false;
          });
        }
        return comments;
      } catch (error) {
        console.error('Error fetching comments:', error);
        return [];
      } finally {
        this.state.commentLoading.val = { ...this.state.commentLoading.val, [postId]: false };
      }
    },

    async createComment(parentId, content) {
      try {
        if (!isLoggedInState.val) throw new Error('You must be logged in to comment');
        if (!content || content.trim() === '') throw new Error('Comment cannot be empty');
        const newComment = await api.posts.createComment(parentId, content);
        let parentUpdated = false;
        const postIndex = this.state.posts.val.findIndex(p => p.id === parentId);
        if (postIndex !== -1) {
          const parentPost = this.state.posts.val[postIndex];
          const updatedParentPost = { ...parentPost, comment_count: (parentPost.comment_count || 0) + 1 };
          const newPosts = [...this.state.posts.val];
          newPosts[postIndex] = updatedParentPost;
          this.state.posts.val = newPosts;
          parentUpdated = true;
        } else {
          for (const parentListId in this.state.comments.val) {
            const commentsList = this.state.comments.val[parentListId];
            const parentCommentIndex = commentsList.findIndex(c => c.id === parentId);
            if (parentCommentIndex !== -1) {
              const parentComment = commentsList[parentCommentIndex];
              const updatedParentComment = { ...parentComment, comment_count: (parentComment.comment_count || 0) + 1 };
              const newCommentList = [...commentsList];
              newCommentList[parentCommentIndex] = updatedParentComment;
              this.state.comments.val = { ...this.state.comments.val, [parentListId]: newCommentList };
              parentUpdated = true;
              break;
            }
          }
        }
        if (!parentUpdated) {
          console.warn(`Parent item with ID ${parentId} not found in state.posts or state.comments cache. Count not updated dynamically.`);
        }
        const existingComments = this.state.comments.val[parentId] || [];
        this.state.comments.val = {
          ...this.state.comments.val,
          [parentId]: [newComment, ...existingComments] // Add to the beginning
        };

        // Initialize like status for the new comment
        this.state.likeStatus[newComment.id] = newComment.liked_by_user !== undefined ? newComment.liked_by_user : false;
        return newComment;
      } catch (error) {
        console.error('Error creating comment:', error);
        throw error;
      }
    },

    async deleteComment(commentId, postId) {
      try {
        if (!isLoggedInState.val) return false;
        await api.posts.deleteComment(commentId);
        if (this.state.comments.val[postId]) {
          const updatedComments = this.state.comments.val[postId].filter(comment => comment.id !== commentId);
          this.state.comments.val = { ...this.state.comments.val, [postId]: updatedComments };
        }
        const postIndex = this.state.posts.val.findIndex(post => post.id === postId);
        if (postIndex !== -1) {
          const post = this.state.posts.val[postIndex];
          const updatedPost = { ...post, comment_count: Math.max(0, (post.comment_count || 1) - 1) };
          const newPosts = [...this.state.posts.val];
          newPosts[postIndex] = updatedPost;
          this.state.posts.val = newPosts;
        }
        return true;
      } catch (error) {
        console.error('Error deleting comment:', error);
        return false;
      }
    },

    // --- Expand/Collapse All Actions ---

    /**
     * Toggles the expansion state of all comments for a post.
     * @param {number} parentId - The ID of the top-level post.
     */
    toggleExpandCollapseAll(parentId) {
      const isCurrentlyExpanded = this.state.allCommentsExpanded.val[parentId] || false;
      if (isCurrentlyExpanded) {
        this.actions.collapseAllComments.call(this, parentId);
      } else {
        this.actions.expandAllComments.call(this, parentId);
      }
    },

    /**
     * Recursively fetch and expand all comments starting from a given post/comment ID.
     * @param {number} parentId - The ID of the post or comment to start expanding from.
     * @private
     */
    async expandAllComments(parentId) {
      const fetchAndExpand = async (id) => {
        this.state.commentListVisible.val = { ...this.state.commentListVisible.val, [id]: true };
        // Mark this id as fully expanded
        this.state.allCommentsExpanded.val = { ...this.state.allCommentsExpanded.val, [id]: true };
        const alreadyLoaded = this.state.comments.val[id];
        const isLoading = this.state.commentLoading.val[id];
        let commentsToProcess = [];
        if (!alreadyLoaded && !isLoading) {
          try {
            this.state.commentLoading.val = { ...this.state.commentLoading.val, [id]: true };
            const fetchedComments = await api.posts.getComments(id);
            this.state.comments.val = { ...this.state.comments.val, [id]: fetchedComments };
            commentsToProcess = fetchedComments;
          } catch (error) {
            console.error(`Error fetching comments for ${id}:`, error);
          } finally {
            this.state.commentLoading.val = { ...this.state.commentLoading.val, [id]: false };
          }
        } else if (alreadyLoaded) {
          commentsToProcess = alreadyLoaded;
        }
        if (commentsToProcess && commentsToProcess.length > 0) {
          for (const comment of commentsToProcess) {
            if (comment.comment_count > 0) {
              await fetchAndExpand(comment.id);
            } else {
              this.state.commentListVisible.val = { ...this.state.commentListVisible.val, [comment.id]: true };
            }
          }
        }
      }; // End fetchAndExpand helper

      try {
        await fetchAndExpand(parentId);
        this.state.allCommentsExpanded.val = { ...this.state.allCommentsExpanded.val, [parentId]: true };
      } catch (error) {
        console.error(`Error during expandAllComments for ${parentId}:`, error);
      }
    },

    /**
     * Recursively collapse all comments starting from a given post/comment ID.
     * @param {number} parentId - The ID of the post or comment to start collapsing from.
     * @private
     */
    collapseAllComments(parentId) {
      const collapseRecursive = (id) => {
        this.state.commentListVisible.val = { ...this.state.commentListVisible.val, [id]: false };
        // Mark this id as not fully expanded
        this.state.allCommentsExpanded.val = { ...this.state.allCommentsExpanded.val, [id]: false };
        const cachedChildren = this.state.comments.val[id];
        if (cachedChildren && cachedChildren.length > 0) {
          for (const comment of cachedChildren) {
            // Only collapse if it's currently marked as visible (or potentially visible)
            // Avoids unnecessary state updates if already collapsed
             if (this.state.commentListVisible.val[comment.id] !== false) {
               collapseRecursive(comment.id);
             }
          }
        }
      }; // End collapseRecursive helper

      try {
        collapseRecursive(parentId);
        // Parent collapse recorded in recursive call
      } catch (error) {
        console.error(`Error during collapseAllComments for ${parentId}:`, error);
      }
    }, // End collapseAllComments

    // --- Edit Post Actions ---

    /**
     * Start editing a post
     * @param {number} postId - The ID of the post to edit
     */
    startEditingPost(postId) {
      this.state.editingPostId.val = postId;
    },

    /**
     * Cancel editing a post
     */
    cancelEditingPost() {
      this.state.editingPostId.val = null;
    },

    /**
     * Update an existing post
     * @param {number} postId - The ID of the post to update
     * @param {string} content - The new content for the post
     * @param {Object} options - Optional update fields
     * @param {number|null} options.image_attachment_id - New attachment id or null to remove
     * @param {string|null} options.image_url - The new image URL (optional)
     * @returns {Promise<Object>} Updated post
     */
    async updatePost(postId, content, options = {}) {
      try {
        if (!isLoggedInState.val) {
          throw new Error('You must be logged in to edit posts');
        }

        if (!content || content.trim() === '') {
          throw new Error('Post content cannot be empty');
        }

        this.state.loading.val = true;
        this.state.error.val = null;

        const hasImageAttachmentId = Object.prototype.hasOwnProperty.call(options, 'image_attachment_id');
        const hasImageUrl = Object.prototype.hasOwnProperty.call(options, 'image_url');

        // Find the post in the current state for optimistic update
        const postIndex = this.state.posts.val.findIndex(post => post.id === postId);
        let originalPost = null;

        if (postIndex !== -1) {
          originalPost = { ...this.state.posts.val[postIndex] };
          
          // Optimistic update
          const optimisticPost = {
            ...originalPost,
            content: content.trim(),
            updated_at: new Date().toISOString()
          };
          if (hasImageUrl) {
            optimisticPost.image_url = options.image_url;
          }
          if (hasImageAttachmentId) {
            optimisticPost.image_attachment_id = options.image_attachment_id;
            if (originalPost.image_attachment_id && originalPost.image_attachment_id !== options.image_attachment_id) {
              delete this.state.attachmentUrls[originalPost.image_attachment_id];
            }
          }

          const newPosts = [...this.state.posts.val];
          newPosts[postIndex] = optimisticPost;
          this.state.posts.val = newPosts;
        }

        try {
          // Make API call
          const updatedPost = await api.posts.update(postId, content.trim(), options);
          
          // Update with actual server response
          if (postIndex !== -1) {
            const newPosts = [...this.state.posts.val];
            newPosts[postIndex] = updatedPost;
            this.state.posts.val = newPosts;
          }

          // Clear editing state
          this.state.editingPostId.val = null;

          return updatedPost;
        } catch (apiError) {
          // Revert optimistic update on error
          if (postIndex !== -1 && originalPost) {
            const newPosts = [...this.state.posts.val];
            newPosts[postIndex] = originalPost;
            this.state.posts.val = newPosts;
          }

          console.error('API Error updating post:', apiError);
          const errorMessage = apiError.response?.message || apiError.message || 'Failed to update post';
          throw new Error(errorMessage);
        }
      } catch (error) {
        console.error('Error updating post:', error);
        this.state.error.val = error.message;
        throw error;
      } finally {
        this.state.loading.val = false;
      }
    },

    reset() {
      this.state.posts.val = [];
      this.state.loading.val = false;
      this.state.error.val = null;
      this.state.comments.val = {};
      this.state.commentLoading.val = {};
      this.state.commentListVisible.val = {};
      this.state.commentFormVisible.val = {};
      this.state.allCommentsExpanded.val = {};
      this.state.initialFetchAttempted.val = false;
      this.state.editingPostId.val = null;
    }
  } // End actions
};

// If we rendered a logged-out placeholder feed, refresh to the real API feed
// as soon as the user logs in. This prevents the mock feed from "sticking".
van.derive(() => {
  if (!isLoggedInState.val) return;
  if (postsStore.state.feedMode.val !== 'mock') return;
  // Avoid starting a second request if something else already triggered a fetch.
  if (postsStore.state.loading.val || postsStore.state.loadingMore.val) return;
  postsStore.actions.fetchPosts.call(postsStore, { reset: true });
});

export default postsStore;
