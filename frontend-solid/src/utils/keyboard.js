// Shared keyboard helpers for the van skin (terminal skin has its own).
// One global listener (installShortcuts) owns all single-key and g-sequence
// shortcuts; overlays register on a stack that suppresses everything but
// Escape while open.

const SEQUENCE_TIMEOUT_MS = 1500;

export const SHORTCUTS = [
  { keys: 'g then h', action: 'Home', hash: 'home' },
  { keys: 'g then p', action: 'Predictions', hash: 'predictions' },
  { keys: 'g then m', action: 'Messages', hash: 'messages' },
  { keys: 'g then n', action: 'Notifications', hash: 'notifications' },
  { keys: 'g then a', action: 'Analytics', hash: 'analytics' },
  { keys: 'g then g', action: 'Groups', hash: 'groups' },
  { keys: 'g then s', action: 'Settings', hash: 'settings' },
  { keys: 'g then u', action: 'My profile', hash: 'profile' },
  { keys: '/', action: 'Search' },
  { keys: 'j / k', action: 'Next / previous item in the list' },
  { keys: 'Enter', action: 'Open the focused item' },
  { keys: '← / →', action: 'Jump between sidebar and content' },
  { keys: '?', action: 'This help' },
  { keys: 'Esc', action: 'Close dialog / collapse item' },
];

const GO_TARGETS = Object.fromEntries(
  SHORTCUTS.filter((s) => s.hash).map((s) => [s.keys.slice(-1), s.hash])
);

export const activateOnKey = (handler) => (event) => {
  if (event.key === 'Enter' || event.key === ' ') {
    if (event.key === ' ') event.preventDefault();
    handler(event);
  }
};

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export const createFocusTrap = (container) => {
  const onKeyDown = (event) => {
    if (event.key !== 'Tab') return;
    const items = [...container.querySelectorAll(FOCUSABLE)].filter(
      (el) => el.offsetParent !== null
    );
    if (items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };
  container.addEventListener('keydown', onKeyDown);
  return () => container.removeEventListener('keydown', onKeyDown);
};

// Overlay stack: while non-empty, the shortcut registry is silent except for
// Escape, which closes the top overlay.
const overlayStack = [];
export const pushOverlay = (onClose) => overlayStack.push(onClose);
export const popOverlay = () => overlayStack.pop();
export const overlayDepth = () => overlayStack.length;

const isTypingTarget = (target) => {
  const tag = target?.tagName;
  return (
    tag === 'INPUT' ||
    tag === 'TEXTAREA' ||
    tag === 'SELECT' ||
    target?.isContentEditable
  );
};

const isDesktop = () => window.matchMedia('(min-width: 1025px)').matches;

const focusFirst = (selector) => {
  const el = document.querySelector(selector);
  if (el) el.focus();
  return !!el;
};

// Navigate to #search and focus its input once it renders.
const goToSearch = () => {
  window.location.hash = 'search';
  const started = Date.now();
  const tryFocus = () => {
    // Scoped to the standalone #search page only: the home page also embeds
    // a `.search-input` (its inline search box), which would otherwise be
    // focused-then-discarded during the brief window before the router swaps
    // HomePage out for the real Search page.
    const input = document.querySelector('.page-search .search-input');
    if (input) {
      input.focus();
      return;
    }
    if (Date.now() - started < 2000) requestAnimationFrame(tryFocus);
  };
  requestAnimationFrame(tryFocus);
};

const listRows = () => {
  const container = document.querySelector('[data-primary-list]');
  return container ? [...container.querySelectorAll('[data-kb-row]')] : [];
};

const moveInList = (delta) => {
  const rows = listRows();
  if (rows.length === 0) return;
  const current = document.activeElement?.closest('[data-kb-row]');
  const index = current ? rows.indexOf(current) : -1;
  const next = rows[Math.min(rows.length - 1, Math.max(0, index + delta))];
  if (next) {
    next.focus();
    next.scrollIntoView({ block: 'nearest' });
  }
};

const sidebarItems = () =>
  [...document.querySelectorAll('.sidebar .sidebar-item a, .sidebar .sidebar-item button')];

const focusSidebar = () => {
  if (!isDesktop()) return;
  const items = sidebarItems();
  if (items.length === 0) return;
  const currentHash = window.location.hash || '#home';
  const active = items.find((a) => a.getAttribute('href') === currentHash);
  (active || items[0]).focus();
};

const moveInSidebar = (delta) => {
  const items = sidebarItems();
  const index = items.indexOf(document.activeElement);
  if (index === -1) return;
  const next = items[Math.min(items.length - 1, Math.max(0, index + delta))];
  next?.focus();
};

const focusMain = () => {
  if (!isDesktop()) return;
  if (!focusFirst('[data-primary-list] [data-kb-row]')) {
    document.querySelector('.main-content')?.focus();
  }
};

export const installShortcuts = ({ openHelp }) => {
  let pendingPrefix = null;
  let prefixTimer = null;

  const clearPrefix = () => {
    pendingPrefix = null;
    if (prefixTimer) clearTimeout(prefixTimer);
    prefixTimer = null;
  };

  const onKeyDown = (event) => {
    // Escape serves the overlay stack from anywhere, including inputs.
    if (event.key === 'Escape' && overlayStack.length > 0) {
      event.preventDefault();
      overlayStack[overlayStack.length - 1]();
      return;
    }
    if (overlayStack.length > 0) return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (isTypingTarget(event.target)) return;

    // Escape with no overlay open: collapse the focused expanded row.
    if (event.key === 'Escape') {
      const expanded = document.activeElement?.closest('[aria-expanded="true"][role="button"]');
      if (expanded) {
        event.preventDefault();
        expanded.click();
        expanded.focus();
      }
      return;
    }

    // Enter on a j/k-focused row that is not itself a button (e.g. a feed
    // post card): delegate to the row's designated primary action. Only
    // when the row ITSELF is focused — Enter on a nested button must not
    // double-fire.
    if (event.key === 'Enter') {
      const row = event.target;
      if (
        row instanceof Element &&
        row.hasAttribute('data-kb-row') &&
        !row.matches('[role="button"], button, a')
      ) {
        row.querySelector('[data-kb-enter]')?.click();
      }
      return;
    }

    const inSidebar = !!event.target.closest?.('.sidebar');

    if (pendingPrefix === 'g') {
      clearPrefix();
      const hash = GO_TARGETS[event.key];
      if (hash) {
        event.preventDefault();
        window.location.hash = hash;
      }
      return;
    }

    switch (event.key) {
      case 'g':
        pendingPrefix = 'g';
        prefixTimer = setTimeout(clearPrefix, SEQUENCE_TIMEOUT_MS);
        return;
      case '/':
        event.preventDefault();
        goToSearch();
        return;
      case '?':
        event.preventDefault();
        openHelp();
        return;
      case 'j':
        moveInList(1);
        return;
      case 'k':
        moveInList(-1);
        return;
      case 'ArrowLeft':
        if (!inSidebar) {
          event.preventDefault();
          focusSidebar();
        }
        return;
      case 'ArrowRight':
        if (inSidebar) {
          event.preventDefault();
          focusMain();
        }
        return;
      case 'ArrowDown':
        if (inSidebar) {
          event.preventDefault();
          moveInSidebar(1);
        }
        return;
      case 'ArrowUp':
        if (inSidebar) {
          event.preventDefault();
          moveInSidebar(-1);
        }
        return;
      default:
        return;
    }
  };

  window.addEventListener('keydown', onKeyDown);
  return () => {
    clearPrefix();
    window.removeEventListener('keydown', onKeyDown);
  };
};
