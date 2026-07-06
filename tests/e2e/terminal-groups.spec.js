// Terminal skin GROUPS view: browse/search/create/join community groups.
const { test, expect } = require('@playwright/test');
const { createUser, cleanupUsers, dbQuery, SOLID_URL } = require('./helpers/solidMessaging');

const created = [];
const createdGroups = [];
test.afterAll(async () => {
  for (const id of createdGroups) {
    try { dbQuery(`DELETE FROM community_group_members WHERE group_id = ${id}; DELETE FROM community_groups WHERE id = ${id};`); } catch {}
  }
  await cleanupUsers(created);
});

test('groups view lists groups and creates one', async ({ page }) => {
  const u = await createUser('tgrp1');
  created.push(u);
  // Group creation needs a verified account; raise tier directly.
  dbQuery(`UPDATE users SET verification_tier = GREATEST(verification_tier, 2) WHERE id = ${u.id};`);

  await page.addInitScript((t) => localStorage.setItem('token', t), u.token);
  await page.goto(`${SOLID_URL}/?skin=terminal#groups`, { waitUntil: 'domcontentloaded' });
  const view = page.locator('[data-view="groups"]');
  await expect(view).toBeVisible({ timeout: 15000 });

  await view.locator('[data-testid="groups-new"]').click();
  const name = `TERM TEST GROUP ${Date.now()}`;
  await view.locator('[data-testid="group-create-name"]').fill(name);
  await view.locator('[data-testid="group-create-submit"]').click();

  // Creation navigates to the group page route; Task 5 renders it. Until
  // then the hash change is the observable contract.
  await expect.poll(() => page.evaluate(() => window.location.hash)).toContain('#group/');
  const gid = dbQuery(`SELECT id FROM community_groups WHERE name = '${name.replace(/'/g, "''")}' LIMIT 1;`).split('\n')[0];
  if (gid) createdGroups.push(Number(gid));
});
