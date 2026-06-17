// Smoke: a tier>=2 user creates a group via the UI, lands on its page (1 member,
// Feed tab active), and the membership toggle on the page leaves -> 0 and re-joins -> 1.
const { test, expect } = require('@playwright/test');
const { createUser, apiFetch, cleanupUsers, dbQuery, SOLID_URL } = require('./helpers/solidMessaging');

const created = [];
test.afterAll(async () => cleanupUsers(created));

test('create a group (tier>=2), it opens, and membership toggles', async ({ page }) => {
  const owner = await createUser('cguiowner');
  created.push(owner);
  dbQuery(`UPDATE users SET verification_tier = 2 WHERE id = ${owner.id}`);
  const topics = (await apiFetch('/api/topics')).body.topics;
  await apiFetch('/api/users/me/topics', { method: 'PUT', token: owner.token, body: JSON.stringify({ topicIds: topics.slice(0, 3).map((t) => t.id) }) });

  await page.addInitScript((t) => localStorage.setItem('token', t), owner.token);
  await page.goto(`${SOLID_URL}/#groups`, { waitUntil: 'networkidle' });

  await page.getByRole('button', { name: '+ New group' }).click();
  const unique = `Smoke Group ${Date.now()}`;
  await page.locator('.group-create-input').first().fill(unique);
  await page.locator('select.group-create-input').selectOption(String(topics[0].id));
  await page.getByRole('button', { name: 'Create group' }).click();

  await expect(page.locator('.group-detail-name')).toHaveText(unique, { timeout: 15000 });
  await expect(page.locator('.group-detail-actions')).toContainText('1 member');
  await expect(page.locator('.group-tab.on')).toHaveText('Feed');

  const memberBtn = page.locator('.group-detail-actions .group-join');
  await expect(memberBtn).toHaveText('Joined ✓');
  await memberBtn.click();
  await expect(memberBtn).toHaveText('Join', { timeout: 10000 });
  await expect(page.locator('.group-detail-actions')).toContainText('0 members');
  await memberBtn.click();
  await expect(memberBtn).toHaveText('Joined ✓', { timeout: 10000 });
  await expect(page.locator('.group-detail-actions')).toContainText('1 member');

  await page.locator('.group-detail-card').screenshot({ path: '/tmp/group-page.png' });
});
