import van from 'vanjs-core';

// Reactive states for device detection
export const isMobile = van.state(window.innerWidth < 768);
export const isTablet = van.state(window.innerWidth >= 768 && window.innerWidth < 1024);
export const isDesktop = van.state(window.innerWidth >= 1024);

// Update states on window resize
let resizeTimeout;
window.addEventListener('resize', () => {
  // Debounce resize events for performance
  clearTimeout(resizeTimeout);
  resizeTimeout = setTimeout(() => {
    const width = window.innerWidth;
    isMobile.val = width < 768;
    isTablet.val = width >= 768 && width < 1024;
    isDesktop.val = width >= 1024;
  }, 150);
});

// Helper function to check if device has touch capability
export const hasTouch = () => {
  return 'ontouchstart' in window || navigator.maxTouchPoints > 0;
};

// Helper to get current breakpoint as string
export const getBreakpoint = () => {
  if (isMobile.val) return 'mobile';
  if (isTablet.val) return 'tablet';
  return 'desktop';
};