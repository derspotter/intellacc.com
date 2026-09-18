const { selectFeedPosts } = require('../src/utils/feedSelection');

describe('feed inclusion without reordering', () => {
  const posts = [
    { id: 5, like_count: 1, author_accuracy: 95 },
    { id: 4, like_count: 20, author_accuracy: 10 },
    { id: 3, like_count: 10, author_accuracy: 15 },
    { id: 2, like_count: 100, author_accuracy: 20 }
  ];
  test('likes select the top two, but the newer selected post comes first', () => {
    expect(selectFeedPosts(posts, { likes: 100 }, 2).map(p => p.id)).toEqual([4, 2]);
    expect(posts.map(p => p.id)).toEqual([5, 4, 3, 2]);
  });
  test('changing the weights changes membership rather than sorting', () => {
    expect(selectFeedPosts(posts, { accuracy: 100 }, 2).map(p => p.id)).toEqual([5, 2]);
  });
  test('no saved weights returns the newest posts without filtering', () => {
    expect(selectFeedPosts(posts, null, 2).map(p => p.id)).toEqual([5, 4]);
  });
  test('small feeds retain every post and ties prefer newer posts', () => {
    expect(selectFeedPosts(posts, { likes: 100 }, 20)).toEqual(posts);
    expect(selectFeedPosts([{ id: 3 }, { id: 2 }, { id: 1 }], { likes: 100 }, 2).map(p => p.id)).toEqual([3, 2]);
  });
});
