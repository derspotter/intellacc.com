const { test, expect } = require('@playwright/test');
const { exec } = require('child_process');
const crypto = require('crypto');

const VAN_URL = process.env.VAN_URL || 'http://127.0.0.1:5173';
const SOLID_URL = process.env.SOLID_URL || 'http://127.0.0.1:4174';
const BACKEND_URL = process.env.BACKEND_URL || 'http://127.0.0.1:3000';
const PASSWORD = 'password123';

function createUsers() {
  const suffix = `${Date.now()}${Math.floor(Math.random() * 10000)}`;
  return {
    solidUser: {
      username: `cfm_${suffix}_solid`,
      email: `cfm_${suffix}_solid@example.com`,
      password: PASSWORD
    },
    vanUser: {
      username: `cfm_${suffix}_van`,
      email: `cfm_${suffix}_van@example.com`,
      password: PASSWORD
    }
  };
}

async function resetServerState() {
  return new Promise((resolve) => {
    exec('./tests/e2e/reset-test-users.sh', () => resolve());
  });
}

async function signupOnSolid(page, user) {
  console.log(`[CFM] signupOnSolid: ${user.username}`);
  const approvedUser = await createAndApproveUser(user);
  await ensureMessagingReady(approvedUser);
  await loginOnSolidWithToken(page, approvedUser.token);
}

async function signupOnVan(page, user) {
  console.log(`[CFM] signupOnVan: ${user.username}`);
  const approvedUser = await createAndApproveUser(user);
  await ensureMessagingReady(approvedUser);
  await loginOnVan(page, user);
}

async function loginOnSolidWithToken(page, token) {
  await page.setViewportSize({ width: 1440, height: 1200 });
  await page.addInitScript((authToken) => {
    localStorage.setItem('token', authToken);
  }, token);
  await page.goto(`${SOLID_URL}/#home`);
  await expect(page.locator('a[href="#messages"]').first()).toBeVisible({ timeout: 20000 });
}

async function createAndApproveUser(user) {
  console.log(`[CFM] createAndApproveUser: ${user.username}`);
  const response = await fetch(`${BACKEND_URL}/api/users`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: user.username,
      email: user.email,
      password: user.password
    })
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`User registration failed (${response.status}): ${text}`);
  }

  const body = await response.json().catch(async () => {
    const text = await response.text();
    throw new Error(`Invalid JSON from registration API: ${text}`);
  });

  if (body.user?.id && body.requiresApproval) {
    const approvalToken = await getApprovalTokenFromDb(body.user.id);
    if (!approvalToken) {
      throw new Error(`No approval token found for user ${body.user.id}`);
    }

    const approvalResponse = await fetch(`${BACKEND_URL}/api/admin/users/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: approvalToken })
    });

    if (!approvalResponse.ok) {
      const text = await approvalResponse.text();
      throw new Error(`Approval failed for user ${body.user.id} (${approvalResponse.status}): ${text}`);
    }
  }

  const loginResponse = await fetch(`${BACKEND_URL}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: user.email,
      password: user.password
    })
  });

  if (!loginResponse.ok) {
    const text = await loginResponse.text();
    throw new Error(`Login failed for ${user.username} (${loginResponse.status}): ${text}`);
  }

  const loginBody = await loginResponse.json();
  if (!loginBody.token) {
    throw new Error(`Login response missing token for ${user.username}`);
  }

  return {
    ...body.user,
    token: loginBody.token
  };
}

function ensureMessagingReady(user) {
  console.log(`[CFM] ensureMessagingReady: ${user.username}`);
  const deviceId = crypto.randomUUID();
  const packageHex = crypto.randomBytes(16).toString('hex');
  const packageHash = crypto.createHash('sha256').update(packageHex).digest('hex');
  const sql = `
    INSERT INTO user_devices (user_id, device_public_id, name, is_primary, last_seen_at)
    VALUES (${Number(user.id)}, '${deviceId}'::uuid, 'E2E Solid Test Device', true, NOW())
    ON CONFLICT (device_public_id)
      DO UPDATE SET
        user_id = EXCLUDED.user_id,
        last_seen_at = NOW(),
        is_primary = true;

    INSERT INTO mls_key_packages (user_id, device_id, package_data, hash, is_last_resort, last_updated_at)
    VALUES (${Number(user.id)}, '${deviceId}', decode('${packageHex}', 'hex'), '${packageHash}', true, NOW())
    ON CONFLICT (user_id, device_id) WHERE is_last_resort = true
      DO UPDATE SET
        package_data = EXCLUDED.package_data,
        hash = EXCLUDED.hash,
        last_updated_at = NOW();
  `;

  return new Promise((resolve, reject) => {
    exec(
      `docker exec intellacc_db psql -U intellacc_user -d intellaccdb -v ON_ERROR_STOP=1 <<'SQL'\n${sql}\nSQL`,
      (err, stdout, stderr) => {
        if (err) {
          return reject(new Error(`Failed to provision messaging state for ${user.username}: ${stderr || err.message}`));
        }

        resolve(stdout);
      }
    );
  });
}

function getApprovalTokenFromDb(userId) {
  return new Promise((resolve, reject) => {
    const sql = `
      SELECT token
      FROM registration_approval_tokens
      WHERE user_id = ${Number(userId)}
        AND status = 'pending'
      ORDER BY created_at DESC
      LIMIT 1
    `;
    exec(
      `docker exec intellacc_db psql -U intellacc_user -d intellaccdb -t -A -c "${sql.replace(/\n/g, ' ')}"`,
      (err, stdout) => {
        if (err) {
          return reject(new Error(`Failed to fetch approval token: ${err.message}`));
        }

        const token = String(stdout || '').trim();
        resolve(token || null);
      }
    );
  });
}

async function loginOnVan(page, user) {
  console.log(`[CFM] loginOnVan: ${user.username}`);
  await page.setViewportSize({ width: 1440, height: 1200 });
  await page.goto(`${VAN_URL}/#login`);
  await page.locator('#email').fill(user.email);
  await page.locator('#password').fill(user.password);
  await page.getByRole('button', { name: 'Sign In' }).click();
  await expect(page.getByRole('button', { name: 'Logout' })).toBeVisible({ timeout: 20000 });
}

async function unlockSolidVaultIfNeeded(page, password) {
  const unlockBtn = page.getByRole('button', { name: '> UNLOCK VAULT' });
  if (await unlockBtn.isVisible().catch(() => false)) {
    await page.getByPlaceholder('Vault Password...').fill(password);
    await unlockBtn.click();
  }
}

function solidChatPanel(page) {
  return page.locator('.messages-page').first();
}

async function openDmOnSolid(page, otherUsername, timeoutMs = 45000) {
  console.log(`[CFM] openDmOnSolid waiting for ${otherUsername} (${timeoutMs}ms)`);
  await page.goto(`${SOLID_URL}/#messages`);
  const panel = solidChatPanel(page);
  await expect(panel).toBeVisible({ timeout: 20000 });

  const newButton = page.locator('button:has-text("+ New"), button:has-text("Create New")').first();
  await expect(newButton).toBeVisible({ timeout: 20000 });
  await newButton.click();

  const deadline = Date.now() + timeoutMs;
  const targetPattern = new RegExp(otherUsername, 'i');
  const searchInput = panel.locator('.new-conversation-panel input[placeholder="Search users..."]').first();
  await expect(searchInput).toBeVisible({ timeout: 10000 });
  await searchInput.fill(otherUsername);

  const resultRow = panel.locator('.new-conversation-panel li.user-row').filter({ hasText: targetPattern }).first();
  await expect(resultRow).toBeVisible({ timeout: 10000 });
  await resultRow.click();

  const startDmBtn = panel.locator('button:has-text("Start DM")').first();
  await expect(startDmBtn).toBeVisible({ timeout: 10000 });
  await startDmBtn.click();

  while (Date.now() < deadline) {
    const dmRow = panel.locator('.conversation-item.dm-item').filter({ hasText: targetPattern }).first();
    if (await dmRow.isVisible().catch(() => false)) {
      await dmRow.click();
      const input = panel.locator('textarea.message-textarea');
      if (await input.isEnabled().catch(() => false)) return;
    }

    await page.waitForTimeout(1000);
  }

  throw new Error(`Timed out waiting for Solid DM row for ${otherUsername}`);
}

async function waitForSolidIncomingText(page, text, timeoutMs = 45000) {
  console.log(`[CFM] waitForSolidIncomingText looking for: ${text}`);
  const panel = solidChatPanel(page);
  await expect(panel).toBeVisible({ timeout: 20000 });

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await panel.locator('.message-item.received .message-text').filter({ hasText: text }).first().isVisible().catch(() => false)) return;
    await panel.locator('button[title="Refresh"]').click().catch(() => {});
    await page.waitForTimeout(1000);
  }

  throw new Error('Timed out waiting for Solid to display incoming message');
}

async function sendFromSolid(page, text) {
  console.log(`[CFM] sendFromSolid: ${text}`);
  const panel = solidChatPanel(page);
  const input = panel.locator('.message-textarea');
  await expect(input).toBeEnabled({ timeout: 30000 });
  await input.fill(text);
  await panel.locator('.send-button').first().click();
  await expect(panel.getByText(text).first()).toBeVisible({ timeout: 20000 });
}

async function openVanMessagesUnlocked(page, password) {
  console.log('[CFM] openVanMessagesUnlocked');
  await page.goto(`${VAN_URL}/#messages`);
  await expect(page.locator('.messages-page')).toBeVisible({ timeout: 20000 });

  const unlockMessaging = page.getByRole('button', { name: 'Unlock Messaging' });
  if (await unlockMessaging.isVisible().catch(() => false)) {
    await unlockMessaging.click();
    await page.getByPlaceholder('Login Password').fill(password);
    await page.locator('.unlock-modal').getByRole('button', { name: 'Unlock' }).click();
  }

  const deviceModal = page.locator('.device-link-modal');
  if (await deviceModal.isVisible().catch(() => false)) {
    const cancelBtn = deviceModal.getByRole('button', { name: 'Cancel' });
    await cancelBtn.click();
  }
}

async function acceptWelcomeIfPresent(page) {
  console.log('[CFM] acceptWelcomeIfPresent');
  const acceptBtn = page.getByRole('button', { name: 'Accept' }).first();
  for (let i = 0; i < 8; i += 1) {
    if (await acceptBtn.isVisible().catch(() => false)) {
      await acceptBtn.click();
      return;
    }
    await page.waitForTimeout(750);
  }
}

async function startDmFromVan(page, targetUsername) {
  console.log(`[CFM] startDmFromVan for ${targetUsername}`);
  const newBtn = page.locator('button:has-text("+ New"), button:has-text("New"), button:has-text("New DM")').first();
  await expect(newBtn).toBeVisible({ timeout: 20000 });
  await newBtn.click();

  const searchInput = page.locator('input[placeholder*="Search"], input[placeholder*="search"], input[placeholder*="USER"], input[placeholder*="Username"]').first();
  await expect(searchInput).toBeVisible({ timeout: 20000 });

  const targetPattern = new RegExp(targetUsername, 'i');
  await searchInput.fill('');
  await searchInput.fill(targetUsername);

  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    const userRow = page
      .locator('.user-row, .user-item, [data-user], .search-result-item')
      .filter({ hasText: targetPattern })
      .first();

    if (await userRow.isVisible().catch(() => false)) {
      await userRow.click();

      const startDmBtn = page.locator('button:has-text("Start DM"), button:has-text("Start"), button:has-text("Message")').first();
      if (await startDmBtn.isVisible().catch(() => false)) {
        await startDmBtn.click();
        return;
      }
    }

    await page.waitForTimeout(1000);
  }

  throw new Error(`Timed out finding ${targetUsername} in Van users for DM`);
}

async function openDmOnVan(page, otherUsername) {
  console.log(`[CFM] openDmOnVan waiting for ${otherUsername}`);
  const pattern = new RegExp(otherUsername, 'i');
  const deadline = Date.now() + 40000;
  while (Date.now() < deadline) {
    const dm = page.locator('.conversation-item, .chat-item, .dm-item, .mls-group, .conversation-list-item').filter({ hasText: pattern }).first();
    await page.locator('button:has-text("Refresh"), button:has-text("Reload"), button:has-text("Sync")').first().click().catch(() => {});
    if (await dm.isVisible().catch(() => false)) {
      await dm.click();
      return;
    }
    await page.waitForTimeout(1000);
  }

  throw new Error(`Timed out waiting for Van DM row for ${otherUsername}`);
}

async function sendFromVan(page, text) {
  console.log(`[CFM] sendFromVan: ${text}`);
  const msgInput = page.locator('.message-textarea').first();
  const sendButton = page.locator('.send-button, button:has-text("Send"), button[aria-label="Send"]').first();

  await expect(msgInput).toBeVisible({ timeout: 20000 });
  await expect(msgInput).toBeEditable({ timeout: 10000 });
  await expect(sendButton).toBeVisible({ timeout: 20000 });

  await msgInput.fill(text);
  await sendButton.click();
    await expect(page.locator('.message-item.sent .message-text').filter({ hasText: text })).toBeVisible({ timeout: 15000 });
}

test.describe('Cross-Frontend Messaging Interop', () => {
  test.beforeAll(async () => {
    await resetServerState();
  });

  test('Solid user and Van user can exchange messages', async ({ browser }) => {
    test.setTimeout(300000);

    const { solidUser, vanUser } = createUsers();
    console.log(`[CFM] users: solid=${solidUser.username}, van=${vanUser.username}`);

    const solidCtx = await browser.newContext();
    const solidPage = await solidCtx.newPage();
    const vanCtx = await browser.newContext();
    const vanPage = await vanCtx.newPage();

    const msgVanToSolid = `van->solid ${Date.now()}`;
    const msgSolidToVan = `solid->van ${Date.now() + 1}`;

    // Create fresh accounts to avoid fixture coupling.
    await signupOnSolid(solidPage, solidUser);
    await signupOnVan(vanPage, vanUser);

    // Re-establish clean sessions where needed.
    await openVanMessagesUnlocked(vanPage, vanUser.password);
    await acceptWelcomeIfPresent(vanPage);

    // Van initiates DM and sends first message.
    await startDmFromVan(vanPage, solidUser.username);
    await sendFromVan(vanPage, msgVanToSolid);

    // Solid receives and replies via Solid UI.
    await loginOnSolid(solidPage, solidUser);
    await unlockSolidVaultIfNeeded(solidPage, solidUser.password);
    await openDmOnSolid(solidPage, vanUser.username, 90000);
    await waitForSolidIncomingText(solidPage, msgVanToSolid, 90000);
    await sendFromSolid(solidPage, msgSolidToVan);

    // Van receives Solid reply.
    await openVanMessagesUnlocked(vanPage, vanUser.password);
    await acceptWelcomeIfPresent(vanPage);
    await openDmOnVan(vanPage, solidUser.username);
    await expect(vanPage.locator('.message-item.received .message-text').filter({ hasText: msgSolidToVan })).toBeVisible({ timeout: 15000 });

    await solidCtx.close();
    await vanCtx.close();
  });
});
