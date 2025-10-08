import van from 'vanjs-core';
const { div, a, button, span } = van.tags;
import { isLoggedInState, isAdminState } from '../../services/auth';
import { logout } from '../../services/auth';
import api from '../../services/api';
import socketService from '../../services/socket';
import { isMobile } from '../../utils/deviceDetection';
import messagingService from '../../services/messaging/index.js';
import { isMlsEnabled } from '../../services/mls/coreCryptoClient.js';

/**
 * Sidebar navigation component
 * @param {Object} props - Component props
 * @param {van.State} props.isOpen - Mobile menu open state
 * @returns {HTMLElement} Sidebar element
 */
export default function Sidebar({ isOpen = van.state(false) } = {}) {
  const unreadCount = van.state(0);
  const unreadMessages = van.state(0);

  // Load unread count
  const loadUnreadCount = async () => {
    if (isLoggedInState.val) {
      try {
        const result = await api.notifications.getUnreadCount();
        unreadCount.val = result.count;
      } catch (error) {
        console.error('Error loading unread count:', error);
      }
    }
  };

  // Load unread messages count
  const loadUnreadMessages = async () => {
    if (isLoggedInState.val) {
      try {
        unreadMessages.val = await messagingService.getUnreadCount();
      } catch (error) {
        console.error('Error loading unread messages count:', error);
      }
    }
  };

  // Listen for socket notification events
  const handleNotification = (data) => {
    if (data.type === 'new') {
      unreadCount.val = unreadCount.val + 1;
    } else if (data.type === 'unreadCountUpdate') {
      unreadCount.val = data.count;
    }
  };

  // Listen for new messages
  const handleNewMessage = (data) => {
    unreadMessages.val = unreadMessages.val + 1;
  };

  // Initial load and setup
  if (isLoggedInState.val) {
    loadUnreadCount();
    loadUnreadMessages();
    socketService.on('notification', handleNotification);
    socketService.on('newMessage', handleNewMessage);
    
    // Refresh counts every 30 seconds
    setInterval(() => {
      loadUnreadCount();
      loadUnreadMessages();
    }, 30000);
  }

  // Create overlay for mobile
  const overlay = () => isMobile.val ? div({ 
    class: () => `sidebar-overlay ${isOpen.val ? 'active' : ''}`,
    onclick: () => isOpen.val = false 
  }) : null;

  return [
    overlay(),
    div({ 
      class: () => {
        const classes = ['sidebar'];
        if (isMobile.val && isOpen.val) classes.push('open');
        if (isMobile.val) classes.push('mobile');
        return classes.join(' ');
      }
    }, [
    div({ class: "sidebar-logo" }, "INTELLACC"),
    div({ class: "sidebar-content" }, [
      div({ class: "sidebar-item" }, a({ href: "#home" }, "Home")),
      div({ class: "sidebar-item" }, a({ href: "#predictions" }, "Predictions")),
      
      // Notifications link (only show when logged in)
      () => isLoggedInState.val 
        ? div({ class: "sidebar-item" }, [
            a({ href: "#notifications", class: "notifications-link" }, [
              span("Notifications"),
              () => unreadCount.val > 0 
                ? span({ class: "sidebar-notification-count" }, 
                    unreadCount.val > 99 ? "99+" : unreadCount.val
                  )
                : null
            ])
          ])
        : null,

      // Messages link (only show when logged in)
      () => isLoggedInState.val 
        ? div({ class: "sidebar-item" }, [
            a({ href: "#messages", class: "messages-link" }, [
              span("Messages"),
              () => unreadMessages.val > 0 
                ? span({ class: "sidebar-notification-count" }, 
                    unreadMessages.val > 99 ? "99+" : unreadMessages.val
                  )
                : null
            ])
          ])
        : null,

      () => (isLoggedInState.val && isMlsEnabled())
        ? div({ class: "sidebar-item" }, a({ href: "#mls-diagnostics" }, "MLS Diagnostics"))
        : null,
      
      div({ class: "sidebar-item" }, a({ href: "#settings" }, "Settings")),
      
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
  ])
  ];
}
