import { lazy } from 'solid-js';

// Terminal-native full-screen views, keyed by hash route segment.
// Later parity phases (profile, settings, ...) extend this map only.
export const TERMINAL_VIEWS = {
  leaderboard: {
    title: 'LEADERBOARD',
    component: lazy(() => import('./LeaderboardView'))
  }
};
