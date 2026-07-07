// Smoke: #network exploration controls reactively update the stats. The WebGL
// graph render itself stays out of the visual net (animated). See
// docs/superpowers/specs/2026-06-14-graph-exploration-controls-design.md
const { test, expect } = require('@playwright/test');
const { createUser, apiFetch, cleanupUsers, provisionTopics, SOLID_URL } = require('./helpers/solidMessaging');

const created = [];
test.afterAll(async () => cleanupUsers(created));

const shown = (s) => Number(s.match(/showing (\d+) \/ (\d+)/)[1]);
const total = (s) => Number(s.match(/showing (\d+) \/ (\d+)/)[2]);

test('network controls filter and reset the stats', async ({ page }) => {
  const u = await createUser('netsmoke');
  await provisionTopics(u);
  created.push(u);
  const topics = (await apiFetch('/api/topics')).body.topics;
  await apiFetch('/api/users/me/topics', { method: 'PUT', token: u.token, body: JSON.stringify({ topicIds: topics.slice(0, 3).map((t) => t.id) }) });
  await page.addInitScript((t) => localStorage.setItem('token', t), u.token);
  await page.goto(`${SOLID_URL}/#network`, { waitUntil: 'networkidle' });

  const stat = page.locator('[data-testid="graph-stats"]');
  await expect(stat).toBeVisible({ timeout: 15000 });
  const base = await stat.textContent();
  expect(shown(base)).toBeLessThanOrEqual(total(base));

  // Largest-cluster-only never shows more than all.
  await page.getByText('Largest cluster only').click();
  await page.waitForTimeout(400);
  const clustered = await stat.textContent();
  expect(shown(clustered)).toBeLessThanOrEqual(shown(base));

  // Reset restores the baseline shown count.
  await page.getByRole('button', { name: 'Reset view' }).click();
  await page.waitForTimeout(400);
  expect(shown(await stat.textContent())).toEqual(shown(base));
});
