import { lazy } from 'solid-js';

// Terminal-native full-screen views, keyed by hash route segment.
// Later parity phases (profile, settings, ...) extend this map only.
export const TERMINAL_VIEWS = {
  leaderboard: {
    title: 'LEADERBOARD',
    component: lazy(() => import('./LeaderboardView'))
  },
  profile: {
    title: 'PROFILE',
    component: lazy(() => import('./ProfileView'))
  },
  user: {
    title: 'PROFILE',
    hidden: true, // reached via #user/:id links, not the palette
    component: lazy(() => import('./ProfileView'))
  },
  notifications: {
    title: 'NOTIFICATIONS',
    component: lazy(() => import('./NotificationsView'))
  }
};
