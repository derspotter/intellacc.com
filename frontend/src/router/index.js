import van from 'vanjs-core';
import MainLayout from '../components/layout/MainLayout';
import { currentPageState } from '../store';
import { isLoggedInState, isAdminState } from '../services/auth';
import { getStore } from '../store';

// Import all components directly
import LoginForm from '../components/auth/LoginForm';
import PostsList from '../components/posts/PostsList';
import CreatePostForm from '../components/posts/CreatePostForm';
import PredictionsList from '../components/predictions/PredictionsList';
import CreatePredictionForm from '../components/predictions/CreatePredictionForm';
import AssignedPredictionsList from '../components/predictions/AssignedPredictionsList';
import AdminEventManagement from '../components/predictions/AdminEventManagement';
import ProfileCard from '../components/profile/ProfileCard';
import ProfileEditor from '../components/profile/ProfileEditor';
import NetworkTabs from '../components/profile/NetworkTabs';
import ProfilePredictions from '../components/profile/ProfilePredictions';

// Use shorthand for tag functions
const { div, h1, h2, p, button } = van.tags;

// Update page from hash (now async to handle store loading and initial fetch)
export const updatePageFromHash = async () => {
  const page = window.location.hash.slice(1) || 'home';
  currentPageState.val = page;

  // Preload store and potentially fetch initial data based on route
  try {
    if (page === 'home' && isLoggedInState.val) {
      const store = await getStore('posts');
      // Fetch only if needed (not loading, no posts yet)
      if (store && store.state && store.actions && store.actions.fetchPosts && !store.state.loading.val && store.state.posts.val.length === 0) {
        console.log("Router: Fetching initial posts for home page...");
        store.actions.fetchPosts.call(store); // No need to await the fetch itself here
      }
    } else if (page === 'predictions') {
      await getStore('predictions'); // Preload predictions store
      // Add similar initial fetch logic for predictions if needed
    } else if (page === 'profile' && isLoggedInState.val) {
      const userStore = await getStore('user');
       // Fetch profile only if needed (e.g., userStore.state.profile.val is null)
       if (userStore && userStore.state && !userStore.state.loading.val && !userStore.state.profile.val) {
          console.log("Router: Fetching initial user profile...");
          userStore.actions.fetchUserProfile.call(userStore);
       }
    }
  } catch (error) {
    console.error("Error during store preloading/initial fetch:", error);
  }
};

// Keep global reference (e.g., for hash changes)
window.updatePageFromHash = updatePageFromHash;

// DO NOT call updatePageFromHash() here anymore.
// It will be called from main.js after initial setup.

export default function Router() {
  const editMode = van.state(false);
  
  // Define page contents
  const pages = {
    home: () => {
      // Fetching logic is now handled by updatePageFromHash on route change
      return div({ class: "home-page" }, [
        h1("Welcome to Intellacc"),
        () => isLoggedInState.val
          ? CreatePostForm()
          : div({ class: "login-notice" }, [
              p("Log in to create posts and see personalized content"),
              button({ onclick: () => { window.location.hash = 'login' }}, "Log In")
            ]),
        h2("Recent Posts"),
        PostsList()
      ]);
    },
    
    login: () => LoginForm(),
    
    predictions: () => div({ class: "predictions-page" }, [
      h1("Predictions & Betting"),
      () => isAdminState.val ? AdminEventManagement() : null,
      div({ class: "predictions-container" }, [
        div({ class: "predictions-column" }, [
          CreatePredictionForm(), 
          PredictionsList()
        ]),
        div({ class: "predictions-column" }, [
          AssignedPredictionsList()
        ])
      ])
    ]),
    
    profile: () => {
      // Fetching logic is now handled by updatePageFromHash on route change
      const editMode = van.state(false); // Keep editMode state local to profile page

      return div({ class: "profile-page" }, [
        h1("My Profile"),
        div({ class: "profile-container" }, [
          div({ class: "profile-column main" }, [
            () => editMode.val
              ? ProfileEditor({ onCancel: () => editMode.val = false })
              : ProfileCard({ onEdit: () => editMode.val = true }),
            ProfilePredictions()
          ]),
          div({ class: "profile-column sidebar" }, [
            NetworkTabs()
          ])
        ])
      ])
    },
    
    notFound: () => div({ class: "not-found-page" }, [
      h1("404 - Page Not Found"),
      p("The page you're looking for doesn't exist."),
      button({ onclick: () => { window.location.hash = 'home' }}, "Back to Home")
    ])
  };
  
  // Render the appropriate page content
  return () => {
    const page = currentPageState.val;
    
    // Special case for login (no layout)
    if (page === 'login') {
      return pages.login();
    }
    
    // Wrap other pages in layout
    return MainLayout({ 
      children: (pages[page] || pages.notFound)()
    });
  };
}