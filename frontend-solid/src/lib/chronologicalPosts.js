// Match the API's newest-first order, including newly inserted or paged posts.
export function chronologicalPosts(posts) {
  if (!Array.isArray(posts)) return [];
  const timestamp = (post) => Date.parse(post.created_at) || 0;
  return [...posts].sort((a, b) =>
    timestamp(b) - timestamp(a) || (Number(b.id) - Number(a.id)) || 0
  );
}
