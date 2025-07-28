import van from 'vanjs-core';
const { div, a, button } = van.tags;
import { isLoggedInState, isAdminState } from '../../services/auth';
import { logout } from '../../services/auth';
import NotificationBell from '../common/NotificationBell';
import NotificationsList from '../common/NotificationsList';

/**
 * Sidebar navigation component
 * @returns {HTMLElement} Sidebar element
 */
export default function Sidebar() {
  // State for notifications dropdown
  const notificationsOpen = van.state(false);
  const unreadCount = van.state(0);

  // Toggle notifications dropdown
  const toggleNotifications = () => {
    notificationsOpen.val = !notificationsOpen.val;
  };

  // Close notifications dropdown
  const closeNotifications = () => {
    notificationsOpen.val = false;
  };

  // Handle unread count changes
  const handleUnreadCountChange = (count) => {
    unreadCount.val = count;
  };

  return div({ class: "sidebar" }, [
    div({ class: "sidebar-logo" }, "INTELLACC"),
    div({ class: "sidebar-content" }, [
      div({ class: "sidebar-item" }, a({ href: "#home" }, "Home")),
      div({ class: "sidebar-item" }, a({ href: "#predictions" }, "Predictions")),
      div({ class: "sidebar-item" }, a({ href: "#settings" }, "Settings")),
      
      // Notifications section (only show when logged in)
      () => isLoggedInState.val 
        ? div({ class: "sidebar-item notifications-container" }, [
            NotificationBell({ onClick: toggleNotifications }),
            NotificationsList({
              isOpen: notificationsOpen,
              onClose: closeNotifications,
              onUnreadCountChange: handleUnreadCountChange
            })
          ])
        : null,
      
      // Admin-only section
      () => isLoggedInState.val && isAdminState.val 
        ? div({ class: "sidebar-item admin" }, a({ href: "#admin" }, "Admin Dashboard")) 
        : null,
      
      // Authenticated user items
      () => isLoggedInState.val 
        ? div({ class: "auth-items" }, [  
            div({ class: "sidebar-item" }, a({ href: "#profile" }, "My Profile")),
            div({ class: "sidebar-item" }, button({ onclick: logout }, "Logout"))
          ])
        : div({ class: "sidebar-item" }, a({ href: "#login" }, "Login"))
    ])
  ]);
}