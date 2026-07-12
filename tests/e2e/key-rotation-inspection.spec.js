// DM message-request review + key rotation E2E (Solid).
//
// Successor to the legacy VanJS "invite inspection" spec: in the Solid UI an
// unsolicited DM welcome parks as a Message Request the receiver must accept
// before the conversation is established (the group-chat variant is covered
// by solid-group-membership.spec.js). Afterwards the sender rotates her MLS
// keys across all groups and the conversation must keep working through the
// new epoch in both directions.

const { test, expect } = require('@playwright/test');
const {
  createUser,
  provisionTier,
  provisionTopics,
  loginOnSolid,
  provisionMessaging,
  waitWithSync,
  cleanupUsers
} = require('./helpers/solidMessaging');

test.describe('DM message requests & key rotation E2E', () => {
  test('unsolicited DM needs explicit accept; keys rotate without breaking the chat', async ({ browser }) => {
    test.setTimeout(240000);

    const alice = await createUser('kr_alice');
    const bob = await createUser('kr_bob');
    provisionTier(alice);
    provisionTier(bob);
    await provisionTopics(alice);
    await provisionTopics(bob);
    // Deliberately NO follow relationship: the welcome must NOT auto-accept.

    const contextA = await browser.newContext();
    const contextB = await browser.newContext();
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();

    try {
      await loginOnSolid(pageA, alice);
      await provisionMessaging(pageA, alice);
      await loginOnSolid(pageB, bob);
      await provisionMessaging(pageB, bob);

      // Alice opens a DM with Bob and sends the first message.
      await pageA.getByRole('button', { name: '+ New' }).click();
      await pageA.fill('input[placeholder="Start by user id"]', String(bob.id));
      await pageA.locator('.new-conversation-form button[type="submit"]').click();
      await expect(pageA.locator('.conversation-item').first()).toBeVisible({ timeout: 45000 });

      const firstMessage = `hello before accept ${Date.now()}`;
      await pageA.fill('textarea.message-textarea', firstMessage);
      await pageA.locator('button.send-button').click();
      await expect(pageA.locator('.message-item.sent .message-text').last())
        .toHaveText(firstMessage, { timeout: 30000 });

      // Bob does not follow Alice, so the welcome parks as a message request
      // he has to review — nothing lands in his conversation list yet.
      await waitWithSync(pageB, pageB.locator('.message-request'), { timeout: 90000 });
      await expect(pageB.locator('.message-request-from', { hasText: alice.username }))
        .toBeVisible({ timeout: 15000 });
      expect(await pageB.locator('.conversation-item').count()).toBe(0);

      // Accepting establishes the conversation and delivers the message.
      await pageB.locator('.message-request button', { hasText: 'Accept' }).click();
      await waitWithSync(pageB, pageB.locator('.conversation-item'), { timeout: 90000 });
      await pageB.locator('.conversation-item').first().click();
      await waitWithSync(
        pageB,
        pageB.locator('.message-item.received .message-text', { hasText: firstMessage }),
        { timeout: 90000, reopenConversation: true }
      );

      // Alice rotates her MLS keys across all conversations (self-update
      // commit — advances the group epoch).
      const rotation = await pageA.evaluate(async () => {
        try {
          await window.coreCryptoClient.rotateKeysAllGroups();
          return { ok: true };
        } catch (err) {
          return { ok: false, reason: err?.message || String(err) };
        }
      });
      expect(rotation, 'key rotation').toMatchObject({ ok: true });

      // The conversation still works in both directions on the new epoch.
      const postRotationFromAlice = `post-rotation from alice ${Date.now()}`;
      await pageA.fill('textarea.message-textarea', postRotationFromAlice);
      await pageA.locator('button.send-button').click();
      await waitWithSync(
        pageB,
        pageB.locator('.message-item.received .message-text', { hasText: postRotationFromAlice }),
        { timeout: 90000, reopenConversation: true }
      );

      const postRotationFromBob = `post-rotation from bob ${Date.now()}`;
      await pageB.fill('textarea.message-textarea', postRotationFromBob);
      await pageB.locator('button.send-button').click();
      await waitWithSync(
        pageA,
        pageA.locator('.message-item.received .message-text', { hasText: postRotationFromBob }),
        { timeout: 90000, reopenConversation: true }
      );
    } finally {
      await contextA.close().catch(() => {});
      await contextB.close().catch(() => {});
      cleanupUsers([alice, bob]);
    }
  });
});
