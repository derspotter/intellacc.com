import van from 'vanjs-core';
import api from '../services/api';
import auth from '../services/auth';

const userStore = {
  state: {
    profile: van.state(null),
    followers: van.state([]),
    following: van.state([]),
    loading: van.state(false)
  },
  
  actions: {
    async fetchUserProfile() {
      if (!auth.isLoggedInState.val) return;
      
      this.state.loading.val = true;
      
      try {
        const profile = await api.user.getProfile();
        this.state.profile.val = profile;
        return profile;
      } catch (error) {
        console.error('Error fetching profile:', error);
        
        // Mock profile for development
        if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
          this.state.profile.val = {
            id: 1,
            username: 'testuser',
            email: 'test@example.com',
            bio: 'This is a test user profile'
          };
        }
        return null;
      } finally {
        this.state.loading.val = false;
      }
    },
    
    async updateUserProfile(bio) {
      if (!auth.isLoggedInState.val) return false;
      
      try {
        const updatedProfile = await api.user.updateProfile({ bio });
        this.state.profile.val = updatedProfile;
        return true;
      } catch (error) {
        console.error('Error updating profile:', error);
        return false;
      }
    },
    
    async fetchFollowers() {
      if (!auth.isLoggedInState.val || !this.state.profile.val) return;
      
      try {
        const followers = await api.user.getFollowers();
        this.state.followers.val = Array.isArray(followers) ? followers : [];
      } catch (error) {
        console.error('Error fetching followers:', error);
        this.state.followers.val = []; // Empty array on error
      }
    },
    
    async fetchFollowing() {
      if (!auth.isLoggedInState.val || !this.state.profile.val) return;
      
      try {
        const following = await api.user.getFollowing();
        this.state.following.val = Array.isArray(following) ? following : [];
      } catch (error) {
        console.error('Error fetching following:', error);
        this.state.following.val = []; // Empty array on error
      }
    }
  }
};

export default userStore;