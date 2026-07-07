// Group membership lifecycle: message requests for invites from non-followed
// users, and leaving a group (self-remove proposal auto-committed by a
// remaining member). Environment as in solid-messaging.spec.js.

const { test, expect } = require('@playwright/test');
const {
  apiFetch,
  createUser,
  provisionTier,
  provisionTopics,
  loginOnSolid,
  provisionMessaging,
  waitWithSync,
  cleanupUsers
} = require('./helpers/solidMessaging');

test.describe('Solid group membership E2E', () => {
  test('invite from a non-followed user arrives as a message request', async ({ browser }) => {
    test.setTimeout(240000);

    const alice = await createUser('ralice');
    const dave = await createUser('rdave');
    provisionTier(alice);
    await provisionTopics(alice);
    provisionTier(dave);
    await provisionTopics(dave);
    // Deliberately NO follow: the invite must park as a message request.

    const contextA = await browser.newContext();
    const contextD = await browser.newContext();
    const pageA = await contextA.newPage();
    const pageD = await contextD.newPage();

    try {
      await loginOnSolid(pageA, alice);
      await provisionMessaging(pageA, alice);
      await loginOnSolid(pageD, dave);
      await provisionMessaging(pageD, dave);

      const groupTitle = `request crew ${Date.now()}`;
      await pageA.getByRole('button', { name: '+ New' }).click();
      await pageA.locator('.conversation-kind-toggle button', { hasText: 'Group' }).click();
      await pageA.fill('input[placeholder="Group name"]', groupTitle);
      await pageA.fill('input[placeholder="Member user ids (comma-separated)"]', String(dave.id));
      await pageA.locator('.new-group-form button[type="submit"]').click();
      await expect(pageA.locator('.conversation-item', { hasText: groupTitle }))
        .toBeVisible({ timeout: 45000 });

      const welcomeNote = `glad you accepted ${Date.now()}`;
      await pageA.fill('textarea.message-textarea', welcomeNote);
      await pageA.locator('button.send-button').click();

      // Dave gets a message request (NOT an auto-joined conversation),
      // attributed to Alice once usernames resolve.
      await waitWithSync(pageD, pageD.locator('.message-request'), { timeout: 90000 });
      await expect(pageD.locator('.message-request-from', { hasText: alice.username }))
        .toBeVisible({ timeout: 30000 });
      await expect(pageD.locator('.conversation-item', { hasText: groupTitle })).toHaveCount(0);

      // Accept: the conversation appears and the held-back message arrives.
      await pageD.locator('.message-request button', { hasText: 'Accept' }).click();
      await expect(pageD.locator('.conversation-item', { hasText: groupTitle }))
        .toBeVisible({ timeout: 45000 });
      await pageD.locator('.conversation-item', { hasText: groupTitle }).click();
      await waitWithSync(
        pageD,
        pageD.locator('.message-item.received .message-text', { hasText: welcomeNote }),
        { timeout: 90000, reopenConversation: true }
      );
    } finally {
      await contextA.close();
      await contextD.close();
      cleanupUsers([alice, dave]);
    }
  });

  test('a member can leave a group and the roster updates for the others', async ({ browser }) => {
    test.setTimeout(300000);

    const alice = await createUser('lalice');
    const bob = await createUser('lbob');
    const carol = await createUser('lcarol');
    provisionTier(alice);
    await provisionTopics(alice);
    provisionTier(bob);
    await provisionTopics(bob);
    provisionTier(carol);
    await provisionTopics(carol);
    for (const follower of [bob, carol]) {
      const follow = await apiFetch(`/api/users/${alice.id}/follow`, { method: 'POST', token: follower.token });
      if (!follow.response.ok) throw new Error(`follow failed: ${follow.text}`);
    }

    const contextA = await browser.newContext();
    const contextB = await browser.newContext();
    const contextC = await browser.newContext();
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();
    const pageC = await contextC.newPage();

    try {
      await loginOnSolid(pageA, alice);
      await provisionMessaging(pageA, alice);
      await loginOnSolid(pageB, bob);
      await provisionMessaging(pageB, bob);
      await loginOnSolid(pageC, carol);
      await provisionMessaging(pageC, carol);

      const groupTitle = `leaver crew ${Date.now()}`;
      await pageA.getByRole('button', { name: '+ New' }).click();
      await pageA.locator('.conversation-kind-toggle button', { hasText: 'Group' }).click();
      await pageA.fill('input[placeholder="Group name"]', groupTitle);
      await pageA.fill('input[placeholder="Member user ids (comma-separated)"]', `${bob.id}, ${carol.id}`);
      await pageA.locator('.new-group-form button[type="submit"]').click();
      await expect(pageA.locator('.conversation-item', { hasText: groupTitle }))
        .toBeVisible({ timeout: 45000 });

      const kickoff = `kickoff ${Date.now()}`;
      await pageA.fill('textarea.message-textarea', kickoff);
      await pageA.locator('button.send-button').click();

      // Both members join and see the kickoff message.
      for (const page of [pageB, pageC]) {
        await waitWithSync(page, page.locator('.conversation-item', { hasText: groupTitle }), { timeout: 90000 });
        await page.locator('.conversation-item', { hasText: groupTitle }).click();
        await waitWithSync(
          page,
          page.locator('.message-item.received .message-text', { hasText: kickoff }),
          { timeout: 90000, reopenConversation: true }
        );
      }

      // Bob leaves (two-step confirm); the group vanishes from his list.
      await pageB.locator('.leave-group-btn').click();
      await pageB.locator('.leave-group-btn', { hasText: 'Confirm leave' }).click();
      await expect(pageB.locator('.conversation-item', { hasText: groupTitle }))
        .toHaveCount(0, { timeout: 30000 });

      // Alice's member list drops Bob after a remaining member auto-commits
      // the self-remove proposal.
      await expect
        .poll(async () => {
          await pageA.evaluate(async () => {
            try { await window.coreCryptoClient.syncMessages(); } catch {}
          });
          await pageA.locator('.conversation-item', { hasText: groupTitle }).click();
          await pageA.waitForTimeout(500);
          return (await pageA.locator('.group-members').textContent().catch(() => '')) || '';
        }, { timeout: 90000, message: 'bob removed from member list' })
        .not.toContain(bob.username);

      // The remaining members still message each other fine.
      const aftermath = `quieter now ${Date.now()}`;
      await pageA.fill('textarea.message-textarea', aftermath);
      await pageA.locator('button.send-button').click();
      await waitWithSync(
        pageC,
        pageC.locator('.message-item.received .message-text', { hasText: aftermath }),
        { timeout: 90000, reopenConversation: true }
      );
    } finally {
      await contextA.close();
      await contextB.close();
      await contextC.close();
      cleanupUsers([alice, bob, carol]);
    }
  });
});
