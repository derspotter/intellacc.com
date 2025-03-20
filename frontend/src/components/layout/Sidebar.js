import van from 'vanjs-core';
const { div, a, button } = van.tags;
import { isLoggedInState, isAdminState } from '../../services/auth';
import { logout } from '../../services/auth';

/**
 * Sidebar navigation component
 * @returns {HTMLElement} Sidebar element
 */
export default function Sidebar() {
  return div({ class: "sidebar" }, [
    div({ class: "sidebar-logo" }, "INTELLACC"),
    div({ class: "sidebar-content" }, [
      div({ class: "sidebar-item" }, a({ href: "#home" }, "Home")),
      div({ class: "sidebar-item" }, a({ href: "#posts" }, "All Posts")),
      div({ class: "sidebar-item" }, a({ href: "#predictions" }, "Predictions")),
      
      // Admin-only section
      () => isLoggedInState.val && isAdminState.val 
        ? div({ class: "sidebar-item admin" }, a({ href: "#admin" }, "Admin Dashboard")) 
        : null,
      
      // Authenticated user items
      () => isLoggedInState.val 
        ? div({ class: "auth-items" }, [  // Changed class name
            div({ class: "sidebar-item" }, a({ href: "#profile" }, "My Profile")),
            div({ class: "sidebar-item" }, button({ onclick: logout }, "Logout"))
          ])
        : div({ class: "sidebar-item" }, a({ href: "#login" }, "Login"))
    ])
  ]);
}