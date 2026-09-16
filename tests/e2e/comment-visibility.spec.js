const { test, expect } = require('@playwright/test');

test('posted comments and replies stay visible after count updates', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('token', `test.${btoa(JSON.stringify({
    userId: 101, exp: Math.floor(Date.now() / 1000) + 3600
  }))}.test`));
  let nextId = 1000;
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/posts') {
      return route.fulfill({ json: {
        ...request.postDataJSON(), id: nextId++, user_id: 101,
        username: 'fixture_user', comment_count: 0
      } });
    }
    return route.fulfill({ json: [] });
  });
  await page.goto('/#__harness');
  const post = page.locator('[data-harness="postitem"] .posts-list > article').first();
  // Start with the thread collapsed: only open the composer.
  await post.getByRole('button', { name: 'Comment', exact: true }).click();
  await post.locator('textarea.comment-input').fill('Visible after posting');
  await post.getByRole('button', { name: 'Post comment', exact: true }).click();
  const comment = post.locator('.comments-list > li > article').first();
  await expect(comment).toContainText('Visible after posting');
  await expect(comment).toBeVisible();
  await expect(post.locator('.post-header-comments').first()).toHaveText('3 comments');

  await comment.getByRole('button', { name: 'Comment', exact: true }).click();
  await comment.locator('textarea.comment-input').fill('Visible nested reply');
  await comment.getByRole('button', { name: 'Post comment', exact: true }).click();
  await expect(comment.getByText('Visible nested reply', { exact: true })).toBeVisible();

  // A second submission must preserve the existing open reply thread too.
  await post.getByRole('button', { name: 'Comment', exact: true }).first().click();
  await post.locator('textarea.comment-input').fill('Second visible comment');
  await post.getByRole('button', { name: 'Post comment', exact: true }).click();
  await expect(post.getByText('Second visible comment', { exact: true })).toBeVisible();
  await expect(post.getByText('Visible nested reply', { exact: true })).toBeVisible();
});
