import van from 'vanjs-core';
import api from '../services/api';
import auth from '../services/auth';

const postsStore = {
  state: {
    posts: van.state([]),
    loading: van.state(false),
    error: van.state(null),
    likeStatus: van.state({}),
    comments: van.state({}),      // Store comments by postId
    commentLoading: van.state({}), // Track loading state by postId
    commentListVisible: van.state({}), // Track comment list visibility by postId
    commentFormVisible: van.state({}), // Track comment form visibility by postId
    allCommentsExpanded: van.state({}) // Track if expand all is active for a post ID
  },
  
  actions: {
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
    async fetchPosts() {
      try {
        this.state.loading.val = true;
        this.state.error.val = null;
        if (!auth.isLoggedInState.val) {
          return this.actions.loadMockPosts.call(this);
        }
        const posts = await api.posts.getAll();
        this.state.posts.val = Array.isArray(posts) ? posts : [];
        if (auth.isLoggedInState.val && this.state.posts.val.length > 0) {
          const newLikeStatus = {...this.state.likeStatus.val};
          this.state.posts.val.forEach(post => {
            if (post.liked_by_user !== undefined) {
              newLikeStatus[post.id] = post.liked_by_user;
            }
          });
          this.state.likeStatus.val = newLikeStatus;
        }
        return this.state.posts.val;
      } catch (error) {
        console.error('Error fetching posts:', error);
        this.state.error.val = error.message;
        if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
          this.actions.loadMockPosts.call(this);
        }
        return [];
      } finally {
        this.state.loading.val = false;
      }
    },

    loadMockPosts() {
      this.state.posts.val = [
        { id: 1, title: "First Post", content: "This is the first post content.", username: "user1", created_at: new Date().toISOString() },
        { id: 2, title: "Second Post", content: "This is the second post with more content.", username: "user2", created_at: new Date(Date.now() - 86400000).toISOString() }
      ];
      this.state.loading.val = false;
      return this.state.posts.val;
    },

    async createPost(content, image_url = null) {
      try {
        this.state.loading.val = true;
        this.state.error.val = null;
        if (!content || typeof content !== 'string' || content.trim() === '') {
          throw new Error('Post content cannot be empty');
        }
        try {
          const post = await api.posts.create(content, image_url);
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

    async deletePost(postId) {
      try {
        if (!auth.isLoggedInState.val) return false;
        await api.posts.delete(postId);
        this.state.posts.val = this.state.posts.val.filter(post => post.id !== postId);
        return true;
      } catch (error) {
        console.error('Error deleting post:', error);
        return false;
      }
    },

    async toggleLike(postId) {
      try {
        if (!auth.isLoggedInState.val) return false;
        const postIndex = this.state.posts.val.findIndex(post => post.id === postId);
        if (postIndex === -1) return false;
        const post = this.state.posts.val[postIndex];
        const currentStatus = this.state.likeStatus.val[postId] || false;
        const updatedPost = { ...post, like_count: currentStatus ? Math.max(0, post.like_count - 1) : post.like_count + 1 };
        const newPosts = [...this.state.posts.val];
        newPosts[postIndex] = updatedPost;
        this.state.posts.val = newPosts;
        this.state.likeStatus.val = { ...this.state.likeStatus.val, [postId]: !currentStatus };
        try {
          if (currentStatus) {
            await api.posts.unlikePost(postId);
          } else {
            await api.posts.likePost(postId);
          }
          return true;
        } catch (error) {
          console.error('Error toggling like:', error);
          newPosts[postIndex] = post; // Revert
          this.state.posts.val = newPosts;
          this.state.likeStatus.val = { ...this.state.likeStatus.val, [postId]: currentStatus };
          return false;
        }
      } catch (error) {
        console.error('Error in toggle like:', error);
        return false;
      }
    },

    async checkLikeStatus(postId) {
      try {
        if (!auth.isLoggedInState.val || !postId) return;
        if (this.state.likeStatus.val[postId] !== undefined) return;
        const response = await api.posts.getLikeStatus(postId);
        const isLiked = response.isLiked !== undefined ? response.isLiked : (response.liked || false);
        this.state.likeStatus.val = { ...this.state.likeStatus.val, [postId]: isLiked };
        return isLiked;
      } catch (error) {
        console.error('Error checking like status:', error);
        return false;
      }
    },

    async fetchComments(postId) {
      try {
        if (!postId) return [];
        this.state.commentLoading.val = { ...this.state.commentLoading.val, [postId]: true };
        const comments = await api.posts.getComments(postId);
        this.state.comments.val = { ...this.state.comments.val, [postId]: comments };
        return comments;
      } catch (error) {
        console.error('Error fetching comments:', error);
        return [];
      } finally {
        this.state.commentLoading.val = { ...this.state.commentLoading.val, [postId]: false };
      }
    },

    async createComment(postId, content) {
      try {
        if (!auth.isLoggedInState.val) throw new Error('You must be logged in to comment');
        if (!content || content.trim() === '') throw new Error('Comment cannot be empty');
        const comment = await api.posts.createComment(postId, content);
        let parentUpdated = false;
        const postIndex = this.state.posts.val.findIndex(p => p.id === postId);
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
            const parentCommentIndex = commentsList.findIndex(c => c.id === postId);
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
          console.warn(`Parent item with ID ${postId} not found in state.posts or state.comments cache. Count not updated dynamically.`);
        }
        const currentParentComments = this.state.comments.val[postId] || [];
        const updatedParentCommentList = [...currentParentComments, comment];
        this.state.comments.val = { ...this.state.comments.val, [postId]: updatedParentCommentList };
        return comment;
      } catch (error) {
        console.error('Error creating comment:', error);
        throw error;
      }
    },

    async deleteComment(commentId, postId) {
      try {
        if (!auth.isLoggedInState.val) return false;
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
        this.state.allCommentsExpanded.val = { ...this.state.allCommentsExpanded.val, [parentId]: false };
      } catch (error) {
        console.error(`Error during collapseAllComments for ${parentId}:`, error);
      }
    } // End collapseAllComments
  } // End actions
};

export default postsStore;
