import van from 'vanjs-core';
const { nav, a, div, span } = van.tags;
import { isMobile } from '../../utils/deviceDetection';
import { isLoggedInState } from '../../services/auth';
import { currentPageState } from '../../store';

/**
 * Bottom navigation bar for mobile devices
 * @returns {HTMLElement|null} Bottom navigation element
 */
export default function BottomNav() {
  // Helper to check if a page is active
  const isActive = (page) => {
    const current = currentPageState.val.split('/')[0];
    return current === page;
  };

  // Navigation items
  const navItems = [
    {
      id: 'home',
      href: '#home',
      icon: '🏠',
      label: 'Home',
      requiresAuth: false
    },
    {
      id: 'predictions',
      href: '#predictions',
      icon: '📊',
      label: 'Markets',
      requiresAuth: false
    },
    {
      id: 'create',
      href: '#home',
      icon: '➕',
      label: 'Create',
      requiresAuth: true,
      isSpecial: true
    },
    {
      id: 'messages',
      href: '#messages',
      icon: '💬',
      label: 'Messages',
      requiresAuth: true
    },
    {
      id: 'profile',
      href: '#profile',
      icon: '👤',
      label: 'Profile',
      requiresAuth: true,
      fallbackHref: '#login'
    }
  ];

  // Only render on mobile
  return () => isMobile.val ? nav({ class: "bottom-nav" },
    navItems.map(item => {
      // Check if item should be shown
      const shouldShow = !item.requiresAuth || isLoggedInState.val;

      // Determine href
      const href = item.requiresAuth && !isLoggedInState.val && item.fallbackHref
        ? item.fallbackHref
        : item.href;

      return a({
        href,
        class: () => {
          const classes = ['bottom-nav-item'];
          if (isActive(item.id)) classes.push('active');
          if (item.isSpecial) classes.push('special');
          if (!shouldShow) classes.push('disabled');
          return classes.join(' ');
        }
      }, [
        span({ class: "nav-icon" }, item.icon),
        span({ class: "nav-label" }, item.label)
      ]);
    })
  ) : null;
}
