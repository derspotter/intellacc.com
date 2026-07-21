// Pure leaderboard shaping shared by the van skin's LeaderboardCard and the
// terminal skin's LeaderboardView. Dependency-free (see leaderboard.test.js).

// The leaderboard endpoints answer either a bare array or an envelope
// { leaderboard: [...] }; normalize to a list without ever returning
// null/undefined.
export function shapeLeaderboardEntries(res) {
  return Array.isArray(res?.leaderboard) ? res.leaderboard : (res || []);
}

// RP values render with two decimals; anything non-numeric shows as 0.00.
export function formatReputation(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(2) : '0.00';
}
