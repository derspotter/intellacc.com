// Live notification push E2E (Solid, terminal skin).
//
// Covers the terminal-skin parity ledger deferral (P2 Task 2,
// docs/superpowers/plans/2026-07-06-terminal-skin-parity-ledger.md):
// "no automated test for the live socket-push path". The path under test:
//
//   backend notificationService.createNotification()
//     -> io.to(`user:${userId}`).emit('notification', { type: 'new', ... })
//     -> io.to(`user:${userId}`).emit('notification', { type: 'unreadCountUpdate', count })
//   frontend-solid/src/services/socket.js socket.on('notification')
//     -> socketState.notifications / lastNotification  (TerminalApp ticker + overlay)
//     -> notificationSubscribers                        (NotificationsView badge/rows)
//
// Transport honesty — why a green run proves SOCKET delivery, not a fetch:
// - There is NO notification polling fallback in the frontend (no setInterval
//   anywhere touching notifications). getNotifications()/
//   getUnreadNotificationCount() run only on NotificationsView/
//   NotificationsPage mount.
// - Phase 1 asserts on the TerminalApp notifications overlay, which renders
//   socketState.notifications — a store written ONLY by socket.on(
//   'notification') in socket.js. No HTTP response ever populates it.
// - Phase 3 asserts the NotificationsView unread badge increments while the
//   view stays mounted (its API fetch ran at mount, before the trigger), so
//   the 1 -> 2 transition can only come from its registerSocketEventHandler
//   subscription.
// - A window-global sentinel proves no reload/navigation happened between
//   trigger and assertion, and all post-trigger assertions use 10s timeouts.
//
// Server-side triggers (real API calls with the actor's JWT, no second
// browser):
// - A follows B  (POST /api/users/:id/follow -> createFollowNotification):
//   simplest reliable notifier — one call, no prerequisites, notification
//   created synchronously before the 201 is sent.
// - A likes B's post (POST /api/posts/:postId/like -> createLikeNotification):
//   second, distinct notification so the badge increment (1 -> 2) can be
//   observed live. (A second follow would be swallowed by the service's
//   1-hour duplicate guard; likes of a different target are not.)

const { test, expect } = require('@playwright/test');
const {
  SOLID_URL,
  apiFetch,
  createUser,
  provisionTier,
  provisionTopics,
  cleanupUsers
} = require('./helpers/solidMessaging');

test.describe('Terminal skin live notification push (Socket.io)', () => {
  test('server-side actions update ticker, dropdown, and unread badge without reload', async ({ browser }) => {
    test.setTimeout(150000);

    // A = actor (API only), B = receiver (browser). Direct-insert approved
    // test users; unique names come from createUser's timestamp+random suffix.
    const userA = await createUser('npa');
    const userB = await createUser('npb');

    const context = await browser.newContext();
    const page = await context.newPage();

    try {
      // B needs tier 1 (post creation is behind requireEmailVerified) and
      // seeded topics (so no onboarding gate can interfere). A only ever
      // calls follow/like, which are plain-JWT routes.
      provisionTier(userB);
      await provisionTopics(userB);

      // B authors a post via the API up front so A can like it later.
      const post = await apiFetch('/api/posts', {
        method: 'POST',
        token: userB.token,
        body: JSON.stringify({ content: `terminal push spec ${Date.now()}` })
      });
      expect(post.response.status, `post creation failed: ${post.text}`).toBe(201);
      const postId = Number(post.body.id);
      expect(postId, `post id missing in: ${post.text}`).toBeGreaterThan(0);

      // B logs in on the terminal skin and idles on #home.
      await page.addInitScript((token) => localStorage.setItem('token', token), userB.token);
      await page.goto(`${SOLID_URL}/?skin=terminal#home`, { waitUntil: 'domcontentloaded' });
      await expect(page.locator('body')).toHaveAttribute('data-skin', 'terminal', { timeout: 15000 });

      // Status bar flips to ONLINE when the socket connects; the client
      // emits 'authenticate' (joins the user:<id> room) in the same connect
      // handler. Give the server a moment to process the room join before
      // firing the trigger, since a pre-join emit would be lost.
      await expect(page.getByText('SYS: ONLINE')).toBeVisible({ timeout: 20000 });
      await page.waitForTimeout(750);

      // Reload sentinel: any full page load between here and the final
      // assertion would wipe this global (and would also re-fetch state,
      // masking a dead socket). It must still be 'alive' at the end.
      await page.evaluate(() => { window.__pushSpecSentinel = 'alive'; });

      // Phase 1: open the TerminalApp notifications dropdown BEFORE the
      // trigger and pin its empty state, so the row can only appear via the
      // socket-fed store (no navigation, no click between trigger + assert).
      await page.getByRole('button', { name: /^NOTIF:/ }).click();
      await expect(page.getByText('[NOTIFICATIONS]')).toBeVisible();
      await expect(page.getByText('NO NOTIFICATIONS YET')).toBeVisible();

      // Trigger 1: A follows B, server-side.
      const follow = await apiFetch(`/api/users/${userB.id}/follow`, {
        method: 'POST',
        token: userA.token
      });
      expect(follow.response.status, `follow failed: ${follow.text}`).toBe(201);

      // The overlay row renders the raw socket payload (JSON containing the
      // notification content). 10s timeout: socket push is sub-second; there
      // is no fallback that could deliver this at all.
      await expect(
        page.getByText(new RegExp(`${userA.username} started following you`)).first()
      ).toBeVisible({ timeout: 10000 });
      expect(await page.evaluate(() => window.__pushSpecSentinel)).toBe('alive');

      await page.keyboard.press('Escape');
      await expect(page.getByText('[NOTIFICATIONS]')).toBeHidden();

      // Phase 2: open the notifications view via SPA hash routing (same
      // document — the sentinel check at the end proves no reload). Its
      // mount-time fetch must show the follow: unread badge 1 + row.
      await page.evaluate(() => { window.location.hash = '#notifications'; });
      const badge = page.getByTestId('notifications-unread');
      await expect(badge).toHaveText('1', { timeout: 15000 });
      await expect(
        page.getByTestId('notification-row')
          .filter({ hasText: new RegExp(`@${userA.username} FOLLOWED YOU`, 'i') })
      ).toBeVisible();

      // Phase 3: with the view already mounted (its fetch is done), a second
      // server-side action must increment the badge live via the socket
      // subscription — no navigation, no remount, no fetch left in flight.
      const like = await apiFetch(`/api/posts/${postId}/like`, {
        method: 'POST',
        token: userA.token
      });
      expect(like.response.status, `like failed: ${like.text}`).toBe(201);

      await expect(badge).toHaveText('2', { timeout: 10000 });
      await expect(
        page.getByTestId('notification-row')
          .filter({ hasText: new RegExp(`@${userA.username} LIKED YOUR POST`, 'i') })
      ).toBeVisible({ timeout: 5000 });

      // Still the same document: the whole flow ran without a reload.
      expect(await page.evaluate(() => window.__pushSpecSentinel)).toBe('alive');
    } finally {
      await context.close().catch(() => {});
      // Users cascade: follows, likes, posts, notifications all have
      // ON DELETE CASCADE FKs to users/posts.
      cleanupUsers([userA, userB]);
    }
  });
});
