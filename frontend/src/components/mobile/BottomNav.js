import van from 'vanjs-core';
const { nav, a, div, span } = van.tags;
import { isMobile } from '../../utils/deviceDetection';
import { isLoggedInState } from '../../services/auth';
import { currentPageState } from '../../store';

// Outline icon sets as inline SVG markup.
// Keeping these inlined avoids adding a dependency and renders consistently across browsers.
const ICON_SET = 'straight'; // 'straight' | 'lucide' | 'heroicons'

const STRAIGHT_SVGS = {
  home: `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"
      fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="butt" stroke-linejoin="miter"
      aria-hidden="true" focusable="false">
      <path d="M3 11L12 3l9 8" />
      <path d="M5 10.5V21h14V10.5" />
      <path d="M10 21v-7h4v7" />
    </svg>
  `,
  markets: `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"
      fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="butt" stroke-linejoin="miter"
      aria-hidden="true" focusable="false">
      <path d="M4 20V4" />
      <path d="M4 20H20" />
      <path d="M7 20v-6h3v6" />
      <path d="M11 20v-10h3v10" />
      <path d="M15 20v-4h3v4" />
    </svg>
  `,
  create: `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"
      fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="butt" stroke-linejoin="miter"
      aria-hidden="true" focusable="false">
      <!-- Outlined plus-shape (reads as a "real" plus, not two thin crossing bars) -->
      <path d="M10 5H14V10H19V14H14V19H10V14H5V10H10Z" />
    </svg>
  `,
  messages: `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"
      fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="butt" stroke-linejoin="miter"
      aria-hidden="true" focusable="false">
      <path d="M4 5h16v11H9l-5 5V5z" />
      <path d="M7 9h10" />
      <path d="M7 12h7" />
    </svg>
  `,
  search: `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"
      fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="butt" stroke-linejoin="miter"
      aria-hidden="true" focusable="false">
      <circle cx="11" cy="11" r="7" />
      <path d="m21 21-4.35-4.35" />
    </svg>
  `,
  profile: `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"
      fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="butt" stroke-linejoin="miter"
      aria-hidden="true" focusable="false">
      <path d="M12 12a4 4 0 1 0-4-4 4 4 0 0 0 4 4z" />
      <path d="M4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1" />
    </svg>
  `
};

const LUCIDE_SVGS = {
  home: `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"
      fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
      aria-hidden="true" focusable="false">
      <path d="m3 9 9-7 9 7" />
      <path d="M9 22V12h6v10" />
      <path d="M21 22H3V9" />
    </svg>
  `,
  markets: `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"
      fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
      aria-hidden="true" focusable="false">
      <line x1="6" y1="20" x2="6" y2="14" />
      <line x1="12" y1="20" x2="12" y2="4" />
      <line x1="18" y1="20" x2="18" y2="10" />
    </svg>
  `,
  create: `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"
      fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round"
      aria-hidden="true" focusable="false">
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  `,
  messages: `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"
      fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
      aria-hidden="true" focusable="false">
      <path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5 8.4 8.4 0 0 1-3.7-.8L3 21l1.8-5.8a8.4 8.4 0 0 1-.8-3.7A8.5 8.5 0 0 1 12.5 3H13a8.5 8.5 0 0 1 8 8v.5z" />
    </svg>
  `,
  search: `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"
      fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round"
      aria-hidden="true" focusable="false">
      <circle cx="11" cy="11" r="7" />
      <path d="m21 21-4.35-4.35" />
    </svg>
  `,
  profile: `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"
      fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
      aria-hidden="true" focusable="false">
      <circle cx="12" cy="7" r="4" />
      <path d="M5 21v-2a4 4 0 0 1 4-4h6a4 4 0 0 1 4 4v2" />
    </svg>
  `
};

// Heroicons Outline-ish equivalents (stroke-only, slightly thinner default)
const HEROICONS_SVGS = {
  home: `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"
      fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"
      aria-hidden="true" focusable="false">
      <path d="M2.25 12l8.954-8.955a1.125 1.125 0 0 1 1.591 0L21.75 12" />
      <path d="M4.5 9.75V21a.75.75 0 0 0 .75.75h4.5v-6a.75.75 0 0 1 .75-.75h3a.75.75 0 0 1 .75.75v6h4.5A.75.75 0 0 0 19.5 21V9.75" />
    </svg>
  `,
  markets: `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"
      fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"
      aria-hidden="true" focusable="false">
      <path d="M3 3v18h18" />
      <path d="M7 15v4" />
      <path d="M12 11v8" />
      <path d="M17 6v13" />
    </svg>
  `,
  create: `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"
      fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="square" stroke-linejoin="miter"
      aria-hidden="true" focusable="false">
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </svg>
  `,
  messages: `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"
      fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"
      aria-hidden="true" focusable="false">
      <path d="M7.5 8.25h9" />
      <path d="M7.5 12h6" />
      <path d="M21 12a8.25 8.25 0 0 1-8.25 8.25H6l-3 3V12A8.25 8.25 0 0 1 11.25 3.75H12A9 9 0 0 1 21 12Z" />
    </svg>
  `,
  search: `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"
      fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"
      aria-hidden="true" focusable="false">
      <circle cx="11" cy="11" r="7" />
      <path d="m21 21-4.35-4.35" />
    </svg>
  `,
  profile: `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"
      fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"
      aria-hidden="true" focusable="false">
      <path d="M15.75 6a3.75 3.75 0 1 1-7.5 0 3.75 3.75 0 0 1 7.5 0Z" />
      <path d="M4.5 20.25a7.5 7.5 0 0 1 15 0" />
    </svg>
  `
};

const ICON_SVGS =
  ICON_SET === 'straight'
    ? STRAIGHT_SVGS
    : (ICON_SET === 'heroicons' ? HEROICONS_SVGS : LUCIDE_SVGS);

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
      iconId: 'home',
      label: 'Home',
      requiresAuth: false
    },
    {
      id: 'predictions',
      href: '#predictions',
      iconId: 'markets',
      label: 'Markets',
      requiresAuth: false
    },
    {
      id: 'create',
      href: '#home',
      iconId: 'create',
      label: 'Create',
      requiresAuth: true,
      isSpecial: true
    },
    {
      id: 'messages',
      href: '#messages',
      iconId: 'messages',
      label: 'Messages',
      requiresAuth: true
    },
    {
      id: 'search',
      href: '#search',
      iconId: 'search',
      label: 'Search',
      requiresAuth: false
    },
    {
      id: 'profile',
      href: '#profile',
      iconId: 'profile',
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
        'aria-label': item.label,
        class: () => {
          const classes = ['bottom-nav-item'];
          if (isActive(item.id)) classes.push('active');
          if (item.isSpecial) classes.push('special');
          if (!shouldShow) classes.push('disabled');
          return classes.join(' ');
        }
      }, [
        span({
          class: () => `nav-icon icon-${item.iconId}`,
          'aria-hidden': 'true',
          innerHTML: ICON_SVGS[item.iconId] || ''
        }),
        span({ class: "nav-label" }, item.label)
      ]);
    })
  ) : null;
}
