const { test, expect } = require('@playwright/test');
for (const skin of ['van', 'terminal']) {
 test(`${skin}: overview, publication and resolution`, async ({ page }) => {
  const writes = [];
  let published = false;
  let resolved = false;
  await page.route('**/api/**', async (route) => {
    const u = new URL(route.request().url());
    const path = u.pathname;
    let data = [];
    if (route.request().method() !== 'GET') writes.push({ path, body: route.request().postDataJSON() });
    if (path.endsWith('/users/profile')) data = { id: 999, role: 'admin', username: 'admin', verification_tier: 3 };
    if (path.endsWith('/users/me/topics')) data = { topicIds: [1,2,3] };
    if (path.endsWith('/proposals/9/publish')) { published = true; data = { approved_event_id: 90 }; }
    if (path.endsWith('/events/90') && route.request().method() === 'PATCH') { resolved = true; data = {}; }
    if (path.endsWith('/admin/markets')) {
      const proposals = [{ id: 9, title: 'Expired proposal awaiting admin', creator_username: 'author', event_type: 'binary', closing_date: '2026-01-01T00:00:00Z', details: 'Resolve using official data.', approvals: 0, rejections: 0 }];
      const closed = [{ id: 90, title: 'Visible closed market', event_type: 'binary', closing_date: '2026-01-01T00:00:00Z', details: 'The official result decides YES or NO.' }];
      const isProposal = u.searchParams.get('queue') === 'proposals';
      const items = isProposal ? published ? [] : proposals : resolved ? [] : closed;
      data = { summary: { proposals: published ? 0 : 1, closed: resolved ? 0 : 1, expired_proposals: published ? 0 : 1 }, items, total: items.length, offset: 0, limit: 25 };
    }
    await route.fulfill({ json: data });
  });
  await page.addInitScript(() => localStorage.setItem('token', `e30.${btoa(JSON.stringify({ userId: 999, role: 'admin', exp: 4000000000 }))}.test`));
  await page.goto(`http://127.0.0.1:4192/?skin=${skin}#predictions/admin`);
  const dashboard = page.getByRole('region', { name: 'Admin market overview' });
  await expect(dashboard).toBeVisible();
  await expect(dashboard).toContainText('Expired proposal awaiting admin');
  await page.screenshot({ path: `/tmp/admin-dashboard-overview-${skin}.png`, fullPage: true });
  await dashboard.getByRole('button', { name: 'Review proposal' }).click();
  const publish = dashboard.getByRole('button', { name: 'Confirm publication' });
  await expect(publish).toBeDisabled();
  await dashboard.getByRole('combobox', { name: 'Decision', exact: true }).selectOption('reject');
  await expect(dashboard.getByRole('button', { name: 'Confirm rejection' })).toBeEnabled();
  await dashboard.getByRole('combobox', { name: 'Decision', exact: true }).selectOption('publish');
  await dashboard.getByRole('checkbox').check();
  await publish.click();
  await expect(dashboard).toContainText('Proposal published.');
  expect(writes.find((r) => r.path.endsWith('/publish')).body).toEqual({ acknowledge_expired: true });
  await dashboard.getByRole('button', { name: /Closed markets to resolve/ }).click();
  await dashboard.getByRole('button', { name: 'Review & resolve' }).click();
  await expect(dashboard.getByRole('button', { name: 'Confirm resolution' })).toBeDisabled();
  await dashboard.getByLabel('Winning outcome').selectOption('no');
  await dashboard.getByRole('button', { name: 'Confirm resolution' }).click();
  await expect(dashboard).toContainText('Market resolved.');
  expect(writes.find((r) => r.path.endsWith('/events/90')).body).toEqual({ outcome: 'no' });
  await page.screenshot({ path: `/tmp/admin-dashboard-${skin}.png`, fullPage: true });
 });
}
test('non-admin cannot open dashboard', async ({ page }) => {
 await page.route('**/api/**', route => route.fulfill({ json: [] }));
 await page.addInitScript(() => localStorage.setItem('token', `e30.${btoa(JSON.stringify({ userId: 999, role: 'user', exp: 4000000000 }))}.test`));
 await page.goto('http://127.0.0.1:4192/?skin=van#predictions/admin');
 await expect(page.getByRole('region', { name: 'Admin market overview' })).toHaveCount(0);
});
for (const type of ['numeric', 'multiple_choice']) {
 test(`${type} resolution uses the appropriate settlement route`, async ({ page }) => {
  let written;
  await page.route('**/api/**', async route => {
   const u = new URL(route.request().url());
   let data = [];
   if (route.request().method() !== 'GET') written = { path: u.pathname, body: route.request().postDataJSON() };
   if (u.pathname.endsWith('/users/me/topics')) data = { topicIds: [1,2,3] };
   if (u.pathname.endsWith('/users/profile')) data = { id: 999, role: 'admin' };
   if (u.pathname.endsWith('/admin/markets')) data = { summary: { closed: 1, proposals: 0, expired_proposals: 0 }, total: 1, items: u.searchParams.get('queue') === 'closed' ? [{ id: 90, title: 'Typed market', event_type: type, closing_date: '2020-01-01', resolution_proposal: type === 'multiple_choice' ? { id: 40, status: 'escalated' } : null }] : [] };
   if (u.pathname.endsWith('/market')) data = { outcomes: [{ outcome_id: 10, label: 'First outcome' }] };
   await route.fulfill({ json: data });
  });
  await page.addInitScript(() => localStorage.setItem('token', `e30.${btoa(JSON.stringify({ userId: 999, role: 'admin', exp: 4000000000 }))}.test`));
  await page.goto('http://127.0.0.1:4192/?skin=van#predictions/admin');
  const d = page.getByRole('region', { name: 'Admin market overview' });
  await d.getByRole('button', { name: /Closed markets to resolve/ }).click();
  await d.getByRole('button', { name: 'Review & resolve' }).click();
  if (type === 'numeric') await d.getByLabel('Actual numeric result').fill('0');
  else await d.getByLabel('Winning outcome').selectOption('10');
  await d.getByRole('button', { name: 'Confirm resolution' }).click();
  await expect(d).toContainText('Market resolved.');
  expect(written).toEqual(type === 'numeric' ? { path: '/api/events/90', body: { numerical_outcome: 0 } } : { path: '/api/resolution-proposals/40/admin-ruling', body: { outcome_id: 10 } });
 });
}
