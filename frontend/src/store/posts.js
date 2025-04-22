import van from 'vanjs-core';
import api from '../services/api';
import auth from '../services/auth';

const postsStore = {
  state: {
    posts: van.state([]),
    loading: van.state(false),
    error: van.state(null)
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
        
        const post = await api.posts.create(content, image_url);
        
        // Update posts list with new post at the beginning
        this.state.posts.val = [post, ...this.state.posts.val];
        
        return post;
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
    }
  }
};

export default postsStore;