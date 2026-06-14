// Smoke: the profile Network card renders actionable+informative follower rows
// (accuracy/follower metadata + a working Follow/Unfollow). The list is dynamic
// and loaded on demand, so it stays out of the pixel visual net. See
// docs/superpowers/specs/2026-06-14-follower-following-lists-v2-design.md
const { test, expect } = require('@playwright/test');
const { createUser, apiFetch, cleanupUsers, SOLID_URL } = require('./helpers/solidMessaging');

const created = [];
test.afterAll(async () => cleanupUsers(created));

const followAs = (targetId, token) =>
  apiFetch(`/api/users/${targetId}/follow`, { method: 'POST', token });

test('follower/following rows show metadata and a working Follow toggle', async ({ page }) => {
  const a = await createUser('rowa');
  const b = await createUser('rowb');
  created.push(a, b);

  // b follows a (a's followers = [b]); a follows b (a's following = [b]).
  await followAs(a.id, b.token);
  await followAs(b.id, a.token);

  // Assign topics so the onboarding gate doesn't intercept the profile route.
  const topics = (await apiFetch('/api/topics')).body.topics;
  const topicIds = topics.slice(0, 3).map((t) => t.id);
  await apiFetch('/api/users/me/topics', { method: 'PUT', token: a.token, body: JSON.stringify({ topicIds }) });

  await page.addInitScript((t) => localStorage.setItem('token', t), a.token);
  await page.goto(`${SOLID_URL}/#profile`, { waitUntil: 'networkidle' });

  await page.getByRole('button', { name: 'Load Network Data' }).click();

  // Following tab: b should appear with metadata and an Unfollow button (a follows b).
  await page.getByRole('button', { name: /Following:/ }).click();
  const followingRow = page.locator('.following-tab .network-user-row').filter({ hasText: b.username });
  await expect(followingRow).toBeVisible({ timeout: 15000 });
  await expect(followingRow.locator('.network-user-followers')).toContainText('followers');
  const toggle = followingRow.locator('.network-user-follow');
  await expect(toggle).toHaveText('Unfollow');

  // Clicking it unfollows: label flips to Follow and persists across a tab switch.
  await toggle.click();
  await expect(toggle).toHaveText('Follow', { timeout: 10000 });
  await page.getByRole('button', { name: /Followers:/ }).click();
  await page.getByRole('button', { name: /Following:/ }).click();
  await expect(page.locator('.following-tab .network-user-row').filter({ hasText: b.username }).locator('.network-user-follow')).toHaveText('Follow');
});
