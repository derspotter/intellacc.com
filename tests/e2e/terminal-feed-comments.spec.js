const { test, expect } = require('@playwright/test');
const { createUser, cleanupUsers, provisionTier, apiFetch, SOLID_URL } = require('./helpers/solidMessaging');

const created = [];
test.afterAll(async () => cleanupUsers(created));

test('expand comments and add one inline', async ({ page }) => {
  const u = await createUser('tcmt1');
  created.push(u);
  provisionTier(u);

  const post = await apiFetch('/api/posts', {
    method: 'POST', token: u.token,
    body: JSON.stringify({ content: 'terminal comments seed post' })
  });
  const postId = post.body?.id || post.body?.post?.id;
  expect(postId).toBeTruthy();

  await page.addInitScript((t) => localStorage.setItem('token', t), u.token);
  await page.goto(`${SOLID_URL}/?skin=terminal#home`, { waitUntil: 'domcontentloaded' });
  const post0 = page.locator('[data-testid="feed-post"]', { hasText: 'terminal comments seed post' }).first();
  await expect(post0).toBeVisible({ timeout: 20000 });

  await post0.locator('[data-testid="post-comments-toggle"]').click();
  const input = post0.locator('[data-testid="comment-input"]');
  await expect(input).toBeVisible({ timeout: 10000 });
  await input.fill('terminal inline comment');
  await input.press('Enter');

  await expect(post0.locator('[data-testid="comment-row"]', { hasText: 'terminal inline comment' }))
    .toBeVisible({ timeout: 10000 });
  await expect(post0.locator('[data-testid="post-comments-toggle"]')).toContainText('CMT:1');
});

test('repost embeds the original in the feed', async ({ page }) => {
  const u = await createUser('trt1');
  created.push(u);
  provisionTier(u);

  const post = await apiFetch('/api/posts', {
    method: 'POST', token: u.token,
    body: JSON.stringify({ content: 'terminal repost original' })
  });
  expect(post.body?.id || post.body?.post?.id).toBeTruthy();

  await page.addInitScript((t) => localStorage.setItem('token', t), u.token);
  await page.goto(`${SOLID_URL}/?skin=terminal#home`, { waitUntil: 'domcontentloaded' });
  const original = page.locator('[data-testid="feed-post"]', { hasText: 'terminal repost original' }).first();
  await expect(original).toBeVisible({ timeout: 20000 });

  await original.locator('[data-testid="post-repost"]').click();
  await expect(page.locator('[data-testid="repost-embed"]', { hasText: 'terminal repost original' }).first())
    .toBeVisible({ timeout: 10000 });
});
