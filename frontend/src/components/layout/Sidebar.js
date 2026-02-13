import van from 'vanjs-core';
const { div, a, button, span } = van.tags;
import { isLoggedInState, isAdminState } from '../../services/auth';
import { logout } from '../../services/auth';
import api from '../../services/api';
import socketService from '../../services/socket';
import { isMobile } from '../../utils/deviceDetection';

/**
 * Sidebar navigation component
 * @param {Object} props - Component props
 * @param {van.State} props.isOpen - Mobile menu open state
 * @returns {HTMLElement} Sidebar element
 */
export default function Sidebar({ isOpen = van.state(false) } = {}) {
  const unreadCount = van.state(0);
  const pendingLinkCount = van.state(0);
  const lastSeenPendingLinkCount = van.state(0);
  const showPendingLinkToast = van.state(false);

  // Load unread notification count
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

  // Load pending device-link requests count
  const loadPendingLinkCount = async () => {
    if (!isLoggedInState.val) {
      pendingLinkCount.val = 0;
      lastSeenPendingLinkCount.val = 0;
      showPendingLinkToast.val = false;
      return;
    }

    try {
      const result = await api.devices.listPendingLinkRequests();
      pendingLinkCount.val = Array.isArray(result) ? result.length : 0;
      if (pendingLinkCount.val > lastSeenPendingLinkCount.val && pendingLinkCount.val > 0) {
        showPendingLinkToast.val = true;
      }
    } catch (error) {
      console.error('Error loading pending link requests:', error);
      pendingLinkCount.val = 0;
      lastSeenPendingLinkCount.val = 0;
      showPendingLinkToast.val = false;
    }
  };

  const markPendingLinkRequestsAsSeen = () => {
    lastSeenPendingLinkCount.val = pendingLinkCount.val;
    showPendingLinkToast.val = false;
  };

  const dismissPendingLinkToast = (event) => {
    event?.preventDefault?.();
    event?.stopPropagation?.();
    markPendingLinkRequestsAsSeen();
  };

  const goToSettingsForLinkRequest = (event) => {
    event?.preventDefault?.();
    window.location.hash = '#settings';
    markPendingLinkRequestsAsSeen();
  };

  // Listen for socket notification events
  const handleNotification = (data) => {
    if (data.type === 'new') {
      unreadCount.val = unreadCount.val + 1;
    } else if (data.type === 'unreadCountUpdate') {
      unreadCount.val = data.count;
    } else if (data.type === 'deviceLinkRequest') {
      showPendingLinkToast.val = true;
    }
  };

  const handleDeviceLinkRequest = () => {
    showPendingLinkToast.val = true;
    loadPendingLinkCount();
  };

  // Initial load and setup
  if (isLoggedInState.val) {
    loadUnreadCount();
    loadPendingLinkCount();
    socketService.on('notification', handleNotification);
    socketService.on('deviceLinkRequest', handleDeviceLinkRequest);

    // Refresh counts every 30 seconds
    setInterval(() => {
      loadUnreadCount();
      loadPendingLinkCount();
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
              span("Messages")
            ])
          ])
        : null,

      () => showPendingLinkToast.val && pendingLinkCount.val > 0
        ? div({
            class: 'device-link-toast',
            onclick: goToSettingsForLinkRequest
          }, [
            div({ class: 'device-link-toast-title' }, 'New device verification request'),
            div({ class: 'device-link-toast-body' }, `Tap to approve ${pendingLinkCount.val} pending request${pendingLinkCount.val === 1 ? '' : 's'} in Settings.`),
            button({
              class: 'device-link-toast-close',
              type: 'button',
              onclick: dismissPendingLinkToast
            }, '×')
          ])
        : null,

      div({ class: "sidebar-item" }, a({ href: "#settings" }, "Settings")),

      // Admin-only section
      () => isLoggedInState.val && isAdminState.val
        ? div({ class: "sidebar-item admin" }, a({ href: "#admin" }, "Admin Dashboard"))
        : null,

      () => isLoggedInState.val && pendingLinkCount.val > 0
        ? div({ class: "sidebar-item sidebar-warning" }, [
            a({ href: "#settings", class: "sidebar-link", style: "display:flex; align-items:center; gap:0.35rem;", onclick: markPendingLinkRequestsAsSeen }, [
              span("Device Link Requests"),
              span({
                style: "display:inline-block; background:#ff0000; color:#fff; border:1px solid #000; border-radius:999px; padding:0 0.45rem; font-size:0.75rem;"
              }, pendingLinkCount.val)
            ])
          ])
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
