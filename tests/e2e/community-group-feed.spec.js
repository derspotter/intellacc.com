// Smoke (sub-project B): a group member posts on the Feed tab and sees it appear.
const { test, expect } = require('@playwright/test');
const { createUser, apiFetch, cleanupUsers, dbQuery, provisionTopics, SOLID_URL } = require('./helpers/solidMessaging');

const created = [];
test.afterAll(async () => cleanupUsers(created));

test('member posts into a group on the Feed tab', async ({ page }) => {
  const owner = await createUser('gfeed');
  created.push(owner);
  await provisionTopics(owner);
  dbQuery(`UPDATE users SET verification_tier = 2, email_verified_at = NOW() WHERE id = ${owner.id}`);
  const topics = (await apiFetch('/api/topics')).body.topics;
  await apiFetch('/api/users/me/topics', { method: 'PUT', token: owner.token, body: JSON.stringify({ topicIds: topics.slice(0, 3).map((t) => t.id) }) });
  const g = (await apiFetch('/api/groups', { method: 'POST', token: owner.token, body: JSON.stringify({ name: `Feed UI ${Date.now()}`, description: '', topic_id: topics[0].id }) })).body.group;

  await page.addInitScript((t) => localStorage.setItem('token', t), owner.token);
  await page.goto(`${SOLID_URL}/#group/${g.slug}`, { waitUntil: 'networkidle' });
  await expect(page.locator('.group-detail-name')).toBeVisible({ timeout: 15000 });

  const text = `hello group ${Date.now()}`;
  await page.locator('.group-feed-body .comment-input').fill(text);
  await page.locator('.group-feed-body .submit-button').click();

  await expect(page.locator('.group-feed-body .posts-list')).toContainText(text, { timeout: 15000 });
  await page.locator('.group-detail-card').screenshot({ path: '/tmp/group-feed.png' });
});
