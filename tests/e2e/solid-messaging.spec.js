// Solid-to-Solid encrypted DM exchange over the MLS relay.
//
// Replaces the messaging delivery coverage lost when the legacy VanJS specs
// were removed with the 2026-06-11 cutover. Drives the real UI flow on two
// browser contexts: invite -> welcome -> message -> reply.
//
// Requirements:
// - Solid frontend reachable at SOLID_URL (default http://127.0.0.1:4174,
//   e.g. `docker compose -p solid-local -f docker-compose.solid-local.yml up -d`).
//   The Vite server proxies /api and /socket.io to the backend, so no separate
//   backend URL is needed by default.
// - Database container reachable via `docker exec` for test-user provisioning.

const { test, expect } = require('@playwright/test');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const SOLID_URL = (process.env.SOLID_URL || process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:4174').replace(/\/$/, '');
const BACKEND_URL = (process.env.BACKEND_URL || SOLID_URL).replace(/\/$/, '');
const PASSWORD = 'password123';
const DB_CONTAINER = process.env.TEST_DB_CONTAINER || 'intellacc_db';
const DB_USER = process.env.TEST_DB_USER || 'intellacc_user';
const DB_NAME = process.env.TEST_DB_NAME || 'intellaccdb';

function dbQuery(sql) {
  return execFileSync(
    'docker',
    ['exec', '-i', DB_CONTAINER, 'psql', '-U', DB_USER, '-d', DB_NAME, '-t', '-A', '-v', 'ON_ERROR_STOP=1'],
    { input: sql, encoding: 'utf8' }
  ).trim();
}

async function apiFetch(path, { token, ...init } = {}) {
  const response = await fetch(`${BACKEND_URL}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.headers || {})
    }
  });
  const text = await response.text();
  let body = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }
  return { response, body, text };
}

async function createUser(label) {
  const unique = `${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
  const user = {
    username: `sm_${label}_${unique}`,
    email: `sm_${label}_${unique}@example.com`,
    password: PASSWORD
  };

  const { response, body, text } = await apiFetch('/api/users', {
    method: 'POST',
    body: JSON.stringify(user)
  });
  if (!response.ok) {
    throw new Error(`Registration failed for ${user.username} (${response.status}): ${text}`);
  }
  user.id = Number(body.user?.id);
  if (!user.id) {
    throw new Error(`Registration response missing user id: ${text}`);
  }

  if (body.requiresApproval) {
    const approvalToken = dbQuery(
      `SELECT token FROM registration_approval_tokens
       WHERE user_id = ${user.id} AND status = 'pending'
       ORDER BY created_at DESC LIMIT 1;`
    );
    if (!approvalToken) {
      throw new Error(`No approval token found for user ${user.id}`);
    }
    const approval = await apiFetch('/api/admin/users/approve', {
      method: 'POST',
      body: JSON.stringify({ token: approvalToken })
    });
    if (!approval.response.ok) {
      throw new Error(`Approval failed for user ${user.id} (${approval.response.status}): ${approval.text}`);
    }
  }

  const login = await apiFetch('/api/login', {
    method: 'POST',
    body: JSON.stringify({ email: user.email, password: user.password })
  });
  if (!login.response.ok || !login.body.token) {
    throw new Error(`Login failed for ${user.username} (${login.response.status}): ${login.text}`);
  }
  user.token = login.body.token;
  return user;
}

// No device is pre-registered: the browser session must register the user's
// FIRST device during keystore setup, which is implicitly trusted by the
// hardened device-bootstrap rules. Only the verification tier is seeded.
function provisionTier(user) {
  dbQuery(`
    UPDATE users SET verification_tier = GREATEST(verification_tier, 1), email_verified_at = NOW()
    WHERE id = ${user.id};
  `);
}

// Surface page-side MLS/vault diagnostics in the test output; the clients
// swallow upload errors into console.warn.
function captureClientLogs(page, user) {
  page.on('console', (message) => {
    const text = message.text();
    if (/\[MLS\]|\[Vault\]|\[Keystore\]|\[Socket\]/.test(text)) {
      console.log(`[browser:${user.username}] ${text}`);
    }
  });
}

async function loginOnSolid(page, user) {
  captureClientLogs(page, user);
  await page.addInitScript((token) => localStorage.setItem('token', token), user.token);
  await page.goto(`${SOLID_URL}/#messages`, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('a[href="#messages"]').first()).toBeVisible({ timeout: 30000 });
}

// Bind the pre-verified device to this browser session, set up the vault
// keystore, and upload real key packages through the shared MLS client.
async function provisionMessaging(page, user) {
  const result = await page.evaluate(async ({ password, userId }) => {
    const client = window.coreCryptoClient;
    if (!client) return { ok: false, reason: 'coreCryptoClient not on window' };

    const vaultStore = window.__vaultStore
      || (await import('/src/store/vaultStore.js').catch(() => null))?.default;
    const vaultService = window.__vaultService || window.vaultService
      || (await import('/src/services/mls/vaultService.js').catch(() => null))?.default;
    if (!vaultService) return { ok: false, reason: 'vaultService unavailable' };

    vaultStore?.setUserId?.(userId);
    client._vaultStore = vaultStore;
    client._vaultService = vaultService;
    vaultService.setUserId?.(userId);

    // Set up the vault through the service so the store's isLocked signal
    // flips and the messaging UI becomes interactive. Setup must run BEFORE
    // any unlock attempt: unlocking creates the server master key as a side
    // effect, and a pre-existing master key demotes the device registered
    // during setup from the implicitly-trusted first-device bootstrap path.
    let setupError = null;
    try {
      await vaultService.setupKeystoreWithPassword(password);
    } catch (err) {
      setupError = err?.message || String(err);
      try {
        await vaultService.unlockWithPassword(password);
      } catch (unlockErr) {
        return {
          ok: false,
          reason: unlockErr?.message || String(unlockErr),
          setup: setupError
        };
      }
    }

    try {
      await client.initialize();
      await client.ensureMlsBootstrap(String(userId));
      await client.ensureKeyPackagesFresh();
      return { ok: true, didSetupKeystore: !setupError };
    } catch (err) {
      return { ok: false, reason: err?.message || String(err), setup: setupError };
    }
  }, { password: PASSWORD, userId: user.id });

  expect(result, `messaging provisioning for ${user.username}`).toMatchObject({ ok: true });

  // The inviter consumes one key package per invite, so make sure real
  // (regular) packages are uploaded before anyone gets invited.
  await expect
    .poll(async () => {
      const counts = await page.evaluate(() => window.coreCryptoClient.getKeyPackageCount());
      return counts?.regular ?? 0;
    }, { timeout: 30000, message: `regular key packages for ${user.username}` })
    .toBeGreaterThan(0);
}

// Wait for a locator while actively driving relay sync. Socket events are
// the normal trigger but can be missed in the harness; a page.reload would
// re-lock the vault, so instead drive the shared client directly and remount
// the messages page via hash navigation (keeps the unlocked vault).
async function waitWithSync(page, locator, { timeout = 90000, reopenConversation = false } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (await locator.count() > 0) return;
    if (Date.now() > deadline) {
      await expect(locator.first()).toBeVisible({ timeout: 1000 });
      return;
    }
    await page.evaluate(async () => {
      try { await window.coreCryptoClient?.syncMessages?.(); } catch {}
    });
    await page.waitForTimeout(1500);
    if (await locator.count() > 0) return;
    await page.evaluate(() => { window.location.hash = '#home'; });
    await page.waitForTimeout(300);
    await page.evaluate(() => { window.location.hash = '#messages'; });
    await page.waitForTimeout(700);
    if (reopenConversation) {
      const conversation = page.locator('.conversation-item').first();
      if (await conversation.count() > 0) await conversation.click();
    }
  }
}

test.describe('Solid messaging E2E', () => {
  test('two users can exchange encrypted direct messages', async ({ browser }) => {
    test.setTimeout(240000);

    const alice = await createUser('alice');
    const bob = await createUser('bob');
    provisionTier(alice);
    provisionTier(bob);

    // Welcomes auto-accept only when the receiver follows the sender;
    // otherwise they park as message requests awaiting UI confirmation.
    const follow = await apiFetch(`/api/users/${alice.id}/follow`, { method: 'POST', token: bob.token });
    if (!follow.response.ok) {
      throw new Error(`Bob could not follow Alice (${follow.response.status}): ${follow.text}`);
    }

    const contextA = await browser.newContext();
    const contextB = await browser.newContext();
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();

    try {
      await loginOnSolid(pageA, alice);
      await provisionMessaging(pageA, alice);
      await loginOnSolid(pageB, bob);
      await provisionMessaging(pageB, bob);

      // Alice opens a DM with Bob by user id (real MLS invite + welcome).
      await pageA.getByRole('button', { name: '+ New' }).click();
      await pageA.fill('input[placeholder="Start by user id"]', String(bob.id));
      await pageA.locator('.new-conversation-form button[type="submit"]').click();
      await expect(pageA.locator('.conversation-item').first()).toBeVisible({ timeout: 45000 });
      await expect(pageA.locator('.encryption-status')).toContainText('MLS conversation', { timeout: 30000 });

      // Alice sends the first message.
      const messageFromAlice = `hello from alice ${Date.now()}`;
      await pageA.fill('textarea.message-textarea', messageFromAlice);
      await pageA.locator('button.send-button').click();
      await expect(pageA.locator('.message-item.sent .message-text').last())
        .toHaveText(messageFromAlice, { timeout: 30000 });

      // Bob's client processes the welcome; the conversation appears.
      await waitWithSync(pageB, pageB.locator('.conversation-item'), { timeout: 90000 });
      await pageB.locator('.conversation-item').first().click();
      await waitWithSync(
        pageB,
        pageB.locator('.message-item.received .message-text', { hasText: messageFromAlice }),
        { timeout: 90000, reopenConversation: true }
      );

      // Bob replies on the established group.
      const messageFromBob = `hi alice, bob here ${Date.now()}`;
      await pageB.fill('textarea.message-textarea', messageFromBob);
      await pageB.locator('button.send-button').click();
      await expect(pageB.locator('.message-item.sent .message-text').last())
        .toHaveText(messageFromBob, { timeout: 30000 });

      // Alice receives the reply.
      await waitWithSync(
        pageA,
        pageA.locator('.message-item.received .message-text', { hasText: messageFromBob }),
        { timeout: 90000, reopenConversation: true }
      );

      // Read receipts: Bob opening the conversation sent one; Alice's sent
      // message shows the Read marker once the receipt control message lands.
      await waitWithSync(
        pageA,
        pageA.locator('.message-item.sent .message-read-indicator'),
        { timeout: 90000, reopenConversation: true }
      );

      // Edit: Alice edits her message; both sides show new text + (edited).
      const editedText = `edited by alice ${Date.now()}`;
      await pageA.locator('.message-item.sent .message-action-btn', { hasText: 'Edit' }).first().click();
      await pageA.fill('.message-edit-form .message-textarea', editedText);
      await pageA.locator('.message-edit-form button[type="submit"]').click();
      await expect(pageA.locator('.message-item.sent .message-text', { hasText: editedText }))
        .toBeVisible({ timeout: 15000 });
      await expect(pageA.locator('.message-item.sent .message-edited').first()).toBeVisible();
      await waitWithSync(
        pageB,
        pageB.locator('.message-item.received .message-text', { hasText: editedText }),
        { timeout: 90000, reopenConversation: true }
      );
      await expect(pageB.locator('.message-item.received .message-edited').first()).toBeVisible();

      // Delete: Bob tombstones his reply (two-step inline confirm); both
      // sides render the tombstone.
      await pageB.locator('.message-item.sent .message-action-btn', { hasText: 'Delete' }).first().click();
      await pageB.locator('.message-item.sent .message-action-btn', { hasText: 'Confirm delete' }).first().click();
      await expect(pageB.locator('.message-item.sent.deleted .message-text'))
        .toHaveText('Message deleted', { timeout: 15000 });
      await waitWithSync(
        pageA,
        pageA.locator('.message-item.received.deleted .message-text'),
        { timeout: 90000, reopenConversation: true }
      );

      // Disappearing messages: set a short TTL via the client API (the UI
      // select offers minutes and up; 5s keeps the test fast), confirm the
      // encrypted control message propagates, then watch a message expire
      // from both vaults.
      const dmGroupId = `dm_${Math.min(alice.id, bob.id)}_${Math.max(alice.id, bob.id)}`;
      await pageA.evaluate(
        (groupId) => window.coreCryptoClient.setDisappearingTimer(groupId, 5),
        dmGroupId
      );
      await expect
        .poll(async () => {
          await pageB.evaluate(async () => {
            try { await window.coreCryptoClient.syncMessages(); } catch {}
          });
          return pageB.evaluate(
            (groupId) => window.coreCryptoClient.getDisappearingTimer(groupId),
            dmGroupId
          );
        }, { timeout: 60000, message: 'disappearing TTL propagated to Bob' })
        .toBe(5);

      const vanishingText = `now you see me ${Date.now()}`;
      await pageA.fill('textarea.message-textarea', vanishingText);
      await pageA.locator('button.send-button').click();
      await expect(pageA.locator('.message-item.sent .message-text', { hasText: vanishingText }))
        .toBeVisible({ timeout: 30000 });
      await waitWithSync(
        pageB,
        pageB.locator('.message-item.received .message-text', { hasText: vanishingText }),
        { timeout: 90000, reopenConversation: true }
      );

      // After the TTL elapses, reads purge the message on both sides.
      await pageA.waitForTimeout(6000);
      for (const page of [pageA, pageB]) {
        await expect
          .poll(async () => {
            await page.locator('.conversation-item').first().click();
            await page.waitForTimeout(500);
            return page.locator('.message-item .message-text', { hasText: vanishingText }).count();
          }, { timeout: 30000, message: 'expired message purged' })
          .toBe(0);
      }
    } finally {
      await contextA.close();
      await contextB.close();
    }
  });
});
