import van from 'vanjs-core';
const { header, div, button, span, a } = van.tags;
import { isMobile } from '../../utils/deviceDetection';
import { isLoggedInState } from '../../services/auth';
import NotificationBell from '../common/NotificationBell';

/**
 * Mobile header component with hamburger menu and notifications
 * @param {Object} props - Component props
 * @param {van.State} props.onMenuToggle - Function to toggle sidebar
 * @returns {HTMLElement|null} Mobile header element
 */
export default function MobileHeader({ onMenuToggle }) {
  // Only render on mobile
  if (!isMobile.val) return null;
  
  return () => isMobile.val ? header({ class: "mobile-header" }, [
    // Hamburger menu button
    button({ 
      class: "hamburger-button",
      onclick: onMenuToggle,
      "aria-label": "Toggle menu"
    }, [
      span({ class: "hamburger-icon" }, "☰")
    ]),
    
    // Logo/brand
    div({ class: "mobile-logo" }, 
      a({ href: "#home" }, "INTELLACC")
    ),
    
    // Right side actions
    div({ class: "mobile-header-actions" }, [
      // Notification bell (only if logged in)
      () => isLoggedInState.val ? NotificationBell() : null
    ])
  ]) : null;
}