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
    commentLoading: van.state({}) // Track loading state by postId
  },
  
  actions: {
    /**
     * Fetch all posts
     * @returns {Promise<Array>} Posts
     */
    async fetchPosts() {
      try {
        this.state.loading.val = true;
        this.state.error.val = null;
        
        // Only fetch if logged in
        if (!auth.isLoggedInState.val) {
          return this.actions.loadMockPosts.call(this);
        }
        
        const posts = await api.posts.getAll();
        this.state.posts.val = Array.isArray(posts) ? posts : [];
        return this.state.posts.val;
      } catch (error) {
        console.error('Error fetching posts:', error);
        this.state.error.val = error.message;
        
        // Load mock data in development
        if (window.location.hostname === 'localhost' || 
            window.location.hostname === '127.0.0.1') {
          this.actions.loadMockPosts.call(this);
        }
        
        return [];
      } finally {
        this.state.loading.val = false;
      }
    },
    
    loadMockPosts() {
      this.state.posts.val = [
        {
          id: 1,
          title: "First Post",
          content: "This is the first post content.",
          username: "user1",
          created_at: new Date().toISOString()
        },
        {
          id: 2,
          title: "Second Post",
          content: "This is the second post with more content.",
          username: "user2",
          created_at: new Date(Date.now() - 86400000).toISOString()
        }
      ];
      
      this.state.loading.val = false;
      return this.state.posts.val;
    },
    
    async createPost(content, image_url = null) {
      try {
        this.state.loading.val = true;
        this.state.error.val = null;
        
        console.log('Attempting to create post with data:', { content, image_url });
        
        // Check if content is valid before sending to API
        if (!content || typeof content !== 'string' || content.trim() === '') {
          throw new Error('Post content cannot be empty');
        }
        
        try {
          const post = await api.posts.create(content, image_url);
          console.log('Post created successfully:', post);
          
          // Create a new array to ensure reactivity
          const updatedPosts = [post, ...this.state.posts.val];
          this.state.posts.val = updatedPosts;
          
          return post;
        } catch (apiError) {
          // Log detailed API error information
          console.error('API Error details:', {
            message: apiError.message,
            status: apiError.status,
            response: apiError.response,
            fullError: apiError
          });
          
          // Try to get more specific error message if available
          const errorMessage = apiError.response?.message || 
                              apiError.message || 
                              'Server error: Could not create post';
          
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
    
    /**
     * Toggle like status for a post
     * @param {number} postId - Post ID to like/unlike
     */
    async toggleLike(postId) {
      try {
        if (!auth.isLoggedInState.val) return false;
        
        // Find the post
        const postIndex = this.state.posts.val.findIndex(post => post.id === postId);
        if (postIndex === -1) return false;
        
        const post = this.state.posts.val[postIndex];
        
        // Check current like status
        const currentStatus = this.state.likeStatus.val[postId] || false;
        
        // Update optimistically
        const updatedPost = { 
          ...post, 
          like_count: currentStatus ? Math.max(0, post.like_count - 1) : post.like_count + 1
        };
        
        // Update local state
        const newPosts = [...this.state.posts.val];
        newPosts[postIndex] = updatedPost;
        this.state.posts.val = newPosts;
        
        // Update like status
        this.state.likeStatus.val = {
          ...this.state.likeStatus.val,
          [postId]: !currentStatus
        };
        
        // Call API
        try {
          if (currentStatus) {
            await api.posts.unlikePost(postId);
          } else {
            await api.posts.likePost(postId);
          }
          return true;
        } catch (error) {
          console.error('Error toggling like:', error);
          
          // Revert on failure
          newPosts[postIndex] = post;
          this.state.posts.val = newPosts;
          this.state.likeStatus.val = {
            ...this.state.likeStatus.val,
            [postId]: currentStatus
          };
          return false;
        }
      } catch (error) {
        console.error('Error in toggle like:', error);
        return false;
      }
    },
    
    /**
     * Check like status for posts
     * @param {number} postId - Post ID to check
     */
    async checkLikeStatus(postId) {
      try {
        if (!auth.isLoggedInState.val || !postId) return;
        
        // Check if we already have the status cached
        if (this.state.likeStatus.val[postId] !== undefined) return;
        
        const response = await api.posts.getLikeStatus(postId);
        
        // Update the like status
        this.state.likeStatus.val = {
          ...this.state.likeStatus.val,
          [postId]: response.liked || false
        };
        return response.liked;
      } catch (error) {
        console.error('Error checking like status:', error);
        return false;
      }
    },
    
    /**
     * Fetch comments for a post
     * @param {number} postId - Post ID to fetch comments for
     * @returns {Promise<Array>} Comments
     */
    async fetchComments(postId) {
      try {
        if (!postId) return [];
        
        // Set loading state for this post's comments
        this.state.commentLoading.val = {
          ...this.state.commentLoading.val,
          [postId]: true
        };
        
        // Fetch the comments
        const comments = await api.posts.getComments(postId);
        
        // Store comments in state
        this.state.comments.val = {
          ...this.state.comments.val,
          [postId]: comments
        };
        
        return comments;
      } catch (error) {
        console.error('Error fetching comments:', error);
        return [];
      } finally {
        // Clear loading state
        this.state.commentLoading.val = {
          ...this.state.commentLoading.val,
          [postId]: false
        };
      }
    },
    
    /**
     * Create a comment on a post
     * @param {number} postId - Post ID to comment on
     * @param {string} content - Comment content
     * @returns {Promise<Object>} Created comment
     */
    async createComment(postId, content) {
      try {
        if (!auth.isLoggedInState.val) {
          throw new Error('You must be logged in to comment');
        }
        
        if (!content || content.trim() === '') {
          throw new Error('Comment cannot be empty');
        }
        
        // Create the comment (using unified post/comment model)
        const comment = await api.posts.createComment(postId, content);
        
        // Update comments in state if we have already loaded comments for this post
        if (this.state.comments.val[postId]) {
          const updatedComments = [...this.state.comments.val[postId], comment];
          this.state.comments.val = {
            ...this.state.comments.val,
            [postId]: updatedComments
          };
        }
        
        // Update comment count on the parent post
        const postIndex = this.state.posts.val.findIndex(post => post.id === postId);
        if (postIndex !== -1) {
          const post = this.state.posts.val[postIndex];
          const updatedPost = {
            ...post,
            comment_count: (post.comment_count || 0) + 1
          };
          
          const newPosts = [...this.state.posts.val];
          newPosts[postIndex] = updatedPost;
          this.state.posts.val = newPosts;
        }
        
        return comment;
      } catch (error) {
        console.error('Error creating comment:', error);
        throw error;
      }
    },
    
    /**
     * Delete a comment
     * @param {number} commentId - Comment ID to delete
     * @param {number} postId - Parent post ID
     * @returns {Promise<boolean>} Success status
     */
    async deleteComment(commentId, postId) {
      try {
        if (!auth.isLoggedInState.val) return false;
        
        // Delete the comment
        await api.posts.deleteComment(commentId);
        
        // Update comments in state if we have already loaded comments for this post
        if (this.state.comments.val[postId]) {
          const updatedComments = this.state.comments.val[postId].filter(comment => comment.id !== commentId);
          this.state.comments.val = {
            ...this.state.comments.val,
            [postId]: updatedComments
          };
        }
        
        // Update comment count on the parent post
        const postIndex = this.state.posts.val.findIndex(post => post.id === postId);
        if (postIndex !== -1) {
          const post = this.state.posts.val[postIndex];
          const updatedPost = {
            ...post,
            comment_count: Math.max(0, (post.comment_count || 1) - 1)
          };
          
          const newPosts = [...this.state.posts.val];
          newPosts[postIndex] = updatedPost;
          this.state.posts.val = newPosts;
        }
        
        return true;
      } catch (error) {
        console.error('Error deleting comment:', error);
        return false;
      }
    }
  }
};

export default postsStore;