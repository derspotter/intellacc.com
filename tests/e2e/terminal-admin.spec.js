// Terminal skin ADMIN view: adminOnly registry gating (palette + route) plus
// the native create/resolve event flow.
const { test, expect } = require('@playwright/test');
const { createUser, cleanupUsers, apiFetch, dbQuery, SOLID_URL } = require('./helpers/solidMessaging');

const created = [];
const createdEvents = [];
test.afterAll(async () => {
  for (const id of createdEvents) {
    try { dbQuery(`DELETE FROM predictions WHERE event_id = ${id}; DELETE FROM events WHERE id = ${id};`); } catch {}
  }
  await cleanupUsers(created);
});

async function makeAdmin(u) {
  dbQuery(`UPDATE users SET role = 'admin', verification_tier = 3 WHERE id = ${u.id};`);
  const login = await apiFetch('/api/login', {
    method: 'POST',
    body: JSON.stringify({ email: u.email, password: u.password })
  });
  return login.body.token; // fresh JWT carrying the role claim
}

test('non-admin cannot open the admin view', async ({ page }) => {
  const u = await createUser('tadm1');
  created.push(u);
  await page.addInitScript((t) => localStorage.setItem('token', t), u.token);
  await page.goto(`${SOLID_URL}/?skin=terminal#admin`, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('body')).toHaveAttribute('data-skin', 'terminal', { timeout: 15000 });
  await expect(page.locator('[data-view="admin"]')).not.toBeVisible();
});

test('admin creates and resolves an event', async ({ page }) => {
  const u = await createUser('tadm2');
  created.push(u);
  const adminToken = await makeAdmin(u);

  await page.addInitScript((t) => localStorage.setItem('token', t), adminToken);
  await page.goto(`${SOLID_URL}/?skin=terminal#admin`, { waitUntil: 'domcontentloaded' });
  const view = page.locator('[data-view="admin"]');
  await expect(view).toBeVisible({ timeout: 15000 });

  const title = `TERM ADMIN E2E ${Date.now()}`;
  await view.locator('[data-testid="admin-event-title"]').fill(title);
  await view.locator('[data-testid="admin-event-closing"]').fill('2027-01-01T12:00');
  await view.locator('[data-testid="admin-event-create"]').click();
  await expect(view).toContainText('EVENT CREATED', { timeout: 10000 });
  const eid = dbQuery(`SELECT id FROM events WHERE title = '${title.replace(/'/g, "''")}' LIMIT 1;`).split('\n')[0];
  expect(Number(eid)).toBeGreaterThan(0);
  createdEvents.push(Number(eid));

  // Resolve it via the resolution section.
  await view.locator('[data-testid="admin-resolve-search"]').fill(title);
  await view.locator('[data-testid="admin-resolve-pick"]').first().click();
  await view.locator('[data-testid="admin-resolve-yes"]').click();
  await view.locator('[data-testid="admin-resolve-submit"]').click();
  await expect(view).toContainText('RESOLVED AS YES', { timeout: 10000 });
});
