// Smoke (sub-project D): owner pins a market via search, sees the card, unpins it.
const { test, expect } = require('@playwright/test');
const { createUser, apiFetch, cleanupUsers, dbQuery, SOLID_URL, provisionTopics } = require('./helpers/solidMessaging');

const created = [];
let eventId;
test.afterAll(async () => {
  if (eventId) dbQuery(`DELETE FROM events WHERE id = ${eventId}`);
  await cleanupUsers(created);
});

test('owner pins and unpins a market on the Markets tab', async ({ page }) => {
  const owner = await createUser('gmui');
  created.push(owner);
  await provisionTopics(owner);
  dbQuery(`UPDATE users SET verification_tier = 2, email_verified_at = NOW() WHERE id = ${owner.id}`);
  const topics = (await apiFetch('/api/topics')).body.topics;
  await apiFetch('/api/users/me/topics', { method: 'PUT', token: owner.token, body: JSON.stringify({ topicIds: topics.slice(0, 3).map((t) => t.id) }) });
  const g = (await apiFetch('/api/groups', { method: 'POST', token: owner.token, body: JSON.stringify({ name: `Markets UI ${Date.now()}`, description: '', topic_id: topics[0].id }) })).body.group;
  const title = `ZZPINME ${Date.now()}`;
  eventId = Number(dbQuery(`INSERT INTO events (title, details, closing_date, event_type, category) VALUES ('${title}','d',NOW()+INTERVAL '30 days','binary','test') RETURNING id`)[0].id);

  await page.addInitScript((t) => localStorage.setItem('token', t), owner.token);
  await page.goto(`${SOLID_URL}/#group/${g.slug}`, { waitUntil: 'networkidle' });
  await expect(page.locator('.group-detail-name')).toBeVisible({ timeout: 15000 });
  await page.getByRole('button', { name: 'Markets', exact: true }).click();

  await page.locator('.group-markets-pin .group-create-input').fill('ZZPINME');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await page.locator('.group-markets-result .group-join').first().click();

  await expect(page.locator('.group-markets-list')).toContainText(title, { timeout: 15000 });
  await page.locator('.group-detail-card').screenshot({ path: '/tmp/group-markets.png' });

  await page.locator('.group-market-unpin').first().click();
  await expect(page.locator('.group-markets-list')).not.toContainText(title, { timeout: 10000 });
});
