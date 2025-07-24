import van from 'vanjs-core';
import MainLayout from '../components/layout/MainLayout';
import { currentPageState } from '../store';
import navigationStore from '../store/navigation';
import { isLoggedInState, isAdminState } from '../services/auth';
import { getStore } from '../store';

// Import all components directly
import LoginForm from '../components/auth/LoginForm';
import SignUpForm from '../components/auth/SignUpForm';
import PostsList from '../components/posts/PostsList';
import CreatePostForm from '../components/posts/CreatePostForm';
// Replace PredictionsList with ProfilePredictions
import ProfilePredictions from '../components/profile/ProfilePredictions';
import CreatePredictionForm from '../components/predictions/CreatePredictionForm';
import CreateEventForm from '../components/predictions/CreateEventForm';
import AdminEventManagement from '../components/predictions/AdminEventManagement';
import EventsList from '../components/predictions/EventsList';
import RPBalance from '../components/predictions/RPBalance';
import GlobalLeaderboard from '../components/predictions/GlobalLeaderboard';
import ProfilePage from '../components/profile/ProfilePage';
import SettingsPage from '../components/settings/SettingsPage';

// Use shorthand for tag functions
const { div, h1, h2, h3, p, button } = van.tags;

// Update page from hash (now async to handle store loading and initial fetch)
export const updatePageFromHash = async () => {
  const hash = window.location.hash.slice(1) || 'home';
  const page = hash.split('/')[0]; // Get the base page (e.g., 'user' from 'user/123')
  
  // Update navigation store state
  navigationStore.actions.updatePageFromHash.call(navigationStore);
  
  currentPageState.val = hash;

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
    signup: () => SignUpForm(),
    settings: () => SettingsPage(),
    
    predictions: () => div({ class: "markets-page" }, [
      
      // User stats bar or description for non-logged users  
      () => isLoggedInState.val ? 
        // Show user stats horizontally
        div({ class: "user-stats-bar" }, [
          RPBalance({ horizontal: true })
        ]) :
        // Show description and login prompt for non-logged users
        div([
          p({ class: "page-description" }, "Trade on future events with LMSR automated market making. Earn rewards through weekly assignments and optimal staking."),
          div({ class: "login-prompt-inline" }, [
            p("Join the markets to trade on predictions and earn rewards!"),
            button({ 
              onclick: () => { window.location.hash = 'login' },
              class: "cta-button"
            }, "Sign Up / Log In")
          ])
        ]),
      
      // Admin Event Management
      () => isAdminState.val ? AdminEventManagement() : null,
      
      // Market Overview Section - moved above leaderboard
      div({ class: "market-overview" }, [
        // Main Markets Trading Interface
        EventsList()
      ]),
      
      // Global Leaderboard Section
      div({ class: "leaderboard-section" }, [
        GlobalLeaderboard({ limit: 10 })
      ])
    ]),
    
    profile: () => ProfilePage(),
    
    notFound: () => div({ class: "not-found-page" }, [
      h1("404 - Page Not Found"),
      p("The page you're looking for doesn't exist."),
      button({ onclick: () => { window.location.hash = 'home' }}, "Back to Home")
    ])
  };
  
  // Render the appropriate page content
  return () => {
    const hash = currentPageState.val;
    const parts = hash.split('/');
    const page = parts[0];
    
    // Special case for login and signup (no layout)
    if (page === 'login' || page === 'signup') {
      return pages[page] ? pages[page]() : pages.notFound();
    }
    
    // Handle user profile routes
    if (page === 'user' && parts[1]) {
      const userId = parts[1];
      return MainLayout({ 
        children: ProfilePage({ userId })
      });
    }
    
    // Wrap other pages in layout
    return MainLayout({ 
      children: (pages[page] || pages.notFound)()
    });
  };
}