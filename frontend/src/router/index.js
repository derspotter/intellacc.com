import van from 'vanjs-core';
import MainLayout from '../components/layout/MainLayout';
import NotificationsPage from '../pages/Notifications.js';
import MessagesPage from '../pages/Messages.js';
import { currentPageState } from '../store';
import { isLoggedInState, isAdminState } from '../services/auth';
import { getStore } from '../store';
import UnlockModal from '../components/vault/UnlockModal.js';
import PassphraseSetupModal from '../components/vault/PassphraseSetupModal.js';

// Import all components directly
import LoginForm from '../components/auth/LoginForm';
import SignUpForm from '../components/auth/SignUpForm';
import PostsList from '../components/posts/PostsList';
import CreatePostForm from '../components/posts/CreatePostForm';
// Replace PredictionsList with ProfilePredictions
import EventsList from '../components/predictions/EventsList.js';
import EventCard from '../components/predictions/EventCard.js';
import MarketStakes from '../components/predictions/MarketStakes.js';
import LeaderboardCard from '../components/predictions/LeaderboardCard.js';
import RPBalance from '../components/predictions/RPBalance.js';
import WeeklyAssignment from '../components/predictions/WeeklyAssignment.js';
import CreatePredictionForm from '../components/predictions/CreatePredictionForm.js';
import AdminEventManagement from '../components/predictions/AdminEventManagement.js';
import ProfileCard from '../components/profile/ProfileCard';
import ProfileEditor from '../components/profile/ProfileEditor';
import ProfilePredictions from '../components/profile/ProfilePredictions';
import NetworkTabs from '../components/profile/NetworkTabs';
import SettingsPage from '../components/settings/SettingsPage';

// Use shorthand for tag functions
const { div, h1, h2, p, button } = van.tags;

// Update page from hash (now async to handle store loading and initial fetch)
export const updatePageFromHash = async () => {
  const page = window.location.hash.slice(1) || 'home';
  
  // Update the reactive state so the router re-renders
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
    
    predictions: () => div({ class: "predictions-page" }, [
      h1("Predictions & Betting"),
      div({ class: "predictions-header" }, [
        RPBalance({ horizontal: true })
      ]),
      div({ class: "predictions-main" }, [
        div({ class: "events-list-column" }, [
          EventsList()
        ]),
        div({ class: "market-stakes-column" }, [
          MarketStakes({ eventId: null }), // eventId should be set by selection logic
        ]),
        div({ class: "leaderboard-column" }, [
          LeaderboardCard()
        ])
      ]),
      () => isAdminState.val ? AdminEventManagement() : null,
      div({ class: "create-prediction-column" }, [
        CreatePredictionForm()
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
            // Use ProfilePredictions with compact mode (default settings work fine)
            ProfilePredictions({
              compact: true,
              limit: 5,
              showViewAll: true,
              title: 'Your Predictions',
              className: 'profile-predictions'
            })
          ]),
          div({ class: "profile-column sidebar" }, [
            NetworkTabs()
          ])
        ])
      ])
    },
    
  notifications: () => NotificationsPage(),
  messages: () => MessagesPage(),
  notFound: () => div({ class: "not-found-page" }, [
      h1("404 - Page Not Found"),
      p("The page you're looking for doesn't exist."),
      button({ onclick: () => { window.location.hash = 'home' }}, "Back to Home")
    ])
  };
  
  // Render the appropriate page content
  return () => {
    const page = currentPageState.val;

    // Special case for login and signup (no layout, no vault modals)
    if (page === 'login' || page === 'signup') {
      return pages[page] ? pages[page]() : pages.notFound();
    }

    // Wrap other pages in layout with vault modals
    return div({ class: 'app-root' }, [
      MainLayout({
        children: (pages[page] || pages.notFound)()
      }),
      // Vault modals (always rendered, visibility controlled by vaultStore)
      UnlockModal(),
      PassphraseSetupModal()
    ]);
  };
}