// Smoke (sub-project C): a member sends a chat message and sees it appear (realtime).
const { test, expect } = require('@playwright/test');
const { createUser, apiFetch, cleanupUsers, dbQuery, SOLID_URL } = require('./helpers/solidMessaging');

const created = [];
test.afterAll(async () => cleanupUsers(created));

test('member chats in a group (message appears live)', async ({ page }) => {
  const owner = await createUser('gchat');
  created.push(owner);
  dbQuery(`UPDATE users SET verification_tier = 2, email_verified_at = NOW() WHERE id = ${owner.id}`);
  const topics = (await apiFetch('/api/topics')).body.topics;
  await apiFetch('/api/users/me/topics', { method: 'PUT', token: owner.token, body: JSON.stringify({ topicIds: topics.slice(0, 3).map((t) => t.id) }) });
  const g = (await apiFetch('/api/groups', { method: 'POST', token: owner.token, body: JSON.stringify({ name: `Chat UI ${Date.now()}`, description: '', topic_id: topics[0].id }) })).body.group;

  await page.addInitScript((t) => localStorage.setItem('token', t), owner.token);
  await page.goto(`${SOLID_URL}/#group/${g.slug}`, { waitUntil: 'networkidle' });
  await expect(page.locator('.group-detail-name')).toBeVisible({ timeout: 15000 });

  await page.getByRole('button', { name: 'Chat', exact: true }).click();
  await expect(page.locator('.group-chat-list')).toBeVisible({ timeout: 10000 });

  const msg = `live message ${Date.now()}`;
  await page.locator('.group-chat-input').fill(msg);
  await page.locator('.group-chat-form .button').click();
  await expect(page.locator('.group-chat-list')).toContainText(msg, { timeout: 15000 });
  await page.locator('.group-detail-card').screenshot({ path: '/tmp/group-chat.png' });
});
