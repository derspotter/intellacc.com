import van from 'vanjs-core';
import MainLayout from '../components/layout/MainLayout';
import { currentPageState } from '../store'; // Updated import path
import { isLoggedInState, isAdminState } from '../services/auth';

// Import page content components
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

// Update page from hash
export const updatePageFromHash = () => {
  currentPageState.val = window.location.hash.slice(1) || 'home';
};

// Keep global reference
window.updatePageFromHash = updatePageFromHash;

/**
 * Router component that renders content into the main layout
 */
export default function Router() {
  // Page content state
  const editMode = van.state(false);
  
  // Define page contents
  const pageContents = {
    home: () => van.tags.div({ class: "home-page" }, [
      van.tags.h1("Welcome to Intellacc"),
      
      // Only show post creation for logged in users
      () => isLoggedInState.val ? CreatePostForm() : 
        van.tags.div({ class: "login-notice" }, [
          van.tags.p("Log in to create posts and see personalized content"),
          van.tags.button({
            onclick: () => { window.location.hash = 'login'; }
          }, "Log In")
        ]),
      
      van.tags.h2("Recent Posts"),
      PostsList()
    ]),
    
    login: () => {
      // Login page content without layout
      const formState = van.state({ email: '', password: '', submitting: false });
      
      return van.tags.div({ class: "login-container" }, [
        van.tags.h1("Sign In"),
        // Login form content here
      ]);
    },
    
    predictions: () => van.tags.div({ class: "predictions-page" }, [
      van.tags.h1("Predictions & Betting"),
      
      // Admin section - only visible to admins
      () => isAdminState.val ? AdminEventManagement() : null,
      
      van.tags.div({ class: "predictions-container" }, [
        van.tags.div({ class: "predictions-column" }, [
          CreatePredictionForm(),
          PredictionsList()
        ]),
        
        van.tags.div({ class: "predictions-column" }, [
          AssignedPredictionsList()
        ])
      ])
    ]),
    
    profile: () => van.tags.div({ class: "profile-page" }, [
      van.tags.h1("My Profile"),
      
      van.tags.div({ class: "profile-container" }, [
        van.tags.div({ class: "profile-column main" }, [
          // Toggle between profile view and editor based on state
          () => editMode.val 
            ? ProfileEditor({ onCancel: () => editMode.val = false }) 
            : ProfileCard({ onEdit: () => editMode.val = true }),
          
          ProfilePredictions()
        ]),
        
        van.tags.div({ class: "profile-column sidebar" }, [
          NetworkTabs()
        ])
      ])
    ]),
    
    // 404 page for unknown routes
    notFound: () => van.tags.div({ class: "not-found-page" }, [
      van.tags.h1("404 - Page Not Found"),
      van.tags.p("The page you're looking for doesn't exist."),
      van.tags.button({
        onclick: () => { window.location.hash = 'home'; }
      }, "Back to Home")
    ])
  };
  
  // Determine which content to render
  const renderContent = () => {
    // Special case for login page (no layout)
    if (currentPageState.val === 'login') {
      return pageContents.login();
    }
    
    // Get content for current page or show 404
    const content = pageContents[currentPageState.val] || pageContents.notFound;
    
    // Wrap content in layout
    return MainLayout({ 
      children: content()
    });
  };
  
  return renderContent;
}