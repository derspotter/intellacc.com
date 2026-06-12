// Shared helpers for Solid messaging E2E specs (DM and group chats).
// Extracted from solid-messaging.spec.js; see that spec's header for the
// environment requirements (solid-local dev instance, docker DB access).

const { expect } = require('@playwright/test');
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

module.exports = {
  SOLID_URL,
  BACKEND_URL,
  PASSWORD,
  dbQuery,
  apiFetch,
  createUser,
  provisionTier,
  captureClientLogs,
  loginOnSolid,
  provisionMessaging,
  waitWithSync,
  cleanupUsers
};

// Best-effort removal of users this spec created. E2E runs hit the real
// backend/database, so without this test users accumulate in production.
function cleanupUsers(users) {
  const ids = (users || []).map((user) => Number(user?.id)).filter((id) => Number.isInteger(id) && id > 0);
  if (ids.length === 0) return;
  const list = ids.join(',');
  try {
    dbQuery(`
      CREATE TEMP TABLE purge_groups AS
        SELECT group_id FROM mls_direct_messages
         WHERE user_a_id IN (${list}) OR user_b_id IN (${list})
        UNION
        SELECT group_id FROM mls_groups WHERE created_by IN (${list});
      DELETE FROM mls_relay_queue WHERE group_id IN (SELECT group_id FROM purge_groups);
      DELETE FROM mls_group_members WHERE group_id IN (SELECT group_id FROM purge_groups);
      DELETE FROM mls_direct_messages WHERE group_id IN (SELECT group_id FROM purge_groups);
      DELETE FROM mls_groups WHERE group_id IN (SELECT group_id FROM purge_groups);
      DELETE FROM users WHERE id IN (${list});
    `);
  } catch (error) {
    console.warn('[e2e cleanup] failed to remove test users:', error?.message || error);
  }
}
