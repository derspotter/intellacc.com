// Terminal notifications view: list renders, mark-all clears unread badge.
const { test, expect } = require('@playwright/test');
const { createUser, cleanupUsers, provisionTier, apiFetch, SOLID_URL } = require('./helpers/solidMessaging');

const created = [];
test.afterAll(async () => cleanupUsers(created));

test('notifications list + mark all read', async ({ page }) => {
  const a = await createUser('tnotif1a'); // viewer
  const b = await createUser('tnotif1b'); // actor
  created.push(a, b);
  provisionTier(a);
  provisionTier(b);

  // Seed: a posts once; b likes it -> a gets a 'like' notification.
  const post = await apiFetch('/api/posts', {
    method: 'POST', token: a.token,
    body: JSON.stringify({ content: 'terminal notifications seed post' })
  });
  expect([200, 201]).toContain(post.response.status);
  const postId = post.body?.id || post.body?.post?.id;
  expect(postId).toBeTruthy();
  const like = await apiFetch(`/api/posts/${postId}/like`, { method: 'POST', token: b.token });
  expect([200, 201]).toContain(like.response.status);

  await page.addInitScript((t) => localStorage.setItem('token', t), a.token);
  await page.goto(`${SOLID_URL}/?skin=terminal#notifications`, { waitUntil: 'domcontentloaded' });
  const view = page.locator('[data-view="notifications"]');
  await expect(view).toBeVisible({ timeout: 15000 });

  const rows = view.locator('[data-testid="notification-row"]');
  await expect(rows.first()).toBeVisible({ timeout: 10000 });
  await expect(view.locator('[data-testid="notifications-unread"]')).toContainText(/[1-9]/);

  await view.locator('[data-testid="notifications-mark-all"]').click();
  await expect(view.locator('[data-testid="notifications-unread"]')).toContainText('0', { timeout: 10000 });
});
