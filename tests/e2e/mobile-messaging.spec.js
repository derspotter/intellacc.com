// Mobile-viewport (phone-size) E2EE messaging happy path on the Solid VAN skin.
//
// Complements solid-messaging.spec.js: that spec proves the full MLS DM
// lifecycle (invite -> welcome -> message -> reply -> receipts -> edit ->
// delete -> disappearing) on desktop-sized contexts. This spec re-drives the
// happy-path subset (invite, welcome, message, read, reply) with BOTH browser
// contexts emulating a phone (390x844, isMobile, hasTouch) and asserts mobile
// usability at each UI step:
//   - conversation list, chat thread, composer textarea and send button all
//     have bounding boxes fully inside the 390px-wide viewport;
//   - document.documentElement.scrollWidth === 390 (no horizontal overflow);
//   - the composer is not covered by the fixed bottom .mobile-tab-bar;
//   - list -> thread navigation works by tap at phone width (the messages
//     page stacks the conversation list above the chat area on mobile).
//
// Requirements are the same as solid-messaging.spec.js (solid-local dev
// instance at SOLID_URL, docker DB access for user provisioning).

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

const VIEWPORT = { width: 390, height: 844 };
// Sub-pixel layout slop for boundingBox comparisons (borders and flex
// rounding can produce e.g. 390.0000000001-wide fixed bars).
const EDGE_TOLERANCE = 0.5;

// Users are created inside the test but cleaned up in afterAll so a mid-test
// crash still purges them from the real database.
const createdUsers = [];

test.afterAll(() => {
  cleanupUsers(createdUsers);
});

async function assertNoHorizontalOverflow(page, label) {
  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(scrollWidth, `${label}: page must not overflow horizontally`).toBe(VIEWPORT.width);
}

async function assertInsideViewport(locator, label) {
  await expect(locator, `${label}: visible`).toBeVisible();
  const box = await locator.boundingBox();
  expect(box, `${label}: bounding box`).toBeTruthy();
  expect(box.x, `${label}: left edge >= 0`).toBeGreaterThanOrEqual(-EDGE_TOLERANCE);
  expect(box.x + box.width, `${label}: right edge <= ${VIEWPORT.width}`)
    .toBeLessThanOrEqual(VIEWPORT.width + EDGE_TOLERANCE);
  expect(box.y, `${label}: top edge >= 0`).toBeGreaterThanOrEqual(-EDGE_TOLERANCE);
  expect(box.y + box.height, `${label}: bottom edge <= ${VIEWPORT.height}`)
    .toBeLessThanOrEqual(VIEWPORT.height + EDGE_TOLERANCE);
}

// What the app actually does on the chat screen at phone width: the VAN
// layout renders the fixed bottom .mobile-tab-bar unconditionally at
// <=1024px (Layout.jsx -> MobileTabBar; nothing hides it on #messages).
// Instead, .messages-container is sized calc(100vh - 112px) in the
// max-width:768px media block so the stacked list + chat area + composer all
// end above the 56px tab bar. So the correct assertion here is: tab bar
// VISIBLE, composer bottom edge above the tab bar's top edge.
async function assertComposerClearOfTabBar(page, label) {
  const tabBar = page.locator('.mobile-tab-bar');
  await expect(tabBar, `${label}: mobile tab bar rendered on chat screen`).toBeVisible();
  const tabBarBox = await tabBar.boundingBox();
  const composerBox = await page.locator('.message-input-area').boundingBox();
  expect(tabBarBox, `${label}: tab bar bounding box`).toBeTruthy();
  expect(composerBox, `${label}: composer bounding box`).toBeTruthy();
  expect(
    composerBox.y + composerBox.height,
    `${label}: composer (bottom ${composerBox.y + composerBox.height}) must sit above the tab bar (top ${tabBarBox.y})`
  ).toBeLessThanOrEqual(tabBarBox.y + EDGE_TOLERANCE);
}

// Conversation-list screen (no thread open yet).
async function assertListScreenUsable(page, label) {
  await assertNoHorizontalOverflow(page, label);
  await assertInsideViewport(page.locator('.conversations-sidebar'), `${label}: conversation list`);
  await assertInsideViewport(page.locator('.mobile-tab-bar'), `${label}: mobile tab bar`);
}

// Chat screen (thread open, composer present).
async function assertChatScreenUsable(page, label) {
  await assertNoHorizontalOverflow(page, label);
  await assertInsideViewport(page.locator('.conversations-sidebar'), `${label}: conversation list`);
  await assertInsideViewport(page.locator('.chat-area'), `${label}: chat thread`);
  await assertInsideViewport(page.locator('textarea.message-textarea'), `${label}: composer input`);
  await assertInsideViewport(page.locator('button.send-button'), `${label}: send button`);
  await assertComposerClearOfTabBar(page, label);
}

test.describe('Mobile Solid messaging E2E', () => {
  test('two users exchange an encrypted DM at phone size with a usable UI', async ({ browser }) => {
    test.setTimeout(240000);

    const alice = await createUser('malice');
    const bob = await createUser('mbob');
    createdUsers.push(alice, bob);
    provisionTier(alice);
    provisionTier(bob);
    // Seed topics so the blocking topic-onboarding gate (checkTopics ->
    // TopicPicker) never hijacks #messages mid-test. Skipping this is the
    // known flake cause: needsTopics defaults false, so the spec can click
    // into the UI before getMine() resolves, then the TopicPicker replaces
    // the whole page and the messaging locators never appear.
    await provisionTopics(alice);
    await provisionTopics(bob);

    // Welcomes auto-accept only when the receiver follows the sender;
    // otherwise they park as message requests awaiting UI confirmation.
    const follow = await apiFetch(`/api/users/${alice.id}/follow`, { method: 'POST', token: bob.token });
    if (!follow.response.ok) {
      throw new Error(`Bob could not follow Alice (${follow.response.status}): ${follow.text}`);
    }

    // Same two-context shape as solid-messaging.spec.js, but both contexts
    // emulate a phone. This is the only intended difference in setup.
    const contextA = await browser.newContext({ viewport: VIEWPORT, isMobile: true, hasTouch: true });
    const contextB = await browser.newContext({ viewport: VIEWPORT, isMobile: true, hasTouch: true });
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();

    try {
      await loginOnSolid(pageA, alice);
      await provisionMessaging(pageA, alice);
      await loginOnSolid(pageB, bob);
      await provisionMessaging(pageB, bob);

      // Before any conversation exists, the #messages screen must already be
      // usable at phone width.
      await assertListScreenUsable(pageA, 'Alice pre-conversation');

      // Alice opens a DM with Bob by user id (real MLS invite + welcome).
      await pageA.getByRole('button', { name: '+ New' }).tap();
      await pageA.fill('input[placeholder="Start by user id"]', String(bob.id));
      await pageA.locator('.new-conversation-form button[type="submit"]').tap();
      await expect(pageA.locator('.conversation-item').first()).toBeVisible({ timeout: 45000 });
      await expect(pageA.locator('.encryption-status')).toContainText('MLS conversation', { timeout: 30000 });
      await assertChatScreenUsable(pageA, 'Alice after starting DM');

      // Alice sends the first message.
      const messageFromAlice = `hello from mobile alice ${Date.now()}`;
      await pageA.fill('textarea.message-textarea', messageFromAlice);
      await pageA.locator('button.send-button').tap();
      await expect(pageA.locator('.message-item.sent .message-text').last())
        .toHaveText(messageFromAlice, { timeout: 30000 });
      await assertChatScreenUsable(pageA, 'Alice after sending');

      // Bob's client processes the welcome; the conversation appears in the
      // stacked list. Before tapping, the chat area still shows the
      // empty-state placeholder (list and thread are stacked on mobile, so
      // both are on screen; "navigation" is selecting into the thread pane).
      await waitWithSync(pageB, pageB.locator('.conversation-item'), { timeout: 90000 });
      await assertListScreenUsable(pageB, 'Bob conversation list');
      await expect(pageB.locator('.chat-area .no-conversation'), 'Bob: thread pane empty before tap')
        .toBeVisible();

      // List -> thread navigation by tap at phone width.
      await pageB.locator('.conversation-item').first().tap();
      await expect(pageB.locator('.chat-area .conversation-view'), 'Bob: tap opens the thread')
        .toBeVisible({ timeout: 30000 });

      // Bob receives and reads Alice's message.
      await waitWithSync(
        pageB,
        pageB.locator('.message-item.received .message-text', { hasText: messageFromAlice }),
        { timeout: 90000, reopenConversation: true }
      );
      await assertChatScreenUsable(pageB, 'Bob reading');

      // Bob replies on the established group.
      const messageFromBob = `hi from mobile bob ${Date.now()}`;
      await pageB.fill('textarea.message-textarea', messageFromBob);
      await pageB.locator('button.send-button').tap();
      await expect(pageB.locator('.message-item.sent .message-text').last())
        .toHaveText(messageFromBob, { timeout: 30000 });
      await assertChatScreenUsable(pageB, 'Bob after replying');

      // Alice sees the reply.
      await waitWithSync(
        pageA,
        pageA.locator('.message-item.received .message-text', { hasText: messageFromBob }),
        { timeout: 90000, reopenConversation: true }
      );
      await assertChatScreenUsable(pageA, 'Alice after receiving reply');
    } finally {
      // Guard teardown: a context-close race must not red a passing run.
      await contextA.close().catch(() => {});
      await contextB.close().catch(() => {});
    }
  });
});
