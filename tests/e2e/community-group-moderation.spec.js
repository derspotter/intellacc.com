// Smoke (sub-project E): owner kicks a member from the Members tab (count drops).
// (Report endpoint + form are covered by the backend test; the report UI gate
// can't be cleanly exercised in one shared browser context.)
const { test, expect } = require('@playwright/test');
const { createUser, apiFetch, cleanupUsers, dbQuery, SOLID_URL } = require('./helpers/solidMessaging');

const created = [];
test.afterAll(async () => cleanupUsers(created));

test('owner kicks a member from the Members tab', async ({ page }) => {
  const owner = await createUser('gmodui_o');
  const member = await createUser('gmodui_m');
  created.push(owner, member);
  dbQuery(`UPDATE users SET verification_tier = 2, email_verified_at = NOW() WHERE id IN (${owner.id}, ${member.id})`);
  const topics = (await apiFetch('/api/topics')).body.topics;
  await apiFetch('/api/users/me/topics', { method: 'PUT', token: owner.token, body: JSON.stringify({ topicIds: topics.slice(0, 3).map((t) => t.id) }) });
  const g = (await apiFetch('/api/groups', { method: 'POST', token: owner.token, body: JSON.stringify({ name: `Mod UI ${Date.now()}`, description: '', topic_id: topics[0].id }) })).body.group;
  await apiFetch(`/api/groups/${g.id}/membership`, { method: 'POST', token: member.token }); // member joins -> 2

  await page.addInitScript((t) => localStorage.setItem('token', t), owner.token);
  await page.goto(`${SOLID_URL}/#group/${g.slug}`, { waitUntil: 'networkidle' });
  await expect(page.locator('.group-detail-actions')).toContainText('2 members', { timeout: 15000 });
  await page.getByRole('button', { name: 'Members', exact: true }).click();
  await expect(page.locator('.group-members')).toContainText(`@${member.username}`, { timeout: 10000 });
  await page.locator('.group-member-row', { hasText: member.username }).getByRole('button', { name: 'Remove' }).click();
  await expect(page.locator('.group-members')).not.toContainText(`@${member.username}`, { timeout: 10000 });
  await expect(page.locator('.group-detail-actions')).toContainText('1 member');
  await page.locator('.group-detail-card').screenshot({ path: '/tmp/group-members.png' });
});
