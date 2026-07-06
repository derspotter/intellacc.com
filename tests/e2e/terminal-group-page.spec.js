// Terminal skin GROUP view: header, feed, chat, markets, members.
const { test, expect } = require('@playwright/test');
const { createUser, cleanupUsers, provisionTier, dbQuery, SOLID_URL } = require('./helpers/solidMessaging');

const created = [];
const createdGroups = [];
test.afterAll(async () => {
  for (const id of createdGroups) {
    try { dbQuery(`DELETE FROM community_group_members WHERE group_id = ${id}; DELETE FROM community_groups WHERE id = ${id};`); } catch {}
  }
  await cleanupUsers(created);
});

test('group page: feed post + members tab', async ({ page }) => {
  const u = await createUser('tgpg1');
  created.push(u);
  provisionTier(u);
  dbQuery(`UPDATE users SET verification_tier = GREATEST(verification_tier, 2) WHERE id = ${u.id};`);

  // Seed a group owned by the user directly. Real schema (verified against
  // backend/migrations/20260617_community_groups.sql and
  // communityGroupsController.js): community_groups(id, slug, name,
  // description, topic_id, created_by, member_count, removed_at,
  // created_at) — NOT owner_user_id/updated_at as the brief guessed.
  // community_group_members(group_id, user_id, role, joined_at) — no
  // created_at column there either.
  const slug = `term-e2e-${Date.now()}`;
  const gid = dbQuery(`
    INSERT INTO community_groups (name, slug, description, topic_id, created_by, member_count, created_at)
    VALUES ('Term E2E ${Date.now()}', '${slug}', 'e2e', (SELECT id FROM topics LIMIT 1), ${u.id}, 1, NOW())
    RETURNING id;`).split('\n')[0];
  createdGroups.push(Number(gid));
  dbQuery(`INSERT INTO community_group_members (group_id, user_id, role) VALUES (${gid}, ${u.id}, 'owner');`);

  await page.addInitScript((t) => localStorage.setItem('token', t), u.token);
  await page.goto(`${SOLID_URL}/?skin=terminal#group/${slug}`, { waitUntil: 'domcontentloaded' });
  const view = page.locator('[data-view="group"]');
  await expect(view).toBeVisible({ timeout: 15000 });
  await expect(view).toContainText('Term E2E');

  // Post in the group feed.
  await view.locator('[data-testid="group-post-input"]').fill('terminal group feed post');
  await view.locator('[data-testid="group-post-submit"]').click();
  await expect(view.locator('[data-testid="feed-post"]', { hasText: 'terminal group feed post' }))
    .toBeVisible({ timeout: 10000 });

  // Members tab shows the owner.
  await view.getByRole('button', { name: '[MEMBERS]' }).click();
  await expect(view.locator('[data-testid="group-member-row"]', { hasText: u.username }))
    .toBeVisible({ timeout: 10000 });
});
