const SIGNALS = {
  accuracy: 'author_accuracy', followers: 'author_followers',
  likes: 'like_count', views: 'view_count'
};

// Candidates arrive newest first. Scores select membership only, never order.
function selectFeedPosts(candidates, weights, limit) {
  if (!weights || candidates.length <= limit) return candidates.slice(0, limit);
  const scores = candidates.map(() => 0);
  for (const [key, field] of Object.entries(SIGNALS)) {
    const weight = Number(weights[key]) || 0;
    if (weight <= 0) continue;
    const values = candidates.map(post => {
      const raw = Number(post[field]);
      const value = Number.isFinite(raw) ? Math.max(0, raw) : 0;
      return key === 'accuracy' ? value : Math.log1p(value);
    });
    const min = Math.min(...values);
    const span = Math.max(...values) - min;
    if (span > 0) values.forEach((value, i) => { scores[i] += weight * (value - min) / span; });
  }
  const selected = new Set(candidates.map((_, i) => i)
    .sort((a, b) => scores[b] - scores[a] || a - b).slice(0, limit));
  return candidates.filter((_, i) => selected.has(i));
}

module.exports = { selectFeedPosts };
