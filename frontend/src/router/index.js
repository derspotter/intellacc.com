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
// import AssignedPredictionsList from '../components/predictions/AssignedPredictionsList'; // Removed import
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
      const store = await getStore('predictions'); // Preload predictions store
      // Fetch events and assigned predictions if logged in and needed
      if (isLoggedInState.val && store && store.state && store.actions) {
        // Fetch Events
        if (store.actions.fetchEvents && store.state.events?.val?.length === 0 && !store.state.loadingEvents?.val) {
           console.log("Router: Fetching initial events for predictions page...");
           store.actions.fetchEvents.call(store);
        }
        // Fetch Assigned Predictions
        if (store.actions.fetchAssignedPredictions && store.state.assignedPredictions?.val?.length === 0 && !store.state.loadingAssigned?.val) {
           console.log("Router: Fetching initial assigned predictions...");
           store.actions.fetchAssignedPredictions.call(store);
        }
        // Optional: Fetch general predictions list if needed by PredictionsList component
        if (store.actions.fetchPredictions && store.state.predictions?.val?.length === 0 && !store.state.loading?.val) {
           console.log("Router: Fetching initial predictions list...");
           store.actions.fetchPredictions.call(store);
        }
      }
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
        // Column 1: Create Form
        div({ class: "predictions-column" }, [
          CreatePredictionForm()
        ]),
        // Column 2: Predictions List
        div({ class: "predictions-column" }, [
          PredictionsList()
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