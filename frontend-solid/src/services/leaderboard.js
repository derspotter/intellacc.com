// Shared leaderboard fetch wiring used by both skins (van LeaderboardCard and
// terminal LeaderboardView): one tab -> endpoint mapping, one response shape.
import {
  getLeaderboardFollowers,
  getLeaderboardFollowing,
  getLeaderboardGlobal,
  getLeaderboardNetwork
} from './api';
import { shapeLeaderboardEntries } from '../lib/leaderboard';

export const LEADERBOARD_TABS = [
  { key: 'global', label: 'Global' },
  { key: 'followers', label: 'Followers' },
  { key: 'following', label: 'Following' },
  { key: 'network', label: 'Network' }
];

const FETCHERS = {
  global: getLeaderboardGlobal,
  followers: getLeaderboardFollowers,
  following: getLeaderboardFollowing,
  network: getLeaderboardNetwork
};

// Fetch one leaderboard tab and normalize the response to an entry list.
// Unknown tabs resolve to an empty list (parity with the van card's chain).
export async function fetchLeaderboardRows(tab, limit) {
  const fetcher = FETCHERS[tab];
  const res = fetcher ? await fetcher(limit) : [];
  return shapeLeaderboardEntries(res);
}
