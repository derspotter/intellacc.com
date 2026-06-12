// Encrypted group chat over the MLS relay: create a named group, exchange
// messages among three users, and verify that a member added later cannot
// read history from before they joined (MLS forward secrecy at the UX level).
//
// Environment requirements are the same as solid-messaging.spec.js (see its
// header): solid-local dev instance on 127.0.0.1:4174 + docker DB access.

const { test, expect } = require('@playwright/test');
const {
  apiFetch,
  createUser,
  provisionTier,
  loginOnSolid,
  provisionMessaging,
  waitWithSync,
  cleanupUsers
} = require('./helpers/solidMessaging');

test.describe('Solid group messaging E2E', () => {
  test('three users can chat in a named group with late-join semantics', async ({ browser }) => {
    test.setTimeout(300000);

    const alice = await createUser('galice');
    const bob = await createUser('gbob');
    const carol = await createUser('gcarol');
    provisionTier(alice);
    provisionTier(bob);
    provisionTier(carol);

    // Group welcomes auto-accept only when the receiver follows the inviter.
    for (const follower of [bob, carol]) {
      const follow = await apiFetch(`/api/users/${alice.id}/follow`, { method: 'POST', token: follower.token });
      if (!follow.response.ok) {
        throw new Error(`User ${follower.id} could not follow Alice (${follow.response.status}): ${follow.text}`);
      }
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

      // Alice creates a group with Bob only (Carol joins later).
      const groupTitle = `launch crew ${Date.now()}`;
      await pageA.getByRole('button', { name: '+ New' }).click();
      await pageA.locator('.conversation-kind-toggle button', { hasText: 'Group' }).click();
      await pageA.fill('input[placeholder="Group name"]', groupTitle);
      await pageA.fill('input[placeholder="Member user ids (comma-separated)"]', String(bob.id));
      await pageA.locator('.new-group-form button[type="submit"]').click();

      await expect(pageA.locator('.conversation-item', { hasText: groupTitle }))
        .toBeVisible({ timeout: 45000 });
      await expect(pageA.locator('.encryption-status')).toContainText('MLS conversation', { timeout: 30000 });

      // Pre-join history Carol must never see.
      const secretHistory = `pre-carol secret ${Date.now()}`;
      await pageA.fill('textarea.message-textarea', secretHistory);
      await pageA.locator('button.send-button').click();
      await expect(pageA.locator('.message-item.sent .message-text', { hasText: secretHistory }))
        .toBeVisible({ timeout: 30000 });

      // Bob joins via welcome and sees the message with Alice's username.
      await waitWithSync(pageB, pageB.locator('.conversation-item', { hasText: groupTitle }), { timeout: 90000 });
      await pageB.locator('.conversation-item', { hasText: groupTitle }).click();
      await waitWithSync(
        pageB,
        pageB.locator('.message-item.received .message-text', { hasText: secretHistory }),
        { timeout: 90000, reopenConversation: true }
      );
      await expect(pageB.locator('.message-item.received .message-sender', { hasText: alice.username }).first())
        .toBeVisible({ timeout: 15000 });

      // Alice adds Carol from the chat header.
      await pageA.fill('.add-member-form input', String(carol.id));
      await pageA.locator('.add-member-form button[type="submit"]').click();
      await expect(pageA.locator('.group-members')).toContainText(carol.username, { timeout: 45000 });

      // Post-join message everyone should see.
      const groupAnnouncement = `welcome carol ${Date.now()}`;
      await pageA.fill('textarea.message-textarea', groupAnnouncement);
      await pageA.locator('button.send-button').click();
      await expect(pageA.locator('.message-item.sent .message-text', { hasText: groupAnnouncement }))
        .toBeVisible({ timeout: 30000 });

      // Carol joins and receives only the post-join message.
      await waitWithSync(pageC, pageC.locator('.conversation-item', { hasText: groupTitle }), { timeout: 90000 });
      await pageC.locator('.conversation-item', { hasText: groupTitle }).click();
      await waitWithSync(
        pageC,
        pageC.locator('.message-item.received .message-text', { hasText: groupAnnouncement }),
        { timeout: 90000, reopenConversation: true }
      );
      await expect(pageC.locator('.message-item .message-text', { hasText: secretHistory }))
        .toHaveCount(0);

      // Carol replies; both Alice and Bob receive it.
      const carolReply = `carol checking in ${Date.now()}`;
      await pageC.fill('textarea.message-textarea', carolReply);
      await pageC.locator('button.send-button').click();
      await expect(pageC.locator('.message-item.sent .message-text', { hasText: carolReply }))
        .toBeVisible({ timeout: 30000 });

      for (const [page, label] of [[pageA, 'alice'], [pageB, 'bob']]) {
        await waitWithSync(
          page,
          page.locator('.message-item.received .message-text', { hasText: carolReply }),
          { timeout: 90000, reopenConversation: true }
        );
      }

      // Bob also catches up on the announcement and sees the member list.
      await waitWithSync(
        pageB,
        pageB.locator('.message-item.received .message-text', { hasText: groupAnnouncement }),
        { timeout: 90000, reopenConversation: true }
      );
      await expect(pageB.locator('.group-members')).toContainText(carol.username, { timeout: 30000 });
    } finally {
      await contextA.close();
      await contextB.close();
      await contextC.close();
      cleanupUsers([alice, bob, carol]);
    }
  });
});
