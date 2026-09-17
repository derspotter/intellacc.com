// Mocked API only: safe to run against an isolated frontend build.
const { test, expect } = require('@playwright/test');
const BASE = process.env.E2E_BASE_URL || 'http://127.0.0.1:4189';

for (const skin of ['van', 'terminal']) {
test(`${skin}: assigned market is visible, declines without staking, and refreshes after a proposal`, async ({ page }) => {
  let assignments = [{ id: 1, event_id: 4319, event_title: 'Review this closed market', expires_at: '2030-01-01T12:00:00Z' }];
  const writes = [];
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() !== 'GET') writes.push(path);
    let data = [];
    if (path.endsWith('/assignment-queue')) data = assignments;
    if (path.endsWith('/users/me/topics')) data = { topicIds: [1, 2, 3] };
    if (path.endsWith('/resolution-proposals/config')) data = { proposerStakeRp: 50, proposerRewardRp: 10 };
    if (path.endsWith('/users/profile')) data = { id: 999, userId: 999, username: 'reviewer', verification_tier: 2 };
    if (path.endsWith('/assignments/1/decline')) assignments = [];
    await route.fulfill({ json: data });
  });
  await page.addInitScript(() => {
    localStorage.setItem('token', `e30.${btoa(JSON.stringify({ userId: 999, role: 'user', exp: 4000000000 }))}.test`);
  });
  await page.goto(`${BASE}/?skin=${skin}#predictions`);
  const queue = page.getByRole('region', { name: 'Your resolution assignments' });
  await expect(queue).toBeVisible();
  await expect(queue).toContainText('Submitting a proposal stakes 50 RP');
  await expect(queue.getByRole('link', { name: 'Review market' })).toHaveAttribute('href', '#predictions/4319');
  expect(writes.filter((path) => path.includes('resolution-proposals'))).toEqual([]);
  await queue.getByRole('button', { name: 'Decline', exact: true }).click();
  await expect(queue).toHaveCount(0);
  expect(writes.filter((path) => path.includes('resolution-proposals'))).toEqual(['/api/resolution-proposals/assignments/1/decline']);
  assignments = [{ id: 2, event_id: 2912, event_title: 'Another assigned market', expires_at: '2030-01-01T12:00:00Z' }];
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(queue).toContainText('Another assigned market');
  assignments = [];
  await page.evaluate(() => window.dispatchEvent(new Event('resolution-proposal-created')));
  await expect(queue).toHaveCount(0);
});

}

test('queue failures are visible and can be retried', async ({ page }) => {
  let fail = true;
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/assignment-queue') && fail) {
      return route.fulfill({ status: 503, json: { message: 'Assignments temporarily unavailable' } });
    }
    await route.fulfill({ json: path.endsWith('/users/me/topics') ? { topicIds: [1, 2, 3] } : [] });
  });
  await page.addInitScript(() => {
    localStorage.setItem('token', `e30.${btoa(JSON.stringify({ userId: 999, exp: 4000000000 }))}.test`);
  });
  await page.goto(`${BASE}/#predictions`);
  const queue = page.getByRole('region', { name: 'Your resolution assignments' });
  await expect(queue.getByRole('alert')).toBeVisible();
  fail = false;
  await queue.getByRole('button', { name: 'Retry' }).click();
  await expect(queue).toHaveCount(0);
});
