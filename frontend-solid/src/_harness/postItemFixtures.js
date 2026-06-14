// Deterministic PostItem fixtures for the visual harness. Fixed created_at and
// counts so the rendered timestamp/like/comment text never changes between runs.
const BASE = {
  id: 1,
  user_id: 101,
  username: 'fixture_user',
  content: 'A short baseline post.',
  created_at: '2026-01-01T00:00:00Z',
  like_count: 3,
  comment_count: 2,
  liked_by_user: false,
  avatar_url: null,
  image_url: null,
  image_attachment_id: null,
  reposted_post: null,
  ai_is_flagged: false,
  ai_probability: null,
  ai_detected_model: null
};

export const postItemFixtures = [
  { ...BASE, id: 1, content: 'A short baseline post.' },
  {
    ...BASE,
    id: 2,
    content:
      'A long, multi-line baseline post. ' +
      'It wraps across several lines so we catch any regression in line-height, ' +
      'card padding, or the global button rule affecting action buttons. ' +
      'Forecasting is a skill you can train; calibration beats confidence.'
  },
  {
    ...BASE,
    id: 3,
    content: 'This post reposts another.',
    reposted_post: {
      id: 99,
      user_id: 102,
      username: 'original_author',
      content: 'The original post being reposted.',
      avatar_url: null
    }
  },
  {
    ...BASE,
    id: 4,
    content: 'A post flagged by AI analysis.',
    ai_is_flagged: true,
    ai_probability: 0.92,
    ai_detected_model: 'gpt-x'
  },
  { ...BASE, id: 5, content: 'A post with high engagement.', like_count: 1234, comment_count: 567 }
];
