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
      if (!auth.isLoggedInState.val) return null;
      
      this.state.loading.val = true;
      
      try {
        const profile = await api.users.getProfile();
        
        if (profile) {
          let rawBio = profile.bio; // Default to original bio
          if (profile.bio && typeof profile.bio === 'string') {
            try {
              const parsedBio = JSON.parse(profile.bio);
              if (parsedBio && typeof parsedBio.bio === 'string') {
                rawBio = parsedBio.bio;
              }
            } catch (e) {
              // Keep rawBio as profile.bio if it's not JSON or parsing fails
            }
          }
          this.state.profile.val = { ...profile, bio: rawBio };
          return this.state.profile.val;
        } else {
          return null;
        }
      } catch (error) {
        
        // Mock profile for development
        if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
          // Mock profile for development - ensure bio is a raw string
          const mockProfileData = {
            id: 1,
            username: 'testuser',
            email: 'test@example.com',
            bio: 'This is a test user profile' // Already a raw string, no parsing needed here
          };
          this.state.profile.val = mockProfileData;
          return this.state.profile.val;
        }
        return null;
      } finally {
        this.state.loading.val = false;
      }
    },
    
    async updateUserProfile(bio) {
      if (!auth.isLoggedInState.val) {
        return false;
      }
      try {
        const updatedProfile = await api.users.updateProfile({ bio });
        let rawBio = '';
        try {
          const parsedBio = JSON.parse(updatedProfile.bio); // updatedProfile.bio is '{"bio":"text"}'
          rawBio = parsedBio.bio; // Extract the actual bio string
        } catch (parseError) {
          // Decide how to handle: use raw updatedProfile.bio if it's a plain string, or fail
          rawBio = (typeof updatedProfile.bio === 'string' && !updatedProfile.bio.startsWith('{')) ? updatedProfile.bio : ''; // Fallback or error
        }

        // Update the profile state - ensure we merge, not just overwrite, if other profile fields exist and are separate
        // Assuming this.state.profile.val holds the full profile object similar to updatedProfile
        this.state.profile.val = { 
          ...this.state.profile.val, // Preserve other existing profile fields
          ...updatedProfile,         // Overwrite with all fields from API
          bio: rawBio                // Explicitly set the parsed bio string
        };
        return true;
      } catch (error) {
        return false;
      }
    },
    
    async fetchFollowers() {
      if (!auth.isLoggedInState.val || !this.state.profile.val) return;
      
      try {
        const followers = await api.user.getFollowers();
        this.state.followers.val = Array.isArray(followers) ? followers : [];
      } catch (error) {
        this.state.followers.val = []; // Empty array on error
      }
    },
    
    async fetchFollowing() {
      if (!auth.isLoggedInState.val || !this.state.profile.val) return;
      
      try {
        const following = await api.user.getFollowing();
        this.state.following.val = Array.isArray(following) ? following : [];
      } catch (error) {
        this.state.following.val = []; // Empty array on error
      }
    }
  }
};

export default userStore;