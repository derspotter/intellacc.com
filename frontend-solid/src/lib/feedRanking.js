export const KEYS = ['accuracy', 'followers', 'likes', 'views'];

// Recompute the four weights when one slider is dragged.
// weights/locks: objects keyed by KEYS; key: dragged key; value: desired 0-100.
// Locked sliders never move; the dragged slider clamps to [0, 100 - sum(locked)];
// the remaining budget is split among the unlocked, non-dragged sliders
// proportionally to their current values (equal split if all zero). Integer
// result summing to exactly 100 via largest-remainder rounding.
export function redistribute(weights, locks, key, value) {
  if (locks[key]) return { ...weights };
  const lockedSum = KEYS.filter((k) => k !== key && locks[k]).reduce((s, k) => s + weights[k], 0);
  const maxForKey = 100 - lockedSum;
  const v = Math.round(Math.max(0, Math.min(maxForKey, value)));

  const out = { ...weights };
  out[key] = v;
  for (const k of KEYS) if (k !== key && locks[k]) out[k] = weights[k];

  const free = KEYS.filter((k) => k !== key && !locks[k]);
  if (free.length === 0) {
    out[key] = maxForKey;
    return out;
  }

  const budget = maxForKey - v;
  const freeSum = free.reduce((s, k) => s + weights[k], 0);
  const raw = {};
  for (const k of free) raw[k] = freeSum > 0 ? budget * (weights[k] / freeSum) : budget / free.length;

  let used = 0;
  for (const k of free) { out[k] = Math.floor(raw[k]); used += out[k]; }
  let remainder = budget - used;
  const byFrac = [...free].sort((a, b) => (raw[b] - Math.floor(raw[b])) - (raw[a] - Math.floor(raw[a])));
  for (let i = 0; i < remainder; i++) out[byFrac[i % byFrac.length]] += 1;
  return out;
}

// Stub placeholder for rankPosts - will be implemented in Task 5
export function rankPosts(posts, weights) {
  return [];
}
