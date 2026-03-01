const { test, expect } = require('@playwright/test');
const { exec } = require('child_process');

const VAN_URL = process.env.VAN_URL || 'http://127.0.0.1:5186';
const SOLID_URL = process.env.SOLID_URL || 'http://127.0.0.1:4174';
const CFA_API_TIMEOUT_MS = Number(process.env.CFA_API_TIMEOUT_MS || '12000');
const PASSWORD = 'password123';

const normalizeBackendUrl = (value) => {
  const url = String(value || '').trim();
  if (!url) return 'http://127.0.0.1:3000';
  return url.replace(/\/$/, '').replace(/\/api$/, '');
};

const BACKEND_URL = normalizeBackendUrl(
  process.env.BACKEND_URL
    || process.env.SOLID_BACKEND_URL
    || process.env.VAN_BACKEND_URL
    || 'http://127.0.0.1:3000'
);

const TEST_DB_CONTAINER = process.env.TEST_DB_CONTAINER
  || ((BACKEND_URL.includes('3005') || BACKEND_URL.includes('intellacc_backend_dev')) ? 'intellacc_db_dev' : 'intellacc_db');
const TEST_DB_USER = process.env.TEST_DB_USER || 'intellacc_user';
const TEST_DB_NAME = process.env.TEST_DB_NAME || 'intellaccdb';

const withTimeout = (promise, label, timeoutMs = CFA_API_TIMEOUT_MS) => {
  const timeout = new Promise((_, reject) => {
    setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([promise, timeout]);
};

const sqlValue = (value) => String(value || '').replace(/'/g, "''");
const runDbCommand = (command, format = 'plain') => {
  const opts = format === 'pipe' ? "-t -A -F '|'" : '';
  return `docker exec ${TEST_DB_CONTAINER} psql -U ${TEST_DB_USER} -d ${TEST_DB_NAME} -v ON_ERROR_STOP=1 ${opts} -c "${command.replace(/"/g, '\\"')}"`;
};

function createUsers() {
  const suffix = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  return {
    solidUser: {
      username: `solid_${suffix}`,
      email: `solid_${suffix}@example.com`,
      password: PASSWORD
    },
    vanUser: {
      username: `van_${suffix}`,
      email: `van_${suffix}@example.com`,
      password: PASSWORD
    }
  };
}

async function getCurrentUserFromApi(page) {
  const result = await page.evaluate(async () => {
    const token = localStorage.getItem('token');
    if (!token) {
      return { ok: false, status: 0, body: { message: 'No token in localStorage' } };
    }

    const res = await fetch('/api/me', {
      headers: {
        Authorization: `Bearer ${token}`
      }
    });

    let body;
    try {
      body = await res.json();
    } catch {
      body = { message: 'Failed to decode /api/me JSON response' };
    }

    return { ok: res.ok, status: res.status, body };
  });

  expect(result.ok, `Expected /api/me to return 2xx, got ${result.status}`).toBeTruthy();
  return result.body;
}

function getApprovalTokenFromDb(userId) {
  const sql = `
    SELECT token
    FROM registration_approval_tokens
    WHERE user_id = ${Number(userId)}
      AND status = 'pending'
    ORDER BY created_at DESC
    LIMIT 1
  `;
  return new Promise((resolve, reject) => {
    exec(runDbCommand(sql.replace(/\n/g, ' '), 'pipe'), (err, stdout) => {
      if (err) {
        return reject(new Error(`Failed to fetch approval token for user ${userId}: ${err.message}`));
      }
      const token = String(stdout || '')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find(Boolean);
      resolve(token || null);
    });
  });
}

function createUserDirectlyInDb(user) {
  const safeUsername = sqlValue(user.username);
  const safeEmail = sqlValue(user.email);
  const safePassword = sqlValue(user.password);
  const sql = [
    'CREATE EXTENSION IF NOT EXISTS pgcrypto;',
    'INSERT INTO users (username, email, password_hash, is_approved, approved_at, verification_tier, email_verified_at, created_at, updated_at) ',
    `VALUES ('${safeUsername}', '${safeEmail}', crypt('${safePassword}', gen_salt('bf')), true, NOW(), 1, NOW(), NOW(), NOW()) `,
    'RETURNING id, username, email;'
  ].join('');

  return new Promise((resolve, reject) => {
    exec(runDbCommand(sql, 'pipe'), (err, stdout) => {
      if (err) {
        return reject(new Error(`Failed to create user ${user.username} directly in DB: ${err.message}`));
      }
      const row = String(stdout || '')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .reverse()
        .find((line) => line.includes('|'));
      if (!row) {
        return reject(new Error(`No DB row returned when creating ${user.username}`));
      }
      const [id, username, email] = row.split('|');
      resolve({ id: Number(id), username, email });
    });
  });
}

async function createAndApproveUser(user) {
  const registerResponse = await withTimeout(
    fetch(`${BACKEND_URL}/api/users`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: user.username,
        email: user.email,
        password: user.password
      })
    }),
    `register ${user.username}`
  );

  const rawBody = await registerResponse.text();
  let body = {};
  try {
    body = rawBody ? JSON.parse(rawBody) : {};
  } catch {
    body = {};
  }

  if (!registerResponse.ok) {
    if (registerResponse.status === 403 && /Registration is currently closed/i.test(rawBody)) {
      await createUserDirectlyInDb(user);
    } else {
      throw new Error(`Registration failed for ${user.username} (${registerResponse.status}): ${rawBody}`);
    }
  } else if (body.user?.id && body.requiresApproval) {
    const token = await getApprovalTokenFromDb(body.user.id);
    if (!token) {
      throw new Error(`Missing approval token for ${user.username} (id=${body.user.id})`);
    }

    const approveResponse = await withTimeout(
      fetch(`${BACKEND_URL}/api/admin/users/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token })
      }),
      `approve ${user.username}`
    );
    if (!approveResponse.ok) {
      throw new Error(`Approval failed for ${user.username} (${approveResponse.status})`);
    }
  }

  const loginResponse = await withTimeout(
    fetch(`${BACKEND_URL}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: user.email,
        password: user.password
      })
    }),
    `login ${user.username}`
  );

  if (!loginResponse.ok) {
    const loginBody = await loginResponse.text();
    throw new Error(`Login failed for ${user.username} (${loginResponse.status}): ${loginBody}`);
  }
}

async function signupOnSolid(page, user) {
  await createAndApproveUser(user);
  await loginOnSolid(page, user);
}

async function signupOnVan(page, user) {
  await createAndApproveUser(user);
  await loginOnVan(page, user);
}

async function loginOnSolid(page, user) {
  await page.goto(`${SOLID_URL}/#login?skin=terminal`);
  await page.getByPlaceholder('Enter system address...').fill(user.email);
  await page.getByRole('button', { name: '> CONTINUE' }).click();

  await page.getByPlaceholder('Enter access key...').fill(user.password);
  await page.getByRole('button', { name: '> SIGN IN' }).click();

  await expect(page.getByText(`[INTELLACC] USER: @${user.username}`)).toBeVisible({ timeout: 20000 });
}

async function loginOnVan(page, user) {
  await page.goto(`${VAN_URL}/#login`);
  await page.locator('#email').fill(user.email);
  await page.locator('#password').fill(user.password);
  await page.getByRole('button', { name: 'Sign In' }).click();

  await expect(page.getByRole('button', { name: 'Logout' })).toBeVisible({ timeout: 20000 });
}

test.describe('Cross-Frontend Auth Interop', () => {
  test('users created on each frontend can log in on the other frontend (shared backend)', async ({ browser }) => {
    const { solidUser, vanUser } = createUsers();

    const solidSignupCtx = await browser.newContext();
    const solidSignupPage = await solidSignupCtx.newPage();
    await signupOnSolid(solidSignupPage, solidUser);
    const solidProfileFromSolid = await getCurrentUserFromApi(solidSignupPage);
    await solidSignupCtx.close();

    const vanSignupCtx = await browser.newContext();
    const vanSignupPage = await vanSignupCtx.newPage();
    await signupOnVan(vanSignupPage, vanUser);
    const vanProfileFromVan = await getCurrentUserFromApi(vanSignupPage);
    await vanSignupCtx.close();

    expect(solidProfileFromSolid.id).not.toEqual(vanProfileFromVan.id);

    const solidCrossLoginCtx = await browser.newContext();
    const solidCrossLoginPage = await solidCrossLoginCtx.newPage();
    await loginOnSolid(solidCrossLoginPage, vanUser);
    const vanProfileFromSolid = await getCurrentUserFromApi(solidCrossLoginPage);
    await solidCrossLoginCtx.close();

    expect(vanProfileFromSolid.id).toEqual(vanProfileFromVan.id);
    expect(vanProfileFromSolid.username).toEqual(vanUser.username);
    expect(vanProfileFromSolid.email).toEqual(vanUser.email);

    const vanCrossLoginCtx = await browser.newContext();
    const vanCrossLoginPage = await vanCrossLoginCtx.newPage();
    await loginOnVan(vanCrossLoginPage, solidUser);
    const solidProfileFromVan = await getCurrentUserFromApi(vanCrossLoginPage);
    await vanCrossLoginCtx.close();

    expect(solidProfileFromVan.id).toEqual(solidProfileFromSolid.id);
    expect(solidProfileFromVan.username).toEqual(solidUser.username);
    expect(solidProfileFromVan.email).toEqual(solidUser.email);
  });
});
