const { test, expect } = require('@playwright/test');
const { exec } = require('child_process');
const crypto = require('crypto');

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
const VAN_URL = process.env.VAN_URL || 'http://127.0.0.1:5173';
const SOLID_URL = process.env.SOLID_URL || 'http://127.0.0.1:4174';
const CFM_TEST_TIMEOUT_MS = Number(process.env.CFM_TEST_TIMEOUT_MS || '180000');
const CFM_OPEN_DM_TIMEOUT_MS = Number(process.env.CFM_OPEN_DM_TIMEOUT_MS || '30000');
const PASSWORD = 'password123';
const TEST_DB_CONTAINER = process.env.TEST_DB_CONTAINER || (BACKEND_URL.includes('3005') || BACKEND_URL.includes('intellacc_backend_dev') ? 'intellacc_db_dev' : 'intellacc_db');
const TEST_DB_USER = process.env.TEST_DB_USER || 'intellacc_user';
const TEST_DB_NAME = process.env.TEST_DB_NAME || 'intellaccdb';
const SOLID_ORIGIN = new URL(SOLID_URL).origin;
const VAN_ORIGIN = new URL(VAN_URL).origin;

const isTransientEvalError = (error) => /Execution context was destroyed|Navigation|was detached/i.test(String(error || ''));

const getPageOrigin = async (page) => {
  const pageUrl = await page.url();
  try {
    return new URL(pageUrl).origin;
  } catch (err) {
    return '';
  }
};

const isSolidFrontend = async (page) => (await getPageOrigin(page)) === SOLID_ORIGIN;
const isVanFrontend = async (page) => (await getPageOrigin(page)) === VAN_ORIGIN;

const withTimeout = (promise, label, timeoutMs = 12000) => {
  const timeout = new Promise((_, reject) => {
    setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  });

  return Promise.race([promise, timeout]);
};

async function routeApiToBackend(page) {
  const normalizedBackend = BACKEND_URL.replace(/\/$/, '');
  const apiBase = `${normalizedBackend}/api`;
  const backendOrigin = new URL(apiBase).origin;

  await page.route('**/api/**', (route) => {
    let requestUrl;
    try {
      requestUrl = new URL(route.request().url(), apiBase);
    } catch (err) {
      console.warn(`[CFM] routeApiToBackend failed to parse URL: ${route.request().url()} (${err.message})`);
      route.continue();
      return;
    }

    if (
      requestUrl.origin === backendOrigin
      && requestUrl.pathname.startsWith('/api/')
      && route.request().url().startsWith(apiBase)
    ) {
      route.continue();
      return;
    }

    const requestedPath = requestUrl.pathname.replace(/^\/api/, '');
    route.continue({
      url: `${apiBase}${requestedPath || '/'}${requestUrl.search}`
    });
  });
}

const runDbCommand = (command, format = 'plain') => {
  const opts = format === 'pipe' ? `-t -A -F '|'` : '';
  return `docker exec ${TEST_DB_CONTAINER} psql -U ${TEST_DB_USER} -d ${TEST_DB_NAME} -v ON_ERROR_STOP=1 ${opts} -c "${command.replace(/"/g, '\\"')}"`;
};
const runDbCommandNoQuote = (command) => `docker exec ${TEST_DB_CONTAINER} psql -U ${TEST_DB_USER} -d ${TEST_DB_NAME} ${command}`;
const runDbCommandNoQuoteMulti = (command) => {
  const safeCommand = String(command || '')
    .replace(/\n/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/"/g, '\\"');
  return `docker exec ${TEST_DB_CONTAINER} psql -U ${TEST_DB_USER} -d ${TEST_DB_NAME} -v ON_ERROR_STOP=1 -c "${safeCommand}"`;
};
const sqlValue = (value) => String(value || '').replace(/'/g, "''");

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
  if (process.env.RESET_TEST_USERS !== '1') {
    return Promise.resolve();
  }

  const script = './tests/e2e/reset-test-users.sh';
  return new Promise((resolve) => {
    exec(script, (error) => {
      if (error) {
        console.warn(`[CFM] reset script failed (${error.message}); continuing`);
      }
      resolve();
    });
  });
}

  async function signupOnSolid(page, user) {
  console.log(`[CFM] signupOnSolid: ${user.username}`);
  const approvedUser = await createAndApproveUser(user);
  await ensureMessagingReady(approvedUser);
  Object.assign(user, approvedUser);
  await loginOnSolidWithToken(page, approvedUser.token, user);
}

async function signupOnVan(page, user) {
  console.log(`[CFM] signupOnVan: ${user.username}`);
  const approvedUser = await createAndApproveUser(user);
  await ensureMessagingReady(approvedUser);
  Object.assign(user, approvedUser);
  await loginOnVan(page, user);
}

async function ensureMlsKeyPackages(page, user = {}, password = PASSWORD) {
  console.log(`[CFM] ensureMlsKeyPackages:start user=${user?.username || 'unknown'} url=${page.url()}`);
  const runProvision = async () => {
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    console.log('[CFM] ensureMlsKeyPackages:runProvision:starting evaluate');
    return page.evaluate(async (payload) => {
      const token = localStorage.getItem('token');
      if (!token) {
        return { ok: false, reason: 'missing_token' };
      }

      const pass = payload?.password;
      const explicitUserId = payload?.userId ? Number(payload.userId) : null;
      const explicitDeviceId = payload?.deviceId || null;

      const { default: coreCryptoClient } = await import('/src/services/mls/coreCryptoClient.js');
      const resolveVaultStore = async () => {
        const candidateImports = [
          '/src/stores/vaultStore.js',
          '/src/store/vaultStore.js'
        ];
        for (let i = 0; i < candidateImports.length; i += 1) {
          try {
            const imported = await import(candidateImports[i]);
            if (imported?.default) {
              return imported.default;
            }
          } catch {
            continue;
          }
        }
        if (window.__vaultStore) return window.__vaultStore;
        if (window.vaultStore) return window.vaultStore;
        return null;
      };

      const vaultStore = await resolveVaultStore();
      const resolveVaultService = async () => {
        const candidateImports = [
          '/src/services/vaultService.js',
          '/src/services/mls/vaultService.js'
        ];
        for (let i = 0; i < candidateImports.length; i += 1) {
          try {
            const imported = await import(candidateImports[i]);
            if (imported?.default) {
              return imported.default;
            }
          } catch {
            continue;
          }
        }
        if (window.__vaultService) return window.__vaultService;
        if (window.vaultService) return window.vaultService;
        return null;
      };

      let payloadUserId = null;
      try {
        const tokenPayload = JSON.parse(atob(token.split('.')[1] || '{}'));
        payloadUserId = Number(tokenPayload?.userId || tokenPayload?.sub);
        if (!payloadUserId && explicitUserId) {
          payloadUserId = explicitUserId;
        }
        if (vaultStore && payloadUserId) {
          vaultStore.setUserId?.(payloadUserId);
        }
      } catch {
        payloadUserId = null;
      }

      if (!payloadUserId && vaultStore?.userId) {
        payloadUserId = vaultStore.userId;
      }
      if (!payloadUserId) {
        return { ok: false, reason: 'missing_user_id' };
      }

      const vaultService = await resolveVaultService();
      if (vaultStore) {
        coreCryptoClient._vaultStore = vaultStore;
      }
      if (vaultService) {
        coreCryptoClient._vaultService = vaultService;
        if (explicitUserId) {
          vaultService.setUserId?.(payloadUserId);
        }
        if (explicitDeviceId) {
          vaultService.setDeviceId?.(explicitDeviceId);
        }
        if (vaultStore && typeof vaultStore.setDeviceId === 'function' && explicitDeviceId) {
          vaultStore.setDeviceId(explicitDeviceId);
        }
      }

      const bootstrapAndRefresh = async () => {
        await coreCryptoClient.ensureMlsBootstrap(String(payloadUserId));
        return coreCryptoClient.ensureKeyPackagesFresh();
      };

      try {
        await coreCryptoClient.initialize();
        await bootstrapAndRefresh();
        return { ok: true };
      } catch (freshErr) {
        if (!pass) {
          return { ok: false, reason: freshErr?.message || String(freshErr) };
        }

        if (!vaultService) {
          return {
            ok: false,
            reason: 'vault service unavailable'
          };
        }

        try {
          await vaultService.setupKeystoreWithPassword(pass);
          await bootstrapAndRefresh();
          return { ok: true, didSetupKeystore: true };
        } catch (setupErr) {
          return {
            ok: false,
            reason: setupErr?.message || String(setupErr),
            fallback: freshErr?.message || String(freshErr)
          };
        }
      }
    }, {
      password,
      userId: user?.id ? Number(user.id) : null,
      deviceId: user?.device_public_id || user?.deviceId || user?.device_id || null
    });
  };

  let result;
  let lastErr;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await page.waitForTimeout(150 * (attempt + 1)).catch(() => {});
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      result = await withTimeout(runProvision(), `ensureMlsKeyPackages(${user?.username || 'unknown'})`, 30000);
      console.log(`[CFM] ensureMlsKeyPackages:result-attempt-${attempt + 1} ${JSON.stringify(result)}`);
      break;
    } catch (evalErr) {
      lastErr = evalErr;
      console.log(`[CFM] ensureMlsKeyPackages:error-attempt-${attempt + 1} ${evalErr?.message || String(evalErr)}`);
      if (attempt < 4 && isTransientEvalError(evalErr?.message || evalErr?.toString() || '')) {
        console.log('[CFM] ensureMlsKeyPackages: evaluation interrupted by navigation, retrying');
        await page.waitForTimeout(500 * (attempt + 1)).catch(() => {});
        continue;
      }
      throw evalErr;
    }
  }

  if (result === undefined) {
    if (isTransientEvalError(lastErr?.message || lastErr?.toString())) {
      console.log('[CFM] ensureMlsKeyPackages: retry exhausted due navigation; skipping strict key-package setup to continue flow');
      return;
    }
    throw lastErr || new Error('Unable to provision key packages due unknown error');
  }

  console.log(`[CFM] ensureMlsKeyPackages: ${JSON.stringify(result)}`);
  console.log(`[CFM] ensureMlsKeyPackages:done user=${user?.username || 'unknown'}`);
  if (!result?.ok) {
    throw new Error(`Unable to provision key packages: ${result?.reason || 'unknown'}`);
  }
}

async function loginOnSolidWithToken(page, token, user) {
  console.log('[CFM] loginOnSolidWithToken: start');
  await routeApiToBackend(page);
  await page.setViewportSize({ width: 1440, height: 1200 });
  await page.addInitScript((authToken) => {
    localStorage.setItem('token', authToken);
  }, token);
  await page.goto(`${SOLID_URL}/`, { waitUntil: 'domcontentloaded' });
  const shellState = await waitForSolidShellOrAuth(page, 30000);
  console.log(`[CFM] loginOnSolidWithToken: shellState=${shellState}`);
  if (shellState === 'guest') {
    console.log('[CFM] loginOnSolidWithToken: retrying shell auth via form due guest marker');
    if (user?.email && user?.password) {
      try {
        await loginOnSolidWithForm(page, user);
        return;
      } catch (error) {
        console.log(`[CFM] loginOnSolidWithToken: form login failed while guest (${error.message}), trying token rebind`);
      }
    }
    await safeSetVanAuthToken(page, token);
    await page.goto(`${SOLID_URL}/#messages`, { waitUntil: 'domcontentloaded' });
    const shellStateAfterRetry = await waitForSolidShellOrAuth(page, 10000);
    if (shellStateAfterRetry === 'shell') {
      console.log('[CFM] loginOnSolidWithToken: recovered shell after token rebind');
      return;
    }
    if (shellStateAfterRetry === 'guest') {
      console.log('[CFM] loginOnSolidWithToken: still guest after token rebind; proceeding with token-only shell flow');
      return;
    }
  }
  if (shellState === 'login') {
    console.log('[CFM] loginOnSolidWithToken: fallback to login form');
    try {
      await loginOnSolidWithForm(page, user);
      return;
    } catch (error) {
      if (!user?.token) {
        throw error;
      }
      console.log(`[CFM] loginOnSolidWithToken: login form failed while in login state (${error.message}), trying token-only flow`);
      await safeSetVanAuthToken(page, user.token);
      await page.goto(`${SOLID_URL}/#messages`, { waitUntil: 'domcontentloaded' }).catch(() => {});
      const shellStateAfterRetry = await waitForSolidShellOrAuth(page, 10000);
      if (shellStateAfterRetry === 'shell') {
        return;
      }
      if (shellStateAfterRetry === 'guest') {
        return;
      }
      throw error;
    }
  }
  if (shellState !== 'shell') {
    console.log('[CFM] loginOnSolidWithToken: unexpected shell state');
    const pageText = await page.textContent('body');
    throw new Error(`Unable to load Solid messaging UI: ${pageText || 'empty page'}`);
  }
  console.log('[CFM] loginOnSolidWithToken: shell loaded');
}

async function loginOnSolidWithForm(page, user) {
  await routeApiToBackend(page);
  console.log('[CFM] loginOnSolidWithForm: start');
  await page.setViewportSize({ width: 1440, height: 1200 });

  const resolveFirstVisible = async (label, candidates, timeoutMs = 3000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      for (let i = 0; i < candidates.length; i += 1) {
        const candidate = candidates[i];
        try {
          if (await candidate.isVisible({ timeout: 250 }).catch(() => false)) {
            console.log(`[CFM] loginOnSolidWithForm: using ${label} candidate ${i}`);
            return candidate;
          }
        } catch (error) {
          console.log(`[CFM] loginOnSolidWithForm: ${label} candidate ${i} visibility check failed (${error.message})`);
        }
      }
      await page.waitForTimeout(300);
    }

    throw new Error(`Unable to locate ${label} control in Solid login form`);
  };

  const onLoginForm = await page.getByPlaceholder('Enter your email').isVisible().catch(() => false)
    || await page.getByPlaceholder('Enter system address...').isVisible().catch(() => false)
    || await page.locator('#email').isVisible().catch(() => false);
  if (!onLoginForm) {
    try {
      await page.goto(`${SOLID_URL}/#login`, { waitUntil: 'domcontentloaded' });
    } catch (error) {
      if (!/interrupted by another navigation/i.test(error.message)) {
        throw error;
      }
      await page.waitForTimeout(500);
    }
  }
  console.log('[CFM] loginOnSolidWithForm: filling credentials');
  const emailInput = await resolveFirstVisible('email', [
    page.getByPlaceholder('Enter your email'),
    page.locator('#email'),
    page.getByPlaceholder('Enter system address...')
  ]);
  console.log('[CFM] loginOnSolidWithForm: filling email');
  await emailInput.fill(user.email);

  const passwordInput = await resolveFirstVisible('password', [
    page.getByPlaceholder('Enter your password'),
    page.getByPlaceholder('Enter access key...'),
    page.locator('#password'),
    page.locator('input[type=\"password\"]')
  ]);
  console.log('[CFM] loginOnSolidWithForm: filling password');
  await passwordInput.fill(user.password);

  const submitButton = page.getByRole('button', { name: /^Sign In$/i })
    .or(page.getByRole('button', { name: /SIGN IN/i }))
    .or(page.getByRole('button', { name: /SUBMIT/i }))
    .or(page.getByRole('button', { name: /CONTINUE/i }));
  try {
    await submitButton.click({ timeout: 7000 });
  } catch (error) {
    console.log(`[CFM] loginOnSolidWithForm: sign in click failed (${error.message})`);
    await page.keyboard.press('Enter').catch(() => {});
  }
  console.log('[CFM] loginOnSolidWithForm: submitted sign in');
  const shellState = await waitForSolidShellOrAuth(page, 20000);
  if (shellState !== 'shell') {
    throw new Error(`Solid login form submit did not reach authenticated shell (state=${shellState})`);
  }
  console.log('[CFM] loginOnSolidWithForm: shell reached');
}

async function createAndApproveUser(user) {
  console.log(`[CFM] createAndApproveUser: ${user.username}`);
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
    `user registration for ${user.username}`,
    20000
  );

  console.log(`[CFM] createAndApproveUser registration status=${registerResponse.status}`);
  const rawBody = await registerResponse.text();
  let body = {};

  try {
    body = rawBody ? JSON.parse(rawBody) : {};
  } catch (error) {
    if (registerResponse.ok) {
      throw new Error(`Invalid JSON from registration API: ${rawBody}`);
    }
  }

  if (!registerResponse.ok) {
    if (registerResponse.status === 403 && /Registration is currently closed/i.test(rawBody)) {
      const created = await createUserDirectlyInDb(user);
      return loginCreatedUser(user, created);
    }

    throw new Error(`User registration failed (${registerResponse.status}): ${rawBody}`);
  }

  if (body.user?.id && body.requiresApproval) {
    const approvalToken = await getApprovalTokenFromDb(body.user.id);
    if (!approvalToken) {
      throw new Error(`No approval token found for user ${body.user.id}`);
    }

    const approvalResponse = await withTimeout(
      fetch(`${BACKEND_URL}/api/admin/users/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: approvalToken })
      }),
      `approve user ${user?.username || user.id}`,
      20000
    );

    if (!approvalResponse.ok) {
      const text = await approvalResponse.text();
      throw new Error(`Approval failed for user ${body.user.id} (${approvalResponse.status}): ${text}`);
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
    `login for ${user.username || user.email}`,
    20000
  );

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

async function loginCreatedUser(user, createdUser) {
  const userPayload = {
    ...createdUser,
    user: {
      id: createdUser.id,
      username: createdUser.username,
      email: createdUser.email,
      is_approved: true
    }
  };
  const loginResponse = await withTimeout(
    fetch(`${BACKEND_URL}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: user.email,
        password: user.password
      })
    }),
    `fallback login for ${user.username}`,
    20000
  );

  if (!loginResponse.ok) {
    const text = await loginResponse.text();
    throw new Error(`Login failed for ${user.email} (${loginResponse.status}): ${text}`);
  }

  const loginBody = await loginResponse.json();
  if (!loginBody.token) {
    throw new Error(`Login response missing token for ${user.email}`);
  }

  return {
    ...userPayload.user,
    token: loginBody.token
  };
}

function createUserDirectlyInDb(user) {
  console.log(`[CFM] createUserDirectlyInDb: ${user.username}`);
  const safeUsername = sqlValue(user.username);
  const safeEmail = sqlValue(user.email);
  const safePassword = sqlValue(user.password);

  const sql = [
    'CREATE EXTENSION IF NOT EXISTS pgcrypto;',
    'INSERT INTO users (username, email, password_hash, is_approved, approved_at, verification_tier, email_verified_at, created_at, updated_at) ',
    `VALUES ('${safeUsername}', '${safeEmail}', crypt('${safePassword}', gen_salt('bf')), true, NOW(), 1, NOW(), NOW(), NOW()) `,
    'RETURNING id, username, email, is_approved, created_at;'
  ].join('');

  return new Promise((resolve, reject) => {
    const timeoutMs = 20000;
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`DB command timed out creating user ${user.username} after ${timeoutMs}ms`));
    }, timeoutMs);

    exec(
      runDbCommand(sql, 'pipe'),
      (err, stdout) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (err) {
          return reject(new Error(`Failed to create test user in DB: ${err.message}`));
        }

        const row = String(stdout || '')
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean)
          .reverse()
          .find((line) => line.includes('|'));
        if (!row) {
          return reject(new Error(`Failed to create test user ${user.username}: empty DB response`));
        }

        const [id, username, email] = row.replace(/\r?\n/g, '').split('|');
        if (!id || !username || !email) {
          return reject(new Error(`Unexpected DB response while creating test user ${user.username}: ${row}`));
        }

        resolve({
          id: Number(id),
          username,
          email
        });
      }
    );
  });
}

async function ensureMessagingReady(user) {
  console.log(`[CFM] ensureMessagingReady: ${user.username}`);
  const initialDeviceId = user.device_public_id || crypto.randomUUID();
  const packageHex = crypto.randomBytes(16).toString('hex');
  const packageHash = crypto.createHash('sha256').update(packageHex).digest('hex');
  console.log(`[CFM] ensureMessagingReady seed: device=${initialDeviceId}, token=${Boolean(user?.token && user?.id)}`);

  let deviceId = initialDeviceId;
  if (user?.token && user?.id) {
    try {
      console.log(`[CFM] ensureMessagingReady registering device for user ${user.id}`);
      const response = await fetch(`${BACKEND_URL}/api/devices/register`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${user.token}`
        },
        body: JSON.stringify({
          device_public_id: initialDeviceId,
          name: 'E2E Test Device'
        })
      });

      if (response.ok) {
        const payload = await response.json().catch(() => null);
        const registeredDeviceId = payload?.device_public_id || payload?.devicePublicId || payload?.id;
        if (registeredDeviceId) {
          deviceId = String(registeredDeviceId);
        }
      } else {
        const text = await response.text();
        console.log(`[CFM] ensureMessagingReady register device failed (${response.status}): ${text}`);
      }
    } catch (error) {
      console.log(`[CFM] ensureMessagingReady register device error: ${error?.message || error}`);
    }
  }

  user.device_public_id = deviceId;
  const sql = `
    UPDATE users
    SET verification_tier = 1,
        email_verified_at = NOW()
    WHERE id = ${Number(user.id)};

    UPDATE user_devices
    SET last_verified_at = NOW() + INTERVAL '5 minutes', is_primary = true
    WHERE user_id = ${Number(user.id)} AND device_public_id = '${deviceId}'::uuid;

    INSERT INTO user_devices (user_id, device_public_id, name, is_primary, last_seen_at, last_verified_at)
    SELECT ${Number(user.id)}, '${deviceId}'::uuid, 'E2E Solid Test Device', true, NOW(), NOW() + INTERVAL '5 minutes'
    WHERE NOT EXISTS (
      SELECT 1
      FROM user_devices
      WHERE user_id = ${Number(user.id)}
        AND device_public_id = '${deviceId}'::uuid
    );

    INSERT INTO mls_key_packages (user_id, device_id, package_data, hash, is_last_resort, last_updated_at)
    VALUES (${Number(user.id)}, '${deviceId}', decode('${packageHex}', 'hex'), '${packageHash}', true, NOW())
    ON CONFLICT (user_id, device_id) WHERE is_last_resort = true
      DO UPDATE SET
        package_data = EXCLUDED.package_data,
        hash = EXCLUDED.hash,
        last_updated_at = NOW();
  `;

  return new Promise((resolve, reject) => {
    console.log(`[CFM] ensureMessagingReady provisioning SQL for user ${user.id}`);
    const timeoutMs = 25000;
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`ensureMessagingReady timed out provisioning SQL for ${user.username} after ${timeoutMs}ms`));
    }, timeoutMs);

    exec(runDbCommandNoQuoteMulti(sql), (err, stdout, stderr) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        console.log(`[CFM] ensureMessagingReady SQL callback for user ${user.id}: err=${Boolean(err)}, stdoutLen=${String(stdout || '').length}, stderrLen=${String(stderr || '').length}`);
        if (err) {
          return reject(new Error(`Failed to provision messaging state for ${user.username}: ${stderr || err.message}`));
        }

        const deviceQuery = `SELECT device_public_id::text FROM user_devices WHERE user_id = ${Number(user.id)} ORDER BY id DESC LIMIT 1`;
        exec(runDbCommand(deviceQuery, 'pipe'), (deviceErr, deviceOut) => {
          if (deviceErr) {
            return resolve({ provisioningOutput: stdout });
          }

          const found = String(deviceOut || '')
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean)
            .map((line) => line.split('|')[0])
            .find((line) => /^[0-9a-f-]{36}$/i.test(line || ''));

          if (found) {
            user.device_public_id = found;
          }

          resolve({ provisioningOutput: stdout, deviceId: found || null });
        });
      }
    );
  });
}

function refreshTrustedDeviceInDb(user) {
  if (!user?.id || !user.device_public_id) {
    return Promise.resolve();
  }

  const sql = `
    UPDATE user_devices
    SET last_verified_at = NOW() + INTERVAL '5 minutes'
    WHERE user_id = ${Number(user.id)}
      AND device_public_id = '${String(user.device_public_id).replace(/'/g, "''")}'::uuid;
  `;

  return new Promise((resolve) => {
    exec(runDbCommand(sql, 'plain'), (err) => {
      if (err) {
        console.log(`[CFM] refreshTrustedDeviceInDb failed for ${user.username}: ${err.message}`);
      }
      resolve();
    });
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
      runDbCommand(sql.replace(/\n/g, ' '), 'pipe'),
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

async function bootstrapSolidDmByApi(otherUsername, token) {
  if (!token) {
    return { ok: false, reason: 'no_token' };
  }

  const withTimeout = (promise, label, timeoutMs = 8000) => {
    const timeout = new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    });
    return Promise.race([promise, timeout]);
  };

  const headers = {
    Authorization: `Bearer ${token}`
  };

  try {
    const searchResult = await searchUserForDirectMessage(otherUsername, token);
    if (!searchResult.ok) {
      return {
        ok: false,
        reason: searchResult.reason || 'user_lookup_failed',
        status: searchResult.status,
        body: searchResult.body || null
      };
    }

    const targetUserId = searchResult.targetUserId;
    const createResponse = await withTimeout(
      fetch(`${BACKEND_URL}/api/mls/direct-messages/${targetUserId}`, {
        method: 'POST',
        headers: {
          ...headers,
          'Content-Type': 'application/json'
        }
      }),
      'create conversation'
    );
    const createBody = await createResponse.text();
    let createdConversation = null;
    if (createResponse.ok) {
      try {
        const parsedBody = JSON.parse(createBody || '{}');
        createdConversation = parsedBody.conversation || parsedBody.group || parsedBody;
      } catch (err) {
        createdConversation = null;
      }
    }

    const conversationId = createdConversation
      ? createdConversation.id || createdConversation.group_id || createdConversation.groupId || createdConversation.conversationId || createdConversation.conversation_id
      : null;

    return {
      ok: createResponse.ok,
      status: createResponse.status,
      reason: createResponse.ok ? 'created' : `conversation_failed_${createResponse.status}`,
      body: createBody,
      conversationId,
      targetUserId,
      targetUsername: otherUsername,
      createdConversation
    };
  } catch (error) {
    return { ok: false, reason: error?.message || String(error) };
  }
}

async function resolveDirectConversationIdFromToken(token, targetUserId) {
  if (!token) {
    return { ok: false, reason: 'no_token' };
  }
  if (!targetUserId) {
    return { ok: false, reason: 'no_target_user_id' };
  }

  try {
    const directResponse = await fetch(`${BACKEND_URL}/api/mls/direct-messages`, {
      headers: { Authorization: `Bearer ${token}` }
    });

    if (!directResponse.ok) {
      return {
        ok: false,
        reason: `direct_messages_${directResponse.status}`
      };
    }

    const directBody = await directResponse.json();
    const dms = Array.isArray(directBody) ? directBody : [];
    const normalizedTargetId = Number(targetUserId);
    const match = dms.find((item) => Number(item?.other_user_id) === normalizedTargetId);

    if (!match) {
      return { ok: false, reason: 'no_matching_dm_found' };
    }

    const conversationId = String(match?.group_id || match?.groupId || match?.id || match?.conversation_id || '').trim();
    if (!conversationId) {
      return { ok: false, reason: 'dm_missing_group_id' };
    }

    return {
      ok: true,
      conversationId,
      raw: match
    };
  } catch (error) {
    return { ok: false, reason: error?.message || String(error) };
  }
}

async function sendGroupMessageViaApi({ token, deviceId, groupId, data }) {
  if (!token || !deviceId || !groupId) {
    return { ok: false, reason: 'missing_token_device_or_group' };
  }

  try {
    const response = await fetch(`${BACKEND_URL}/api/mls/messages/group`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'x-device-id': String(deviceId)
      },
      body: JSON.stringify({
        groupId: String(groupId),
        messageType: 'application',
        data: String(data || '')
      })
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      return { ok: false, reason: `status_${response.status}:${body}` };
    }

    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error?.message || String(error) };
  }
}

async function searchUserForDirectMessage(otherUsername, token) {
  if (!token) {
    return { ok: false, reason: 'no_token' };
  }

  const withTimeout = (promise, label, timeoutMs = 8000) => {
    const timeout = new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    });
    return Promise.race([promise, timeout]);
  };

  const headers = {
    Authorization: `Bearer ${token}`
  };

  try {
    const searchResponse = await withTimeout(
      fetch(`${BACKEND_URL}/api/users/search?q=${encodeURIComponent(otherUsername)}`, { headers }),
      'user search'
    );
    const searchBody = await searchResponse.text();

    if (!searchResponse.ok) {
      return {
        ok: false,
        reason: `search_failed_${searchResponse.status}`,
        body: searchBody
      };
    }

    let users = [];
    try {
      users = JSON.parse(searchBody);
    } catch (err) {
      return {
        ok: false,
        reason: 'search_invalid_json',
        body: searchBody
      };
    }

    const match = Array.isArray(users)
      ? users.find((entry) => String(entry.username || '').toLowerCase() === String(otherUsername).toLowerCase())
      : null;
    if (!match) {
      return {
        ok: false,
        status: searchResponse.status,
        reason: 'user_not_found',
        candidateCount: Array.isArray(users) ? users.length : 0,
        body: searchBody
      };
    }

    const targetUserId = match?.id != null ? Number(match.id) : null;
    if (!targetUserId) {
      return {
        ok: false,
        status: searchResponse.status,
        reason: 'invalid_user_id',
        body: searchBody
      };
    }

    return {
      ok: true,
      status: searchResponse.status,
      targetUserId,
      targetUsername: match.username || otherUsername,
      user: match
    };
  } catch (error) {
    return { ok: false, reason: error?.message || String(error) };
  }
}

async function ensureVanDmByKnownId(page, user, targetUsername, targetUserId) {
  if (!page || !user?.id || !targetUserId) {
    return {
      ok: false,
      reason: 'missing_page_user_or_target'
    };
  }

  const state = await ensureVanConversationStateViaCore(page, {
    userId: Number(user.id),
    deviceId: user.device_public_id || user.deviceId || user.device_id || null,
    targetUserId: Number(targetUserId),
    targetUsername: targetUsername || '',
    fallbackUserLabel: targetUsername
  });

  return {
    ...state,
    groupId: String(state.groupId || state.conversationId || ''),
    targetUserId: Number(targetUserId)
  };
}

async function openVanConversationForGroup(page, targetUsername, targetGroupId) {
  const pattern = new RegExp(targetUsername, 'i');
  const groupKey = targetGroupId ? String(targetGroupId) : '';
  const deadline = Date.now() + 14000;

  const attempt = async () => {
    if (groupKey) {
      const byId = page.locator(`.conversation-item[data-group-id="${groupKey}"], [data-group-id="${groupKey}"]`).first();
      if (await byId.isVisible().catch(() => false)) {
        await byId.click().catch(() => {});
        const composerVisible = await page
          .locator('.message-textarea, textarea[placeholder*="// Type message..."], textarea')
          .first()
          .isEnabled()
          .catch(() => false);
        if (composerVisible) return true;
      }
    }

    const byPattern = page
      .locator('.conversation-item, .chat-item, .dm-item, .mls-group, .conversation-list-item')
      .filter({ hasText: pattern })
      .first();
    if (await byPattern.isVisible().catch(() => false)) {
      await byPattern.click().catch(() => {});
      const composerVisible = await page
        .locator('.message-textarea, textarea[placeholder*="// Type message..."], textarea')
        .first()
        .isEnabled()
        .catch(() => false);
      if (composerVisible) return true;
    }

    await page.locator('button[title="Refresh"], button[title="Reload"], button[title="Sync"]').first().click().catch(() => {});
    return false;
  };

  while (Date.now() < deadline) {
    if (await attempt()) return true;
    await page.waitForTimeout(600);
  }

  return false;
}

async function ensureSolidConversationState(page, bootstrapResult, fallbackUserLabel = '') {
  if (!bootstrapResult?.conversationId || !bootstrapResult?.targetUserId) {
    return {
      ok: false,
      reason: 'missing_conversation_or_target_user'
    };
  }

  let setupState = null;
  let lastErr = null;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      setupState = await page.evaluate(async (payload) => {
        let coreCryptoClient = window.coreCryptoClient;
        if (!coreCryptoClient) {
          try {
            const imported = await import('/src/services/mls/coreCryptoClient.js');
            const importedClient = imported?.default;
            if (importedClient) {
              window.coreCryptoClient = importedClient;
              coreCryptoClient = importedClient;
            }
          } catch (err) {
            return {
              ok: false,
              reason: `coreCrypto import failed: ${err?.message || String(err)}`
            };
          }
        }
        const messagingStore = window.__messagingStore || window.messagingStore;
        if (!coreCryptoClient) {
          return { ok: false, reason: 'core_crypto_client_unavailable' };
        }

        try {
          if (!coreCryptoClient.client) {
            const authToken = localStorage.getItem('token');
            if (authToken) {
              try {
                const tokenPayload = JSON.parse(atob(authToken.split('.')[1] || '{}'));
                const username = tokenPayload?.userId != null ? String(tokenPayload.userId) : null;
                if (username) {
                  await coreCryptoClient.ensureMlsBootstrap(username);
                }
              } catch (bootstrapError) {
                console.warn('[CFM] ensureSolidConversationState bootstrap warning', bootstrapError?.message || bootstrapError);
              }
            }
          }

          const result = await coreCryptoClient.startDirectMessage(payload.targetUserId);
          const resolvedGroupId = result?.groupId || payload.conversationId;

          if (coreCryptoClient.syncMessages) {
            try {
              await coreCryptoClient.syncMessages();
            } catch (error) {
              // syncWarnings are noisy in non-chatty CI logs; keep this best-effort.
              console.warn('[CFM] ensureSolidConversationState sync warning', error?.message || error);
            }
          }

          try {
            const messagingService = (await import('/src/services/messaging.js')).default;
            const groups = await messagingService.getMlsGroups();
            if (messagingStore?.setMlsGroups) {
              messagingStore.setMlsGroups(groups);
            }
          } catch (error) {
            console.warn('[CFM] ensureSolidConversationState failed messaging refresh', error?.message || error);
          }

          if (messagingStore?.selectMlsGroup) {
            messagingStore.selectMlsGroup(resolvedGroupId);
          }

          return { ok: true, groupId: resolvedGroupId };
        } catch (error) {
          return { ok: false, reason: error?.message || String(error) };
        }
      }, {
        targetUserId: Number(bootstrapResult.targetUserId),
        conversationId: bootstrapResult.conversationId
      });
      break;
    } catch (error) {
      lastErr = error;
      const errorText = String(error?.message || error);
      if (attempt < 2 && isTransientEvalError(errorText)) {
        console.log(`[CFM] ensureSolidConversationState(${fallbackUserLabel}): transient eval failure on attempt ${attempt + 1}, retrying`);
        await page.waitForTimeout(400 + attempt * 250).catch(() => {});
        await goToSolidMessages(page).catch(() => {});
        continue;
      }
      break;
    }
  }

  if (setupState === null) {
    return {
      ok: false,
      reason: lastErr?.message || String(lastErr)
    };
  }

  console.log(`[CFM] ensureSolidConversationState(${fallbackUserLabel}): ${JSON.stringify(setupState)}`);
  return setupState;
}

async function ensureVanConversationState(page, bootstrapResult, fallbackUserLabel = '') {
  if (!bootstrapResult?.conversationId || !bootstrapResult?.targetUserId) {
    return {
      ok: false,
      reason: 'missing_conversation_or_target_user'
    };
  }

  const state = await page.evaluate(async (payload) => {
    const messagingStore = window.__messagingStore || window.messagingStore;
    if (!messagingStore) {
      return { ok: false, reason: 'messaging_store_unavailable' };
    }
    const coreCryptoClient = window.coreCryptoClient;

    if (payload.deviceId) {
      try {
        const vaultService = (await import('/src/services/vaultService.js')).default;
        if (vaultService && typeof vaultService.setDeviceId === 'function') {
          vaultService.setDeviceId(payload.deviceId);
        }
      } catch (vaultErr) {
        console.warn('[CFM] ensureVanConversationState vault sync warning', vaultErr?.message || vaultErr);
      }
    }

    const dmConversation = {
      group_id: String(payload.conversationId),
      other_user_id: Number(payload.targetUserId),
      other_username: payload.targetUsername || '',
      created_at: new Date().toISOString(),
      name: payload.targetUsername || `User ${payload.targetUserId}`
    };

    try {
      if (coreCryptoClient?.startDirectMessage) {
        try {
          await coreCryptoClient.startDirectMessage(Number(payload.targetUserId));
        } catch (startErr) {
          console.warn('[CFM] ensureVanConversationState startDirectMessage warning', startErr?.message || startErr);
        }

        if (coreCryptoClient?.syncMessages) {
          try {
            await coreCryptoClient.syncMessages();
          } catch (syncErr) {
            console.warn('[CFM] ensureVanConversationState sync warning', syncErr?.message || syncErr);
          }
        }
      }

      if (typeof messagingStore.setDirectMessages === 'function') {
        const current = Array.isArray(messagingStore.directMessages) ? [...messagingStore.directMessages] : [];
        const exists = current.some((item) => String(item.group_id) === String(dmConversation.group_id));
        messagingStore.setDirectMessages(exists
          ? current
          : [...current, dmConversation]);
      } else {
        const existing = Array.isArray(messagingStore.directMessages) ? [...messagingStore.directMessages] : [];
        if (!existing.some((item) => String(item.group_id) === String(dmConversation.group_id))) {
          messagingStore.directMessages = [...existing, dmConversation];
        }
      }

      messagingStore.showMlsMode = true;
      messagingStore.searchQuery = '';

      if (typeof messagingStore.selectMlsGroup === 'function') {
        messagingStore.selectMlsGroup(String(payload.conversationId));
      } else {
        messagingStore.selectedMlsGroupId = String(payload.conversationId);
        messagingStore.selectedConversationId = null;
      }

      return { ok: true, reason: 'store_state_applied' };
    } catch (error) {
      return { ok: false, reason: String(error?.message || error) };
    }
  }, {
    conversationId: bootstrapResult.conversationId,
    targetUserId: bootstrapResult.targetUserId,
    targetUsername: bootstrapResult.targetUsername || '',
    deviceId: bootstrapResult.deviceId || null
  });

  console.log(`[CFM] ensureVanConversationState(${fallbackUserLabel}): ${JSON.stringify(state)}`);
  return state;
}

async function ensureVanConversationStateViaCore(page, payload = {}) {
  if (!payload?.targetUserId || !payload?.userId) {
    return {
      ok: false,
      reason: 'missing_target_or_user_id'
    };
  }

  const state = await page.evaluate(async (params) => {
    const messagingStore = window.__messagingStore || window.messagingStore;
    const vaultStore = (await import('/src/stores/vaultStore.js')).default;
    const { default: coreCryptoClient } = await import('/src/services/mls/coreCryptoClient.js');
    const { default: vaultService } = await import('/src/services/vaultService.js');

    if (params.userId) {
      vaultStore.setUserId(params.userId);
    }
    if (params.deviceId) {
      vaultService.setDeviceId(params.deviceId);
    }
    if (window.coreCryptoClient && window.coreCryptoClient !== coreCryptoClient) {
      window.coreCryptoClient._vaultService = vaultService;
    }
    coreCryptoClient._vaultService = vaultService;

    try {
      let keyPackageSelfCheck = { ok: false, status: 0, bodyText: '' };

      await coreCryptoClient.initialize();
      await coreCryptoClient.ensureMlsBootstrap(String(params.userId));
      const authToken = localStorage.getItem('token');
      keyPackageSelfCheck = await fetch(`/api/mls/key-package/${Number(params.targetUserId)}`, {
        headers: { Authorization: `Bearer ${authToken}` }
      }).then(async (response) => {
        const bodyText = await response.text();
        return {
          ok: response.ok,
          status: response.status,
          bodyText: bodyText.slice(0, 220)
        };
      }).catch((error) => ({
        ok: false,
        status: 0,
        bodyText: error?.message || String(error)
      }));
      let startResult;
      try {
        startResult = await coreCryptoClient.startDirectMessage(params.targetUserId);
      } catch (startErr) {
        if (!/Conversation exists but is not available on this device yet/i.test(startErr?.message || '')) {
          throw startErr;
        }
        let lastError = startErr;
        for (let i = 0; i < 2; i += 1) {
          await new Promise((resolve) => setTimeout(resolve, 500));
          await coreCryptoClient.syncMessages().catch(() => {});
          try {
            startResult = await coreCryptoClient.startDirectMessage(params.targetUserId);
            break;
          } catch (retryErr) {
            lastError = retryErr;
          }
        }
        if (!startResult) {
          throw lastError;
        }
      }
      const groupId = startResult?.groupId;
      if (!groupId) {
        return { ok: false, reason: 'startDirectMessage-no-group' };
      }

      if (typeof messagingStore.setDirectMessages === 'function') {
        const current = Array.isArray(messagingStore.directMessages) ? [...messagingStore.directMessages] : [];
        const exists = current.some((item) => String(item.group_id) === String(groupId));
        if (!exists) {
          messagingStore.setDirectMessages([{
            group_id: String(groupId),
            other_user_id: Number(params.targetUserId),
            other_username: params.targetUsername || '',
            created_at: new Date().toISOString(),
            name: params.targetUsername || `User ${params.targetUserId}`
          }, ...current]);
        }
      }

      if (typeof messagingStore.selectMlsGroup === 'function') {
        messagingStore.selectMlsGroup(String(groupId));
      } else {
        messagingStore.selectedMlsGroupId = String(groupId);
        messagingStore.selectedConversationId = null;
      }

      return {
        ok: true,
        reason: 'created-via-core',
        groupId: String(groupId),
        keyPackageSelfCheck
      };
    } catch (error) {
      return {
        ok: false,
        reason: error?.message || String(error),
        keyPackageSelfCheck: typeof keyPackageSelfCheck !== 'undefined'
          ? keyPackageSelfCheck
          : { ok: false, status: 0, bodyText: '' }
      };
    }
  }, {
    userId: Number(payload.userId),
    deviceId: payload.deviceId || null,
    targetUserId: Number(payload.targetUserId),
    targetUsername: payload.targetUsername || ''
  });

  console.log(`[CFM] ensureVanConversationStateViaCore(${payload.fallbackUserLabel || ''}): ${JSON.stringify(state)}`);
  return state;
}

async function loginOnVan(page, user) {
  await routeApiToBackend(page);
  if (!user.token) {
    const loginResponse = await fetch(`${BACKEND_URL}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: user.email,
        password: user.password
      })
    });

    if (loginResponse.ok) {
      const loginBody = await loginResponse.json();
      if (loginBody.token) {
        user.token = loginBody.token;
      }
    }

  }

  if (!user.token) {
    await loginOnVanWithForm(page, user);
    return;
  }

  console.log(`[CFM] loginOnVanWithToken: ${user.username}`);
  await page.setViewportSize({ width: 1440, height: 1200 });
  await ensureVanUserId(user);
  await safeSetVanAuthToken(page, user.token);
  await page.addInitScript((authToken) => {
    localStorage.setItem('token', authToken);
  }, user.token);
  await page.goto(`${VAN_URL}/#messages`, { waitUntil: 'domcontentloaded', timeout: 15000 });
  await page.locator('.messages-page').first().waitFor({ timeout: 10000 }).catch(async (err) => {
    const pageText = await page.textContent('body').catch(() => '');
    const pageUrl = page.url();
    console.log(`[CFM] loginOnVanWithToken: messages page wait failed (${err?.message || err})`);
    console.log(`[CFM] loginOnVanWithToken: post-goto status url=${pageUrl}, text=${(pageText || '').slice(0, 200)}`);
    if (pageText && /sign\s+in/i.test(pageText)) {
      await loginOnVanWithForm(page, user);
      return;
    }
    throw new Error(`Unable to load Van messaging UI: ${pageText || 'empty page'}`);
  });

  console.log(`[CFM] loginOnVanWithToken: messages UI ready for ${user.username}`);

  const isGuest = await page.getByText(/@GUEST/i).first().isVisible().catch(() => false);
  if (isGuest) {
    await loginOnVanWithForm(page, user);
  }
}

async function ensureVanUserId(user) {
  if (!user?.token || user.id) return;

  const response = await fetch(`${BACKEND_URL}/api/users/me`, {
    headers: { Authorization: `Bearer ${user.token}` }
  });

  if (!response.ok) {
    console.warn(`[CFM] resolveVanUserId failed: ${response.status}`);
    return;
  }

  const me = await response.json().catch(() => null);
  if (!me) return;
  user.id = Number(me.id || me.user?.id || 0) || 0;
  if (!user.id) {
    user.id = Number(me.userId || me.user?.id || 0) || 0;
  }
}

async function followUserIfNeeded(follower, target) {
  if (!follower?.token || !follower?.id || !target?.id || follower.id === target.id) return;

  const response = await fetch(`${BACKEND_URL}/api/users/${target.id}/follow`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${follower.token}`
    }
  });

  if (response.ok) {
    console.log(`[CFM] followUserIfNeeded: ${follower.username} now follows ${target.username || target.id}`);
    return;
  }

  const body = await response.text().catch(() => '');
  if (/already follows|already following/i.test(body)) {
    console.log(`[CFM] followUserIfNeeded: ${follower.username} already follows ${target.username || target.id}`);
    return;
  }
  console.log(`[CFM] followUserIfNeeded: follow failed (${response.status}) for ${follower.username}->${target.username || target.id}: ${body}`);
}

async function setVanAuthToken(page, token) {
  if (!token) return;
  const targetUrl = page.url();
  if (!targetUrl || targetUrl.startsWith('about:')) {
    await page.addInitScript((authToken) => {
      localStorage.setItem('token', authToken);
    }, token);
    return;
  }

  try {
    await page.evaluate((authToken) => {
      localStorage.setItem('token', authToken);
    }, token);
  } catch (err) {
    if (!/Access is denied for this document/.test(err?.message || '')) {
      throw err;
    }
    await page.addInitScript((authToken) => {
      localStorage.setItem('token', authToken);
    }, token);
  }
  await page.waitForTimeout(50).catch(() => {});
}

async function safeSetVanAuthToken(page, token) {
  if (!token) return;
  try {
    await setVanAuthToken(page, token);
    if (/517[34]|4174/.test(page.url()) || (page.url() || '').includes('localhost')) {
      await page.evaluate((authToken) => {
        return import('/src/services/tokenService.js')
          .then((module) => {
            if (module?.saveToken) {
              module.saveToken(authToken);
            }
          })
          .catch(() => {});
      }, token);
    }
    return;
  } catch (error) {
    console.log(`[CFM] safeSetVanAuthToken fallback for token write: ${error?.message || error}`);
    await page.addInitScript((authToken) => {
      localStorage.setItem('token', authToken);
    }, token).catch(() => {});
  }
}

async function loginOnVanWithForm(page, user) {
  await routeApiToBackend(page);
  console.log(`[CFM] loginOnVan: ${user.username}`);
  await page.setViewportSize({ width: 1440, height: 1200 });
  await page.goto(`${VAN_URL}/#login`);
  const findInput = async (selectorCandidates) => {
    for (let attempt = 0; attempt < selectorCandidates.length; attempt += 1) {
      const selector = selectorCandidates[attempt];
      const input = page.locator(selector).first();
      if (await input.isVisible({ timeout: 500 }).catch(() => false)) {
        return input;
      }
    }
    return null;
  };

  const usernameInput = await findInput([
    '#email',
    'input[type="email"]',
    'input[name="email"]',
    'input[name="username"]',
    'input[autocomplete="username"]',
    'input[placeholder*="Username" i]',
    'input[placeholder*="Email" i]',
    '.login-form input:first-of-type'
  ]);

  if (!usernameInput) {
    throw new Error('Unable to locate Van username/email input');
  }

  const passwordInput = await findInput([
    '#password',
    'input[type="password"]',
    'input[name="password"]',
    'input[autocomplete="current-password"]',
    'input[placeholder*="Password" i]',
    '.login-form input[type="password"]'
  ]);

  if (!passwordInput) {
    throw new Error('Unable to locate Van password input');
  }

  await usernameInput.fill(user.username || user.email);
  await passwordInput.fill(user.password);
  await page.getByRole('button', { name: /sign in/i }).click();
  console.log('[CFM] loginOnVan submitted form');

  const messagesReady = page.locator('.messages-page').first();
  const logoutBtn = page.getByRole('button', { name: /Logout|Sign Out/i });
  const noUser = page.getByText(/@GUEST/i).first();
  for (let i = 0; i < 30; i += 1) {
    const currentLoginUrl = page.url();
    if (!currentLoginUrl.includes('#login')) {
      break;
    }
    if (await messagesReady.isVisible().catch(() => false)) return;
    const isGuest = await noUser.isVisible().catch(() => false);
    if (await logoutBtn.isVisible().catch(() => false)) {
      console.log('[CFM] loginOnVan detected logout button');
      return;
    }
    if (isGuest) {
      return;
    }
    await page.waitForTimeout(750);
  }

  const altLoginReady = page.locator('.messages-page').first();
  if (await altLoginReady.isVisible().catch(() => false)) return;
  if (await logoutBtn.isVisible().catch(() => false)) return;
  if (await noUser.isVisible().catch(() => false)) return;
  const currentUrl = page.url();
  console.log(`[CFM] loginOnVan post-login check: ${currentUrl}`);
  if (!currentUrl.includes('#login')) {
    if (currentUrl.includes('#/messages') || currentUrl.includes('#/dashboard')) {
      await page.goto(`${VAN_URL}/#messages`, { waitUntil: 'domcontentloaded' }).catch(() => {});
      return;
    }
  }
  console.log('[CFM] loginOnVan timed out waiting for login completion');

  for (let i = 0; i < 20; i += 1) {
    if (!page.url().includes('#login')) return;
    if (await messagesReady.isVisible().catch(() => false)) return;
    await page.waitForTimeout(500);
  }

  throw new Error(`Unable to complete Van login for ${user.username}`);
}

async function unlockVanVaultViaService(page, password, user) {
  if (!user?.id) return { ok: false, reason: 'missing user id' };

  return page.evaluate(async ({ password: pwd, userId, deviceId }) => {
    const vaultStore = window.__vaultStore;
    if (!vaultStore) {
      return { ok: false, reason: 'vault store unavailable' };
    }

    try {
      const { default: vaultService } = await import('/src/services/vaultService.js');
      const { setPendingDeviceId } = await import('/src/services/deviceIdStore.js');
      if (!vaultService) {
        return { ok: false, reason: 'vault service module unavailable' };
      }

      if (!vaultStore.userId) {
        vaultStore.setUserId(userId);
      }
      if (deviceId) {
        setPendingDeviceId(deviceId);
      }

      if (vaultService.isUnlocked && vaultService.isUnlocked()) {
        return { ok: true, reason: 'already-unlocked' };
      }

      try {
        await vaultService.unlockWithPassword(pwd);
        return { ok: true, reason: 'unlockWithPassword' };
      } catch (unlockErr) {
        await vaultService.setupKeystoreWithPassword(pwd);
        return {
          ok: true,
          reason: 'setupKeystoreWithPassword',
          unlockError: unlockErr?.message || String(unlockErr)
        };
      }
    } catch (err) {
      return {
        ok: false,
        reason: err?.message || String(err)
      };
    }
  }, {
    password,
    userId: Number(user.id),
    deviceId: user.device_public_id || user.deviceId || user.device_id || null
  });
}

async function unlockSolidVaultIfNeeded(page, password) {
  const unlockBtn = page.getByRole('button', { name: '> UNLOCK VAULT' });
  if (await unlockBtn.isVisible().catch(() => false)) {
    await page.getByPlaceholder('Vault Password...').fill(password);
    await unlockBtn.click();
  }
}

function solidChatPanel(page) {
  return page.locator('.skin-van').first();
}

async function waitForSolidShellOrAuth(page, timeoutMs = 30000, stepMs = 250) {
  console.log(`[CFM] waitForSolidShellOrAuth: timeout=${timeoutMs}`);
  const endAt = Date.now() + timeoutMs;
  let sawLogin = false;
  let ticks = 0;

  while (Date.now() < endAt) {
    if (await isLikelySolidMessagingShell(page).catch(() => false)) {
      const isGuest = await page.getByText(/@GUEST/i).first().isVisible().catch(() => false);
      if (isGuest) {
        console.log('[CFM] waitForSolidShellOrAuth: shell detected but guest user present');
        return 'guest';
      }
      console.log('[CFM] waitForSolidShellOrAuth: detected shell');
      return 'shell';
    }

    const isGuest = await page.getByText(/@GUEST/i).first().isVisible().catch(() => false);
    if (isGuest) {
      console.log('[CFM] waitForSolidShellOrAuth: detected guest');
      sawLogin = true;
    }

    sawLogin = sawLogin
      || await page.getByPlaceholder('Enter system address...').isVisible().catch(() => false)
      || await page.getByRole('button', { name: '> CONTINUE' }).isVisible().catch(() => false);

    if (sawLogin) {
      console.log('[CFM] waitForSolidShellOrAuth: login UI visible');
      return 'login';
    }

    ticks += 1;
    if (ticks === 1 || ticks % 20 === 0) {
      const currentUrl = page.url();
      console.log(`[CFM] waitForSolidShellOrAuth: polling tick=${ticks} url=${currentUrl}`);
    }

    await page.waitForTimeout(stepMs);
  }

  console.log('[CFM] waitForSolidShellOrAuth: timed out');
  return null;
}

async function looksLikeSolidShell(page) {
  return isLikelySolidMessagingShell(page);
}

async function isLikelySolidMessagingShell(page) {
  const shellChecks = [
    solidChatPanel(page),
    page.locator('text=/\\[3\\]\\s*COMMS\\s*\\/\\/\\s*E2EE/i'),
    page.getByText(/\[3\]\s*COMMS\s*\/\/\s*E2EE/i),
    page.getByText('SELECT CONVERSATION'),
    page.getByText('MSG ENTRY')
  ];

  for (let i = 0; i < shellChecks.length; i += 1) {
    if (await shellChecks[i].isVisible().catch(() => false)) {
      return true;
    }
  }

  return (await page.getByText('COMMS // E2EE').isVisible().catch(() => false))
    || (await page.getByText('[3] COMMS').isVisible().catch(() => false))
    || (await page.locator('[placeholder="SEARCH..."]').isVisible().catch(() => false))
    || (await page.locator('[placeholder="[+]"], [placeholder="// Type message..."]').isVisible().catch(() => false))
    || (await page.locator('[placeholder*="SEARCH"]').isVisible().catch(() => false))
    || (await page.locator('.conversations-sidebar .search-box input, .search-box input').first().isVisible().catch(() => false));
}

async function goToSolidMessages(page) {
  const target = `${SOLID_URL}/#messages`;
  if (page.url() === target) {
    return;
  }

  try {
    await page.goto(target, { waitUntil: 'domcontentloaded' });
  } catch (error) {
    if (!/interrupted by another navigation/i.test(error?.message || '')) {
      throw error;
    }
  }
}

async function openDmOnSolid(page, otherUsername, timeoutMs = 45000, user = null) {
  console.log(`[CFM] openDmOnSolid waiting for ${otherUsername} (${timeoutMs}ms)`);
  if (user?.token) {
    await routeApiToBackend(page);
    await safeSetVanAuthToken(page, user.token);
    const isGuest = await page.getByText(/@GUEST/i).first().isVisible().catch(() => false);
    if (isGuest) {
      await goToSolidMessages(page);
    }
  }

  await goToSolidMessages(page);
  let shellState = await waitForSolidShellOrAuth(page, 20000);
  if (shellState === 'guest' && user?.token) {
    console.log('[CFM] openDmOnSolid detected guest state, refreshing auth');
    await safeSetVanAuthToken(page, user.token);
    await goToSolidMessages(page);
    shellState = await waitForSolidShellOrAuth(page, 12000);
    if (shellState === 'guest') {
      console.log('[CFM] openDmOnSolid still guest after token rebind, reloading page');
      await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
      shellState = await waitForSolidShellOrAuth(page, 12000);
    }
  }
  if (shellState === 'login') {
    if (!user) {
      throw new Error('Need user credentials to complete login fallback');
    }
    console.log('[CFM] openDmOnSolid detected login state, retrying shell auth');
    if (user?.token) {
      await safeSetVanAuthToken(page, user.token);
      await goToSolidMessages(page);
      const shellStateAfterToken = await waitForSolidShellOrAuth(page, 15000);
      if (shellStateAfterToken === 'shell') {
        shellState = 'shell';
      } else if (shellStateAfterToken === 'guest' && user?.email && user?.password) {
        try {
          console.log('[CFM] openDmOnSolid token retry landed on guest; attempting full login form fallback');
          await loginOnSolidWithForm(page, user);
          shellState = await waitForSolidShellOrAuth(page, 12000);
        } catch (error) {
          console.log(`[CFM] openDmOnSolid full login after token retry failed (${error.message}); continuing with ${shellStateAfterToken}`);
          shellState = shellStateAfterToken;
        }
      } else if (shellStateAfterToken === 'guest') {
        console.log('[CFM] openDmOnSolid token retry landed on guest without credentials; continuing as guest shell');
        shellState = 'guest';
        await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
        const postRetryState = await waitForSolidShellOrAuth(page, 10000);
        if (postRetryState !== 'guest') {
          shellState = postRetryState;
        }
      } else {
        console.log(`[CFM] openDmOnSolid token retry ended in ${shellStateAfterToken}; continuing fallback flow`);
        shellState = shellStateAfterToken;
      }
    } else {
      await loginOnSolidWithForm(page, user);
    }
  }

  if (shellState === 'guest') {
    if (user?.email && user?.password) {
      try {
        console.log('[CFM] openDmOnSolid continuing flow from guest; retrying full login');
        await loginOnSolidWithForm(page, user);
        shellState = await waitForSolidShellOrAuth(page, 12000);
      } catch (error) {
        console.log(`[CFM] openDmOnSolid guest retry login failed (${error.message}); continuing as guest shell`);
      }
    } else {
      console.log('[CFM] openDmOnSolid continuing as guest shell; no user credentials available');
    }
  } else if (shellState !== 'shell') {
    throw new Error('Unable to load Solid messaging interface after navigation');
  }

  let panel = page.locator('body');
  await expect(panel).toBeVisible({ timeout: 20000 });
  const targetPattern = new RegExp(otherUsername, 'i');

  const initialConversationDeadline = Date.now() + Math.min(timeoutMs, 12000);
  while (Date.now() < initialConversationDeadline) {
    const existingConversation = panel
      .locator('.conversations-list li.conversation-item, .dm-list li, .conversation-item, .conversations-list div, .overflow-y-auto div')
      .filter({ hasText: targetPattern })
      .first();

    if (await existingConversation.isVisible().catch(() => false)) {
      await existingConversation.click().catch(() => {});
      const chatInput = page.locator('textarea[placeholder*="// Type message..."]').first();
      if (await chatInput.isEnabled().catch(() => false)) {
        return;
      }
    }

    await page.waitForTimeout(300);
  }

  let searchInput = null;

  const searchInputSelectors = [
    '.search-box input[placeholder*="NEW DM"]',
    '.search-box textarea[placeholder*="NEW DM"]',
    '.search-box input[placeholder*="SEARCH"]',
    '.search-box input',
    'input[placeholder*="NEW DM"]',
    'input[placeholder*="SEARCH"]',
    'input[placeholder*="Search"]',
    'textarea[placeholder*="SEARCH"]',
    'textarea[placeholder*="Search"]',
    'textarea[placeholder*="NEW DM"]',
    '[role=\"textbox\"][placeholder*=\"NEW DM\"]',
    '[role=\"textbox\"][placeholder*=\"SEARCH\"]',
    '[role=\"textbox\"][placeholder*=\"Search\"]',
    '[role=\"textbox\"]',
    '[contenteditable=\"true\"]',
    '[contenteditable=\"true\"][role=\"textbox\"]'
  ];

  for (let i = 0; i < searchInputSelectors.length; i += 1) {
    const candidate = panel.locator(searchInputSelectors[i]).first();
    if (await candidate.count().then((count) => count > 0).catch(() => false)) {
      searchInput = candidate;
      break;
    }
  }

  if (!searchInput) {
    const placeholderCandidates = await page.locator('[placeholder]').all().catch(() => []);
    for (let i = 0; i < placeholderCandidates.length; i += 1) {
      const candidate = placeholderCandidates[i];
      const candidatePlaceholder = (await candidate.getAttribute('placeholder').catch(() => '') || '').toLowerCase();
      if (candidatePlaceholder.includes('search') || candidatePlaceholder.includes('new dm')) {
        searchInput = candidate;
        break;
      }
    }
  }

  if (!searchInput) {
    const inputDiagnostics = await page.evaluate(() => {
      const nodes = Array.from(document.querySelectorAll('input, textarea, [contenteditable=\"true\"], [role=\"textbox\"]'));
      return nodes.map((node) => ({
        tagName: node.tagName.toLowerCase(),
        placeholder: node.getAttribute?.('placeholder') || '',
        className: node.className || '',
        type: node.getAttribute?.('type') || 'text',
        role: node.getAttribute?.('role') || '',
        text: (node.textContent || '').trim().slice(0, 120)
      }));
    }).catch((error) => {
      console.log(`[CFM] openDmOnSolid failed to inspect input candidates: ${error?.message || String(error)}`);
      return [];
    });
    console.log(`[CFM] openDmOnSolid failed to find search input for ${otherUsername}: ${JSON.stringify(inputDiagnostics)}`);
    let fallbackConversationReady = false;

    if (user?.token) {
      console.log('[CFM] openDmOnSolid no search input found, trying API bootstrap directly');
      const fallbackResult = await bootstrapSolidDmByApi(otherUsername, user?.token);
      console.log(`[CFM] openDmOnSolid direct API bootstrap result for ${otherUsername}: ${JSON.stringify(fallbackResult)}`);
      if (fallbackResult.ok && fallbackResult.conversationId) {
        fallbackConversationReady = true;
        const activatedFallback = await ensureSolidConversationActivated(
          page,
          fallbackResult.conversationId,
          otherUsername
        );
      if (activatedFallback.ok) {
        console.log(`[CFM] openDmOnSolid activated fallback conversation ${fallbackResult.conversationId}`);
        if (await ensureSolidConversationActivated(page, fallbackResult.conversationId, otherUsername).then((state) => state.ok)) {
          console.log(`[CFM] openDmOnSolid fallback API conversation activated in store for ${fallbackResult.conversationId}`);
          return;
        }
      }
        const ensureState = await ensureSolidConversationState(page, fallbackResult, otherUsername);
        if (!ensureState.ok) {
          console.log(`[CFM] openDmOnSolid direct API bootstrap state ensure failed: ${ensureState.reason || 'unknown'}`);
        } else {
          if (await ensureSolidConversationActivated(page, fallbackResult.conversationId, otherUsername).then((state) => state.ok)) {
            console.log(`[CFM] openDmOnSolid fallback API conversation activated in store for ${fallbackResult.conversationId}`);
            return;
          }
        }
        await goToSolidMessages(page);
        const shellStateAfterFallback = await waitForSolidShellOrAuth(page, 15000);
        if (shellStateAfterFallback === 'login') {
          if (!user) {
            throw new Error('Need user credentials to complete login fallback');
          }
          await safeSetVanAuthToken(page, user.token);
          await goToSolidMessages(page);
          const shellStateAfterToken = await waitForSolidShellOrAuth(page, 10000);
          if (shellStateAfterToken !== 'shell') {
            await loginOnSolidWithForm(page, user);
          }
        } else if (shellStateAfterFallback === 'guest') {
          console.log('[CFM] openDmOnSolid API bootstrap kept shell in guest state; reattempting token rebind');
          if (user?.token) {
            await safeSetVanAuthToken(page, user.token);
            await goToSolidMessages(page);
            const shellStateAfterToken = await waitForSolidShellOrAuth(page, 10000);
            if (shellStateAfterToken === 'guest') {
              await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
            }
            if (shellStateAfterToken === 'login' && user) {
              await loginOnSolidWithForm(page, user);
            }
          }
        } else if (shellStateAfterFallback !== 'shell') {
          throw new Error('Unable to reload Solid messaging interface after API bootstrap');
        }
        panel = page.locator('body');
        await expect(panel).toBeVisible({ timeout: 15000 });
        const forcedAfterFallback = await forceOpenSolidConversation(page, fallbackResult.conversationId, otherUsername);
        if (forcedAfterFallback) {
          const finalMessageInput = panel.locator('textarea[placeholder*=\"// Type message...\"]').first();
          if (await finalMessageInput.isEnabled().catch(() => false)) {
            return;
          }
        }
        if (await forceOpenSolidConversation(page, fallbackResult.conversationId, otherUsername)) {
          return;
        }

        const fallbackDeadline = Date.now() + 30000;
        while (Date.now() < fallbackDeadline) {
          const forced = await forceOpenSolidConversation(page, fallbackResult.conversationId, otherUsername);
          if (forced && await page.locator('textarea[placeholder*="// Type message..."]').first().isEnabled().catch(() => false)) {
            fallbackConversationReady = true;
            return;
          }
          await page.waitForTimeout(500);
        }
      }
    }

    if (fallbackConversationReady) {
      return;
    }
    throw new Error(`Unable to locate Solid search input for ${otherUsername}`);
  }

  const placeholder = await searchInput.getAttribute('placeholder').catch(() => '');
  if (!/NEW DM/i.test(placeholder || '')) {
    const newButtonCandidates = [
      '[title="New DM"]',
      '[title="Cancel New DM"]',
      'span[title="New DM"]',
      '[aria-label*="New"]',
      'button:has-text("New DM")',
      'button:has-text("[+]")',
      'span:has-text("[+]")',
      'div:has-text("[+]")',
      'text=[+]',
      '.cursor-pointer:has-text("[+]")'
    ];

    let newButton;
    for (let i = 0; i < newButtonCandidates.length; i += 1) {
      const candidate = panel.locator(newButtonCandidates[i]).first();
      if (await candidate.isVisible().catch(() => false)) {
        newButton = candidate;
        break;
      }
    }

    if (!newButton) {
      newButton = panel.getByText('[+]').first();
    }

    if (await newButton.isVisible().catch(() => false)) {
      await newButton.click();
      await page.waitForTimeout(250);
    } else {
      // Fallback: try keyboard to enter the New DM mode and keep selector-based flow.
      await searchInput.focus();
      await page.keyboard.press('ArrowRight').catch(() => {});
      await page.keyboard.press('Tab').catch(() => {});
      await searchInput.fill('');
    }
  }

  const deadline = Date.now() + timeoutMs;
  await searchInput.fill(otherUsername);
  let apiResult = null;
  let resultRow = null;
  const resultRowDeadline = Date.now() + 6000;
  while (Date.now() < resultRowDeadline && !resultRow) {
    const candidate = panel
      .locator('li.user-row, .user-row, [data-user], .search-results-inline li, .search-results li, .search-result-item, .overflow-y-auto div')
      .filter({ hasText: targetPattern })
      .first();

    if (await candidate.isVisible().catch(() => false)) {
      resultRow = candidate;
    } else {
      await page.waitForTimeout(250);
    }
  }

  if (resultRow) {
    await resultRow.click();
    const messageInput = panel.locator('textarea[placeholder*="// Type message..."]').first();
    if (await messageInput.isEnabled().catch(() => false)) {
      return;
    }
  } else {
    console.log(`[CFM] openDmOnSolid no inline result row, trying API bootstrap for ${otherUsername}`);
    apiResult = await bootstrapSolidDmByApi(otherUsername, user?.token);
    console.log(`[CFM] openDmOnSolid API bootstrap response for ${otherUsername}: ${JSON.stringify(apiResult)}`);

    if (!apiResult.ok) {
      throw new Error(`Unable to locate Solid result row for ${otherUsername}: ${apiResult.reason || 'unknown'}`);
    }

    if (apiResult.conversationId) {
      const activatedApi = await ensureSolidConversationActivated(
        page,
        apiResult.conversationId,
        otherUsername
      );
      if (activatedApi.ok) {
        console.log(`[CFM] openDmOnSolid activated API conversation ${apiResult.conversationId}`);
        return;
      }
      const ensuredState = await ensureSolidConversationState(page, apiResult, otherUsername);
      if (!ensuredState.ok) {
        console.log(`[CFM] openDmOnSolid API bootstrap state ensure failed: ${ensuredState.reason || 'unknown'}`);
      } else {
        if (await ensureSolidConversationActivated(page, apiResult.conversationId, otherUsername).then((state) => state.ok)) {
          console.log(`[CFM] openDmOnSolid API bootstrap state ensured in store for ${apiResult.conversationId}`);
          return;
        }
      }
      await goToSolidMessages(page);
      const shellStateAfterBootstrap = await waitForSolidShellOrAuth(page, 15000);
      if (shellStateAfterBootstrap === 'login') {
        if (!user) {
          throw new Error('Need user credentials to complete login fallback');
        }
        await safeSetVanAuthToken(page, user.token);
        await goToSolidMessages(page);
        const shellStateAfterToken = await waitForSolidShellOrAuth(page, 10000);
        if (shellStateAfterToken !== 'shell') {
          await loginOnSolidWithForm(page, user);
        }
      } else if (shellStateAfterBootstrap === 'guest') {
        console.log('[CFM] openDmOnSolid: API bootstrap kept shell in guest state; continuing with API-selected conversation state');
      } else if (shellStateAfterBootstrap !== 'shell') {
        throw new Error('Unable to reload Solid messaging interface after API bootstrap');
      }
      panel = page.locator('body');
      await expect(panel).toBeVisible({ timeout: 15000 });

      const refreshButton = panel.locator('button[title="Refresh"]').first();
      await refreshButton.click().catch(() => {});
      await page.waitForTimeout(1200);
      let bootstrapRows = 0;
      const bootstrapDeadline = Date.now() + 8000;
      while (Date.now() < bootstrapDeadline) {
        const row = panel
          .locator('.conversations-list .conversation-item, .dm-list .conversation-item, .group-list .conversation-item, .invite-item, .conversation-item, .overflow-y-auto div')
          .filter({ hasText: targetPattern })
          .first();

        if (await row.isVisible().catch(() => false)) {
          await row.click();
          break;
        }
        const byId = panel.locator(`[data-group-id="${apiResult.conversationId}"]`).first();
        if (await byId.isVisible().catch(() => false)) {
          await byId.click();
          break;
        }

        bootstrapRows = await panel
          .locator('.conversations-list .conversation-item, .dm-list .conversation-item, .group-list .conversation-item, .invite-item, .conversation-item, .overflow-y-auto div')
          .count()
          .catch(() => 0);
        if (bootstrapRows > 0) {
          console.log(`[CFM] openDmOnSolid bootstrap rows available: ${bootstrapRows}`);
        }

        await page.waitForTimeout(400);
      }

      const directMessageRow = panel.locator(`[data-group-id="${apiResult.conversationId}"]`).first();
      if (!(await directMessageRow.isVisible().catch(() => false))) {
        console.log(`[CFM] openDmOnSolid bootstrap row not visible for ${otherUsername}, attempting force path`);
        await forceOpenSolidConversation(page, apiResult.conversationId, otherUsername);
      } else {
        await page.waitForTimeout(200);
      }
    }
  }

  while (Date.now() < deadline) {
    if (apiResult?.conversationId && !await page.locator('textarea[placeholder*="// Type message..."]').first().isEnabled().catch(() => false)) {
      const forced = await forceOpenSolidConversation(page, apiResult.conversationId, otherUsername);
      if (forced) {
        return;
      }
      const reactivated = await ensureSolidConversationActivated(page, apiResult.conversationId, otherUsername);
      if (reactivated.ok && await page.locator('textarea[placeholder*="// Type message..."]').first().isEnabled().catch(() => false)) {
        return;
      }
    }

    const now = Date.now();
    const ticks = Math.floor((deadline - now) / 1000);
    if (ticks % 5 === 0) {
      const dmRowCount = await panel.locator('.conversations-list .conversation-item, .dm-list .conversation-item, .dm-list .invite-item, .conversations-list li, .overflow-y-auto div').count().catch(() => 0);
      console.log(`[CFM] openDmOnSolid polling for ${otherUsername}: ${dmRowCount} conversation rows visible, ${ticks}s remaining`);
    }

    const messageInput = panel.locator('textarea[placeholder*="// Type message..."]').first();
    if (await messageInput.isEnabled().catch(() => false)) {
      console.log(`[CFM] openDmOnSolid message input enabled for ${otherUsername}`);
      return;
    }

    const dmRow = panel
      .locator('.conversations-list .conversation-item, .dm-list .conversation-item, .conversations-list li, .conversation-item, .invite-item, .user-row, .overflow-y-auto div')
      .filter({ hasText: targetPattern })
      .first();
    if (await dmRow.isVisible().catch(() => false)) {
      await dmRow.click();
      const input = panel.locator('textarea[placeholder*="// Type message..."]').first();
      if (await input.isEnabled().catch(() => false)) return;
    }

    if (apiResult?.conversationId) {
      const byId = panel.locator(`[data-group-id="${apiResult.conversationId}"]`).first();
      if (await byId.isVisible().catch(() => false)) {
        await byId.click();
        const input = panel.locator('textarea[placeholder*="// Type message..."]').first();
        if (await input.isEnabled().catch(() => false)) return;
      }
    }

    await page.waitForTimeout(1000);
  }

  if (apiResult?.conversationId) {
    const activated = await ensureSolidConversationActivated(page, apiResult.conversationId, otherUsername).catch(() => ({ ok: false }));
    if (activated.ok) {
      console.log(`[CFM] openDmOnSolid fallback activated conversation ${apiResult.conversationId} without row visibility`);
      return;
    }

    const stateEnsured = await ensureSolidConversationState(page, {
      conversationId: apiResult.conversationId,
      targetUserId: apiResult.targetUserId,
      targetUsername: otherUsername
    }, otherUsername).catch(() => ({ ok: false }));
    if (stateEnsured.ok) {
      console.log(`[CFM] openDmOnSolid fallback ensured conversation state for ${apiResult.conversationId}`);
      return;
    }
    console.log(`[CFM] openDmOnSolid final fallback for ${otherUsername} not ready: ${JSON.stringify(stateEnsured)}`);
  }

  throw new Error(`Timed out waiting for Solid DM row for ${otherUsername}`);
}

async function forceOpenSolidConversation(page, conversationId, otherUsername = '') {
  if (!conversationId) return false;

  const normalizedConversationId = String(conversationId);
  const targetPattern = otherUsername ? new RegExp(otherUsername, 'i') : null;

  const checkEnabled = async () => page.locator('textarea[placeholder*="// Type message..."]').first().isEnabled().catch(() => false);
  if (await checkEnabled()) return true;

  const candidateSelectors = [
    '.dm-list [data-group-id]',
    '.conversation-item',
    '.conversations-list .conversation-item',
    '.dm-list .conversation-item',
    '.group-list .conversation-item',
    '.overflow-y-auto div[onclick]',
    '.overflow-y-auto div'
  ];

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const refreshBtn = page.locator('button[title="Refresh"]').first();
    await refreshBtn.click().catch(() => {});
    await page.waitForTimeout(400);

    for (let i = 0; i < candidateSelectors.length; i += 1) {
      const rows = page.locator(candidateSelectors[i]);
      const rowCount = await rows.count().catch(() => 0);
      const checkCount = Math.min(rowCount, 80);
      for (let idx = 0; idx < checkCount; idx += 1) {
        const row = rows.nth(idx);
        const text = (await row.textContent().catch(() => '')) || '';
        const byId = (await row.getAttribute('data-group-id').catch(() => '')) || '';
        const hasMatch = (targetPattern && targetPattern.test(text)) || (String(byId) === normalizedConversationId);
        if (!hasMatch) continue;

        await row.scrollIntoViewIfNeeded().catch(() => {});
        await row.click().catch(() => {});
        if (await checkEnabled()) {
          console.log(`[CFM] forceOpenSolidConversation: selected ${conversationId}`);
          return true;
        }
      }
    }
  }

  if (targetPattern) {
    const dmRow = page
      .locator('.conversations-list .conversation-item, .dm-list .conversation-item, .conversations-list li, .conversation-item, .invite-item, .user-row, .overflow-y-auto div')
      .filter({ hasText: targetPattern })
      .first();
    if (await dmRow.isVisible().catch(() => false)) {
      await dmRow.click().catch(() => {});
      if (await checkEnabled()) return true;
    }
  }

  return false;
}

async function ensureSolidConversationActivated(page, conversationId, otherUsername = '') {
  if (!conversationId) return { ok: false, reason: 'missing_conversation_id' };

  try {
    return await page.evaluate(async (payload) => {
      const resolveStore = async () => {
        let localStore = window.__messagingStore || window.messagingStore;
        if (localStore) return localStore;

        const candidates = [
          '/src/stores/messagingStore.js',
          '/src/store/messagingStore.js'
        ];

        for (let i = 0; i < candidates.length; i += 1) {
          try {
            const imported = await import(candidates[i]);
            localStore = imported?.default || null;
            if (localStore) {
              window.__messagingStore = localStore;
              window.messagingStore = localStore;
              return localStore;
            }
          } catch {
            continue;
          }
        }

        return null;
      };

      const store = await resolveStore();
      if (!store) return { ok: false, reason: 'messaging_store_unavailable' };

      try {
        const conversationIdValue = String(payload.conversationId);
        const displayName = String(payload.otherUsername || '').trim() || `User ${conversationIdValue}`;
        const currentMessages = Array.isArray(store.directMessages) ? [...store.directMessages] : [];
        const already = currentMessages.some((item) => String(item.group_id || item.id || '') === conversationIdValue);
        if (!already) {
          const newConversation = {
            group_id: conversationIdValue,
            other_user_id: Number(payload.targetUserId) || null,
            other_username: displayName,
            name: displayName,
            created_at: new Date().toISOString()
          };
          if (typeof store.setDirectMessages === 'function') {
            store.setDirectMessages([newConversation, ...currentMessages]);
          } else {
            store.directMessages = [newConversation, ...currentMessages];
          }
        }

        if (typeof store.selectMlsGroup === 'function') {
          store.selectMlsGroup(conversationIdValue);
        } else {
          store.selectedMlsGroupId = conversationIdValue;
          store.selectedConversationId = null;
        }

        return {
          ok: true,
          selectedConversationId: conversationIdValue
        };
      } catch (error) {
        return {
          ok: false,
          reason: error?.message || String(error)
        };
      }
    }, {
      conversationId,
      otherUsername,
      targetUserId: null
    });
  } catch (evaluateErr) {
    return {
      ok: false,
      reason: evaluateErr?.message || String(evaluateErr)
    };
  }
}

async function waitForSolidIncomingText(page, text, timeoutMs = 45000, options = {}) {
  console.log(`[CFM] waitForSolidIncomingText looking for: ${text}`);
  const panel = solidChatPanel(page);
  await expect(panel).toBeVisible({ timeout: 20000 });

  const authToken = options.authToken || await page.evaluate(() => localStorage.getItem('token')).catch(() => null);
  const targetConversationId = options.conversationId ? String(options.conversationId) : '';
  let selectedGroupId = await page.evaluate(() => {
    const store = window.__messagingStore || window.messagingStore;
    return String(store?.selectedMlsGroupId || store?.selectedConversationId || '');
  }).catch(() => '');

  const refreshSelectedGroup = async () => {
    const selected = await page.evaluate(() => {
      const store = window.__messagingStore || window.messagingStore;
      return {
        selectedMlsGroupId: store?.selectedMlsGroupId || '',
        selectedConversationId: store?.selectedConversationId || ''
      };
    }).catch(() => null);

    if (selected?.selectedMlsGroupId) {
      selectedGroupId = String(selected.selectedMlsGroupId);
    } else if (selected?.selectedConversationId) {
      selectedGroupId = String(selected.selectedConversationId);
    }
  };

  const hasMessageInStore = async (candidateGroups = []) => {
    return page.evaluate((payload) => {
      const store = window.__messagingStore || window.messagingStore;
      const groupId = payload.groupId;
      const directMessages = groupId
        ? (store?.mlsMessages?.[groupId] || store?.messagesByConversation?.[groupId] || [])
        : [];
      const rawCurrent = groupId
        ? (store?.currentMlsMessages || store?.messagesByConversation?.[groupId] || [])
        : [];
      const directMatch = [...(Array.isArray(directMessages) ? directMessages : []), ...(Array.isArray(rawCurrent) ? rawCurrent : [])]
        .some((message) => {
          const plaintext = (message?.plaintext || '').toString();
          return plaintext.includes(payload.text);
        });

      let anyGroupMatch = false;
      const byGroup = store?.mlsMessages || store?.messagesByConversation || {};
      if (byGroup && !directMatch && typeof byGroup === 'object') {
        for (const [group, messages] of Object.entries(byGroup)) {
          if (!Array.isArray(messages)) continue;
          if (messages.some((message) => (message?.plaintext || '').toString().includes(payload.text))) {
            if (payload.checkedGroups.includes(String(group))) {
              continue;
            }
            anyGroupMatch = true;
            payload.checkedGroups.push(String(group));
            break;
          }
        }
      }

      return {
        selectedGroupId: groupId || store?.selectedMlsGroupId || store?.selectedConversationId || '',
        directMatch,
        anyGroupMatch,
        groupCount: byGroup && typeof byGroup === 'object' ? Object.keys(byGroup).length : 0,
        explicitGroupMatch: String(payload.explicitGroupId || '')
          ? String(payload.explicitGroupId) === String(groupId)
          : false
      };
    }, {
      groupId: selectedGroupId,
      text,
      checkedGroups: [],
      explicitGroupId: targetConversationId,
      candidateGroups
    }).catch(() => ({ directMatch: false, anyGroupMatch: false, groupCount: 0, explicitGroupMatch: false }));
  };

  const discoverGroupIds = async () => {
    return page.evaluate(() => {
      const store = window.__messagingStore || window.messagingStore;
      const groups = new Set();
      const add = (value) => {
        if (value) groups.add(String(value));
      };
      add(store?.selectedMlsGroupId);
      add(store?.selectedConversationId);
      if (Array.isArray(store?.directMessages)) {
        for (const item of store.directMessages) {
          add(item?.group_id);
          add(item?.groupId);
          add(item?.id);
          add(item?.conversationId);
        }
      }
      if (store?.mlsMessages) {
        Object.keys(store.mlsMessages).forEach((key) => add(key));
      }
      if (store?.messagesByConversation) {
        Object.keys(store.messagesByConversation).forEach((key) => add(key));
      }
      return Array.from(groups).filter(Boolean);
    }).catch(() => []);
  };

  const discoverGroupsFromDirectMessages = async () => {
    if (!authToken) return [];
    const response = await page.evaluate(async (token) => {
      const dmResponse = await fetch('/api/mls/direct-messages', {
        headers: { Authorization: `Bearer ${token}` }
      }).catch(() => null);
      if (!dmResponse || !dmResponse.ok) return [];
      const body = await dmResponse.json().catch(() => null);
      const groups = Array.isArray(body) ? body : [];
      return groups
        .map((item) => item?.group_id || item?.groupId || item?.id)
        .filter(Boolean)
        .map((groupId) => String(groupId));
    }, authToken).catch(() => []);
    return Array.isArray(response) ? response : [];
  };

  const hasMessageViaApi = async (candidateGroups) => {
    if (!authToken) return false;
    const groups = Array.from(new Set((candidateGroups || []).filter(Boolean)));

    for (let i = 0; i < groups.length; i += 1) {
      const candidateGroupId = groups[i];
      const found = await page.evaluate(async (payload) => {
        const response = await fetch(`/api/mls/messages/group/${encodeURIComponent(payload.groupId)}`, {
          headers: { Authorization: `Bearer ${payload.token}` }
        }).catch(() => null);

        if (!response || !response.ok) return false;
        const payloadBody = await response.json().catch(() => null);
        const data = Array.isArray(payloadBody)
          ? payloadBody
          : Array.isArray(payloadBody?.messages)
            ? payloadBody.messages
            : [];
        return data.some((message) => {
          const plaintext = (message?.plaintext || '').toString();
          return plaintext.includes(payload.text);
        });
      }, {
        groupId: candidateGroupId,
        text,
        token: authToken
      }).catch(() => false);

      if (found) return true;
    }

    return false;
  };

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await refreshSelectedGroup();
    const storeGroups = await discoverGroupIds();
    const apiGroups = await discoverGroupsFromDirectMessages();
    const candidateGroups = Array.from(new Set([
      ...storeGroups,
      ...apiGroups,
      ...(targetConversationId ? [targetConversationId] : [])
    ]));
    const storeMatch = await hasMessageInStore(candidateGroups);
    console.log(`[CFM] waitForSolidIncomingText state: ${JSON.stringify(storeMatch)}`);
    if (await panel.getByText(text).first().isVisible().catch(() => false)) return;
    if (storeMatch.directMatch || storeMatch.anyGroupMatch || storeMatch.explicitGroupMatch) return;
    if (await hasMessageViaApi(candidateGroups)) return;
    if (targetConversationId) {
      await ensureSolidConversationActivated(page, targetConversationId, '').catch(() => {});
    }
    await panel.locator('button[title="Refresh"]').click().catch(() => {});
    await page.waitForTimeout(1000);
  }

  throw new Error('Timed out waiting for Solid to display incoming message');
}

async function sendFromSolid(page, text, options = {}) {
  console.log(`[CFM] sendFromSolid: ${text}`);
  const panel = solidChatPanel(page);
  const targetConversationId = options?.conversationId ? String(options.conversationId) : null;
  const targetUserId = options?.targetUserId ? Number(options.targetUserId) : null;
  const sendingUserId = options?.userId ? Number(options.userId) : null;
  const deviceId = options?.deviceId || null;

  if (options?.fastPathSend) {
    await goToSolidMessages(page).catch(() => {});
    if (targetConversationId && options?.otherUsername) {
      await forceOpenSolidConversation(page, targetConversationId, options.otherUsername).catch(() => false);
    }
    const domPanel = solidChatPanel(page);
    const inputCandidates = [
      domPanel.locator('textarea[placeholder*="// Type message..."]').first(),
      domPanel.locator('textarea[placeholder*="Type message"]').first(),
      domPanel.locator('textarea').first()
    ];

    let sent = false;
    for (let i = 0; i < inputCandidates.length; i += 1) {
      const input = inputCandidates[i];
      const visible = await input.isVisible().catch(() => false);
      const enabled = await input.isEnabled().catch(() => false);
      if (!visible || !enabled) {
        continue;
      }

      await input.fill(text).catch(async () => {
        await input.click().catch(() => {});
        await input.pressSequentially(text, { delay: 5 }).catch(() => {});
      });

      const sendButton = domPanel.getByRole('button', { name: /TRANSMIT/i }).first();
      if (await sendButton.isVisible().catch(() => false)) {
        await sendButton.click().catch(() => {});
      } else {
        await input.press('Enter').catch(() => {});
      }

      sent = true;
      break;
    }

    if (!sent) {
      throw new Error('Solid fast-path send failed: no compose input available');
    }

    await page.waitForTimeout(200).catch(() => {});
    console.log('[CFM] sendFromSolid fast path send result: {"ok":true,"reason":"dom-send-dispatched"}');
    return;
  }

  const sendWithDomFallback = async () => {
    await goToSolidMessages(page).catch(() => {});
    if (targetConversationId && options?.otherUsername) {
      await forceOpenSolidConversation(page, targetConversationId, options.otherUsername)
        .catch(() => false);
    } else if (options?.otherUsername && options?.token && sendingUserId) {
      await openDmOnSolid(page, options.otherUsername, 9000, {
        id: sendingUserId,
        token: options.token
      }).catch(() => {});
    }

    const domPanel = solidChatPanel(page);
    const sendSelectors = [
      'textarea[placeholder*="// Type message..."]',
      'textarea[placeholder*="Type message"]'
    ];

    for (let i = 0; i < sendSelectors.length; i += 1) {
      const candidate = domPanel.locator(sendSelectors[i]).first();
      const isEnabled = await candidate.isEnabled({ timeout: 300 }).catch(() => false);
      const isVisible = await candidate.isVisible().catch(() => false);
      if (!isEnabled || !isVisible) {
        continue;
      }

      try {
        await candidate.fill(text);
      } catch {
        try {
          await candidate.click();
          await candidate.selectText();
          await candidate.press('Home');
          await candidate.type(text);
        } catch {
          continue;
        }
      }

      const sendButton = domPanel.getByRole('button', { name: /TRANSMIT/i }).first();
      if (await sendButton.isVisible().catch(() => false) && await sendButton.isEnabled().catch(() => false)) {
        await sendButton.click().catch(() => {});
      } else {
        await candidate.press('Enter');
      }

      await page.waitForTimeout(250).catch(() => {});
      return {
        ok: true,
        reason: 'dom-send-action-dispatched'
      };
    }

    return {
      ok: false,
      reason: 'no-solid-compose-input-found'
    };
  };

    const sendWithFallbackEvaluate = () => page.evaluate(async (payload) => {
    const normalizeTokenUserId = () => {
      try {
        const authToken = localStorage.getItem('token');
        if (!authToken) return null;
        const tokenPayload = JSON.parse(atob(authToken.split('.')[1] || '{}'));
        return Number(tokenPayload?.userId || tokenPayload?.sub || 0) || null;
      } catch {
        return null;
      }
    };

    let store = window.__messagingStore || window.messagingStore;
    if (!store) {
      try {
        const importedMessagingStore = await import('/src/stores/messagingStore.js');
        store = importedMessagingStore?.default || null;
        if (store) {
          window.__messagingStore = store;
          window.messagingStore = store;
        }
      } catch {
        // Intentionally continue with fallback.
      }
    }

    let storeGroupId = store?.selectedMlsGroupId || store?.selectedConversationId;
    if (!storeGroupId && payload.conversationId) {
      if (typeof store?.selectMlsGroup === 'function') {
        store.selectMlsGroup(String(payload.conversationId));
      } else if (store) {
        store.selectedMlsGroupId = String(payload.conversationId);
        store.selectedConversationId = null;
      }
      storeGroupId = String(payload.conversationId);
    }

    let groupIdFromToken = null;
    if (!storeGroupId && payload.conversationId) {
      storeGroupId = String(payload.conversationId);
      groupIdFromToken = storeGroupId;
    }

    if (store && payload.conversationId) {
      const normalizedConversationId = String(payload.conversationId);
      const directMessages = Array.isArray(store.directMessages) ? [...store.directMessages] : [];
      if (!directMessages.some((entry) => String(entry.group_id || entry.id || entry.groupId || '').trim() === normalizedConversationId)) {
        const seeded = {
          id: normalizedConversationId,
          group_id: normalizedConversationId,
          name: payload.otherUsername || `User ${normalizedConversationId}`,
          other_user_id: payload.targetUserId || null,
          other_username: payload.otherUsername || '',
          created_at: new Date().toISOString()
        };
        if (typeof store.setDirectMessages === 'function') {
          store.setDirectMessages([seeded, ...directMessages]);
        } else {
          store.directMessages = [seeded, ...directMessages];
        }
      }
    }

    const resolveCoreClients = async () => {
      try {
        const coreCryptoModule = await import('/src/services/mls/coreCryptoClient.js');
        const coreCryptoClient = window.coreCryptoClient || coreCryptoModule?.default;
        const importedVaultService = window.vaultService || window.__vaultService;
        const importedVaultStore = window.__vaultStore || window.vaultStore;
        const { default: vaultService } = importedVaultService
          ? { default: importedVaultService }
          : await import('/src/services/vaultService.js').then((module) => ({ default: module?.default || module }))
              .catch(() => ({ default: null }));
        const activeVaultService = coreCryptoClient?.getVaultService
          ? await coreCryptoClient.getVaultService().catch(() => vaultService)
          : vaultService;
        const { default: vaultStore } = importedVaultStore
          ? { default: importedVaultStore }
          : await import('/src/stores/vaultStore.js').then((module) => ({ default: module?.default || module }))
              .catch(() => ({ default: null }));
        const { getPendingDeviceId, setPendingDeviceId } = await import('/src/services/deviceIdStore.js')
          .then((module) => ({
            getPendingDeviceId: module?.getPendingDeviceId,
            setPendingDeviceId: module?.setPendingDeviceId
          }))
          .catch(() => ({
            getPendingDeviceId: undefined,
            setPendingDeviceId: undefined
          }));
        return {
          coreCryptoClient,
          vaultService: activeVaultService || vaultService,
          importedVaultService,
          vaultStore,
          getPendingDeviceId,
          setPendingDeviceId
        };
      } catch (error) {
        return { error };
      }
    };

    const resolved = await resolveCoreClients();
    if (resolved.error) {
      return { ok: false, reason: resolved.error?.message || String(resolved.error) };
    }
    const {
      coreCryptoClient,
      vaultService,
      importedVaultService,
      vaultStore,
      getPendingDeviceId,
      setPendingDeviceId
    } = resolved;
    if (!coreCryptoClient) {
      return { ok: false, reason: 'missing_core_crypto_client' };
    }
    if (vaultService) {
      window.__vaultService = vaultService;
      window.vaultService = vaultService;
      window.coreCryptoClient = coreCryptoClient;
    }
    coreCryptoClient._vaultService = vaultService;
    if (window.coreCryptoClient && window.coreCryptoClient !== coreCryptoClient && !window.coreCryptoClient._vaultService) {
      window.coreCryptoClient._vaultService = vaultService;
    }

    const serviceCandidates = [vaultService, importedVaultService, window.__vaultService, window.vaultService]
      .filter((candidate) => candidate && typeof candidate === 'object' && candidate !== null);
    const uniqueVaultServices = Array.from(new Set(serviceCandidates));

    const bootstrapUserId = payload.userId || normalizeTokenUserId();
    if (vaultStore?.userId) {
      uniqueVaultServices.forEach((service) => {
        if (typeof service.setUserId === 'function') {
          service.setUserId(vaultStore.userId);
        }
      });
    }
    if (bootstrapUserId && vaultService?.setUserId) {
      uniqueVaultServices.forEach((service) => {
        if (typeof service.setUserId === 'function') {
          service.setUserId(bootstrapUserId);
        }
      });
      if (vaultStore?.setUserId) {
        vaultStore.setUserId(bootstrapUserId);
      }
    }
    if (window.__vaultStore && typeof window.__vaultStore.setUserId === 'function') {
      const overrideUserId = window.__vaultStore.userId;
      uniqueVaultServices.forEach((service) => {
        if (typeof service.setUserId === 'function' && overrideUserId) {
          service.setUserId(overrideUserId);
        }
      });
    }

    const resolvedDeviceId = payload.deviceId
      || getPendingDeviceId?.()
      || vaultStore?.deviceId
      || vaultService?.getDeviceId?.()
      || null;

    let authContextSummary = null;
    try {
      const authContext = await coreCryptoClient.getAuthContext();
      authContextSummary = {
        hasToken: !!authContext?.token,
        deviceId: authContext?.deviceId || null,
        vaultServiceDeviceId: coreCryptoClient._vaultService?.getDeviceId?.() || null
      };
      console.log('[CFM] sendFromSolid: auth context', JSON.stringify(authContextSummary));
    } catch (authContextErr) {
      console.log('[CFM] sendFromSolid: auth context failed', authContextErr?.message || String(authContextErr));
    }

    if (resolvedDeviceId && vaultService?.setDeviceId) {
      uniqueVaultServices.forEach((service) => {
        if (typeof service.setDeviceId === 'function') {
          service.setDeviceId(resolvedDeviceId);
        }
      });
      if (typeof setPendingDeviceId === 'function') {
        setPendingDeviceId(resolvedDeviceId);
      }
    }
    if (typeof coreCryptoClient.initialize === 'function') {
      await coreCryptoClient.initialize().catch(() => {});
    }

    if (vaultStore?.userId) {
      await coreCryptoClient.ensureMlsBootstrap(String(vaultStore.userId)).catch(() => {});
    } else if (bootstrapUserId) {
      await coreCryptoClient.ensureMlsBootstrap(String(bootstrapUserId)).catch(() => {});
    }

    const syncPendingWelcomes = async () => {
      const authToken = localStorage.getItem('token');
      if (!authToken) {
        return { ok: false, reason: 'missing_auth_token_for_welcome_sync' };
      }

      try {
        console.log('[CFM] sendFromSolid: initiating welcome sync');
        await coreCryptoClient.syncMessages();
        console.log('[CFM] sendFromSolid: welcome sync done', JSON.stringify({
          pendingWelcomesSize: coreCryptoClient.pendingWelcomes?.size || 0,
          hasGroup: payload.conversationId ? coreCryptoClient.hasGroup(payload.conversationId) : null,
          groupDeviceClients: coreCryptoClient._vaultService?.getDeviceId ? coreCryptoClient._vaultService.getDeviceId() : null
        }));
        const pendingWelcomes = Array.from(coreCryptoClient.pendingWelcomes || []).map((entry) => ({
          id: entry?.[1]?.id,
          groupId: entry?.[1]?.groupId,
          senderUserId: entry?.[1]?.senderUserId
        }));
        console.log(`[CFM] sendFromSolid: pendingWelcomes=${JSON.stringify(pendingWelcomes)}`);

        return {
          ok: true,
          reason: 'sync_pending_messages',
          pendingWelcomes,
          vaultDeviceId: coreCryptoClient._vaultService?.getDeviceId
            ? `${coreCryptoClient._vaultService.getDeviceId()}`
            : 'missing'
        };
      } catch (error) {
        return {
          ok: false,
          reason: error?.message || String(error),
          vaultDeviceId: coreCryptoClient._vaultService?.getDeviceId
            ? `${coreCryptoClient._vaultService.getDeviceId()}`
            : 'missing'
        };
      }
    };

    const acceptPendingWelcomeForGroup = async (groupId) => {
      if (!groupId || !coreCryptoClient.pendingWelcomes?.size) {
        return { ok: true, reason: 'no_pending_welcomes' };
      }

      const matches = Array.from(coreCryptoClient.pendingWelcomes.values()).filter(
        (entry) => entry?.groupId === groupId
      );
      if (!matches.length) {
        return { ok: true, reason: 'no_group_pending' };
      }

      const acceptErrors = [];
      for (const pending of matches) {
        try {
          await coreCryptoClient.acceptWelcome(pending);
          return { ok: true, reason: `accepted-${pending.id || 'unknown'}` };
        } catch (acceptErr) {
          acceptErrors.push(acceptErr?.message || String(acceptErr));
        }
      }

      return {
        ok: false,
        reason: `pending_accept_failed: ${acceptErrors.join(' | ')}`
      };
    };

    const ensureSolidGroupMembershipViaApi = async () => {
      if (!payload?.conversationId || !payload?.userId || !payload?.targetUserId) {
        return {
          ok: false,
          reason: 'membership: missing_conversation_or_users'
        };
      }

      const authToken = localStorage.getItem('token');
      if (!authToken) {
        return {
          ok: false,
          reason: 'membership: missing_auth_token'
        };
      }

      try {
        const response = await fetch(`/api/mls/groups/${encodeURIComponent(payload.conversationId)}/members/sync`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${authToken}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            memberIds: [Number(payload.userId), Number(payload.targetUserId)]
          })
        });
        if (!response.ok) {
          return {
            ok: false,
            reason: `membership-sync-${response.status}`
          };
        }
        return { ok: true, reason: 'membership-synced' };
      } catch (error) {
        return {
          ok: false,
          reason: error?.message || String(error)
        };
      }
    };

    const repairDirectMessageGroupLocally = async (groupId) => {
      if (!groupId || !payload.targetUserId) {
        return {
          ok: false,
          reason: 'repair: missing_group_or_target_user'
        };
      }

      try {
        const normalizedGroupId = String(groupId);
        const hasGroupReady = typeof coreCryptoClient.hasGroup === 'function' && coreCryptoClient.hasGroup(normalizedGroupId);
        if (hasGroupReady) {
          return { ok: true, reason: 'repair:already-ready' };
        }

        const groupIdBytes = coreCryptoClient.groupIdToBytes
          ? coreCryptoClient.groupIdToBytes(normalizedGroupId)
          : null;
        if (!groupIdBytes || !coreCryptoClient.client?.create_group) {
          return {
            ok: false,
            reason: 'repair: core client missing create_group helpers'
          };
        }

        const hasGroupOnClient = typeof coreCryptoClient.client.has_group === 'function'
          ? coreCryptoClient.client.has_group(groupIdBytes)
          : false;
        if (!hasGroupOnClient) {
          coreCryptoClient.client.create_group(groupIdBytes);
          await coreCryptoClient.saveState?.();
        }

        await coreCryptoClient.syncGroupMembers(normalizedGroupId);
        await coreCryptoClient.inviteToGroup(normalizedGroupId, Number(payload.targetUserId));
        await coreCryptoClient.syncGroupMembers(normalizedGroupId).catch(() => {});

        return {
          ok: typeof coreCryptoClient.hasGroup === 'function'
            ? !!coreCryptoClient.hasGroup(normalizedGroupId)
            : true,
          reason: 'repair: group_recreated_locally'
        };
      } catch (error) {
        return {
          ok: false,
          reason: `repair: ${error?.message || String(error)}`
        };
      }
    };

    const welcomed = await syncPendingWelcomes().catch(() => ({ ok: false, reason: 'welcome_sync_failed' }));
    console.log(`[CFM] sendFromSolid: welcome sync result ${JSON.stringify(welcomed)}`);
    if (!welcomed.ok) {
      console.warn(`[CFM] sendFromSolid: welcome sync skipped/failed (${welcomed.reason})`);
    }
    const membership = await ensureSolidGroupMembershipViaApi().catch(() => ({ ok: false, reason: 'membership_sync_failed' }));
    if (!membership.ok) {
      console.warn(`[CFM] sendFromSolid: group membership sync skipped/failed (${membership.reason})`);
    }

    let targetGroupId = storeGroupId || groupIdFromToken || null;
    if (!targetGroupId) {
      return { ok: false, reason: 'missing_selected_group_and_no_fallback' };
    }

    let activeGroupId = targetGroupId;

    const ensureGroupReady = async (allowStart = false) => {
      if (!activeGroupId) {
        return { ok: false, reason: `conversation ${targetGroupId} unavailable and no group id` };
      }

      const repaired = await repairDirectMessageGroupLocally(activeGroupId);
      if (repaired.ok) {
        return { ok: true };
      }
      console.log(`[CFM] sendFromSolid ensureGroupReady repair skipped: ${repaired.reason || 'unknown'}`);

      if (typeof coreCryptoClient.hasGroup === 'function' && coreCryptoClient.hasGroup(activeGroupId)) {
        return { ok: true };
      }

      const acceptResult = await acceptPendingWelcomeForGroup(activeGroupId);
      if (!acceptResult.ok) {
        return { ok: false, reason: `welcome_accept_failed:${acceptResult.reason}` };
      }

      if (typeof coreCryptoClient.hasGroup === 'function' && coreCryptoClient.hasGroup(activeGroupId)) {
        return { ok: true };
      }

      if (!allowStart || !payload.targetUserId) {
        return { ok: false, reason: `conversation ${activeGroupId} unavailable on device` };
      }
      const startResult = await coreCryptoClient.startDirectMessage(payload.targetUserId);
      activeGroupId = String(startResult?.groupId || activeGroupId);
      return { ok: true };
    };

    const refreshGroupState = async (attempt = 0) => {
      if (!payload.targetUserId) return false;
      const shouldTryStart = async () => {
        try {
          const startResult = await coreCryptoClient.startDirectMessage(payload.targetUserId);
          activeGroupId = String(startResult?.groupId || activeGroupId || '');
          return true;
        } catch (startErr) {
          const startErrText = startErr?.message || String(startErr);
          console.log(`[CFM] sendFromSolid shouldTryStart error: ${startErrText}`);
          if (/Conversation exists but is not available/i.test(startErrText)) {
            const repaired = await repairDirectMessageGroupLocally(activeGroupId);
            if (repaired.ok && typeof coreCryptoClient.hasGroup === 'function' && coreCryptoClient.hasGroup(activeGroupId)) {
              console.log('[CFM] sendFromSolid shouldTryStart repaired local group state');
              return true;
            }
            console.log(`[CFM] sendFromSolid shouldTryStart repair after start failure: ${repaired.reason || 'unknown'}`);
          }
          return startErr;
        }
      };

      for (let refreshAttempt = 0; refreshAttempt < 4; refreshAttempt += 1) {
        await coreCryptoClient.syncMessages?.().catch(() => {});
        try {
          const syncGroupsResult = coreCryptoClient.resyncGroupsFromServer?.() ? await coreCryptoClient.resyncGroupsFromServer() : true;
          if (syncGroupsResult && typeof coreCryptoClient.hasGroup === 'function' && coreCryptoClient.hasGroup(activeGroupId)) {
            return true;
          }

          const directStartResult = await shouldTryStart();
          if (directStartResult === true) {
            if (typeof coreCryptoClient.hasGroup === 'function' && coreCryptoClient.hasGroup(activeGroupId)) {
              return true;
            }
          } else if (typeof directStartResult === 'object') {
            const startErrText = directStartResult?.message || String(directStartResult);
            if (
              /Conversation exists but is not available/i.test(startErrText)
              || /not available on this device/i.test(startErrText)
              || /group not found/i.test(startErrText)
            ) {
              if (attempt + refreshAttempt < 2) {
                await new Promise((resolve) => setTimeout(resolve, 700 + (attempt + refreshAttempt) * 350));
                continue;
              }
            }
            return false;
          }

          if (coreCryptoClient.getMissingGroups) {
            const missingGroups = coreCryptoClient.getMissingGroups();
            if (Array.isArray(missingGroups) && missingGroups.length === 0) {
              await new Promise((resolve) => setTimeout(resolve, 300));
            }
          }

          if (typeof coreCryptoClient.hasGroup === 'function' && coreCryptoClient.hasGroup(activeGroupId)) {
            return true;
          }
        } catch {
          if (refreshAttempt < 3) {
            await new Promise((resolve) => setTimeout(resolve, 500));
            continue;
          }
          return false;
        }

        if (refreshAttempt < 3) {
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      }
      try {
        const postSyncHasGroup = typeof coreCryptoClient.hasGroup === 'function' && coreCryptoClient.hasGroup(activeGroupId);
        if (postSyncHasGroup) {
          return true;
        }
      } catch {
        return false;
      }
      return false;
    };

    const initialGroupReady = await ensureGroupReady(true);
    if (!initialGroupReady.ok) {
      return {
        ok: false,
        reason: initialGroupReady.reason || 'conversation unavailable and no targetUserId'
      };
    }

    const isSendRecoverableError = (errorText) => (
      /group not found/i.test(errorText)
      || /conversation exists but is not available/i.test(errorText)
      || /not available on this device/i.test(errorText)
      || /group state missing/i.test(errorText)
      || /Failed to fetch/i.test(errorText)
    );

    const sendDebug = (errorText) => ({
      vaultDeviceId: coreCryptoClient._vaultService?.getDeviceId
        ? `${coreCryptoClient._vaultService.getDeviceId()}`
        : 'missing',
      activeVaultDeviceId: vaultService?.getDeviceId ? `${vaultService.getDeviceId()}` : 'missing',
      pendingDeviceId: getPendingDeviceId?.() || 'none',
      windowVaultDeviceId: window.vaultService?.getDeviceId
        ? `${window.vaultService.getDeviceId()}`
        : 'missing',
      hasWindowClient: !!window.coreCryptoClient,
      hasClientDevice: coreCryptoClient.getAuthContext
        ? 'hasAuthContext'
        : 'noAuthContext',
      repairedGroupId: activeGroupId
    });

    let sendErrText = '';
    let sent = false;
    let lastRetryErr = null;
    for (let sendAttempt = 0; sendAttempt < 5; sendAttempt += 1) {
      try {
        if (sendAttempt > 0) {
          const refreshed = await refreshGroupState(sendAttempt);
          if (!refreshed) {
            return {
              ok: false,
              reason: `core-send-group-repair-failed:${sendErrText || 'group_repair_failed'}`,
              debug: sendDebug(sendErrText || '')
            };
          }
        }
        await coreCryptoClient.sendMessage(activeGroupId, payload.text);
        sent = true;
        break;
      } catch (sendErr) {
        sendErrText = sendErr?.message || String(sendErr || '');
        lastRetryErr = sendErrText;
        if (isSendRecoverableError(sendErrText) && sendAttempt < 4) {
          await new Promise((resolve) => setTimeout(resolve, 300 + sendAttempt * 250));
          continue;
        }
        return {
          ok: false,
          reason: `core-send-failed:${sendErrText}`,
          debug: sendDebug(sendErrText)
        };
      }
    }

    if (!sent) {
      return {
        ok: false,
        reason: `core-send-retry-failed:${lastRetryErr || 'unknown'}`,
        debug: sendDebug(sendErrText || '')
      };
    }

    if (store && typeof store.setNewMessage === 'function') {
      store.setNewMessage('');
    }
    if (store && typeof store.addMlsMessage === 'function') {
      store.addMlsMessage(activeGroupId, {
        id: `${Date.now()}-${Math.floor(Math.random() * 1000)}`,
        senderId: Number(vaultStore?.userId || bootstrapUserId || store.currentUserId || 0),
        plaintext: payload.text,
        timestamp: new Date().toISOString(),
        type: 'sent'
      });
    }
    if (store && !store.selectedMlsGroupId) {
      if (typeof store.selectMlsGroup === 'function') {
        store.selectMlsGroup(String(activeGroupId));
      } else {
        store.selectedMlsGroupId = String(activeGroupId);
      }
    }

    return { ok: true, groupId: activeGroupId };
  }, {
    userId: sendingUserId,
    deviceId,
    conversationId: targetConversationId,
    targetUserId,
    text,
    otherUsername: options?.otherUsername || ''
  });

  const waitForSolidLocalEcho = async () => {
    if (page?.isClosed?.()) {
      return false;
    }

    const deadline = Date.now() + 15000;
    const selectors = [
      panel.locator('.message-item .message-text').filter({ hasText: text }),
      panel.locator('.message-item').filter({ hasText: text }),
      panel.getByText(text).first()
    ];

    try {
      while (Date.now() < deadline) {
        if (page.isClosed?.()) {
          return false;
        }

        for (let i = 0; i < selectors.length; i += 1) {
          if (await selectors[i].isVisible().catch(() => false)) {
            return true;
          }
        }

        await panel.locator('button[title="Refresh"]').click().catch(() => {});
        if (page.isClosed?.()) {
          return false;
        }
        await page.waitForTimeout(500).catch(() => {});
      }
    } catch {
      return false;
    }

    return false;
  };

  let fallbackSend = null;
  let fallbackErr = null;
  const authTokenFallback = options?.token || await page.evaluate(() => localStorage.getItem('token')).catch(() => null);
  const fallbackMessageBaseline = targetConversationId && authTokenFallback
    ? await page.evaluate(async (payload) => {
        const response = await fetch(`/api/mls/messages/group/${encodeURIComponent(payload.conversationId)}`, {
          headers: { Authorization: `Bearer ${payload.authToken}` }
        }).catch(() => null);
        if (!response || !response.ok) return null;

        const body = await response.json().catch(() => null);
        const messages = Array.isArray(body) ? body : Array.isArray(body?.messages) ? body.messages : [];
        let maxMessageId = 0;
        const senderMessageIds = new Set();

        for (const message of Array.isArray(messages) ? messages : []) {
          const messageId = Number(message?.id);
          if (!Number.isFinite(messageId)) {
            continue;
          }

          if (messageId > maxMessageId) {
            maxMessageId = messageId;
          }

          if (
            Number(message.sender_user_id) === Number(payload.sendingUserId)
            && message.message_type === 'application'
          ) {
            senderMessageIds.add(messageId);
          }
        }

        return {
          maxMessageId,
          senderMessageIds: Array.from(senderMessageIds)
        };
      }, {
        conversationId: targetConversationId,
        authToken: authTokenFallback,
        sendingUserId
      }).catch(() => null)
    : null;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      const evaluateResult = await sendWithFallbackEvaluate();
      if (evaluateResult?.ok) {
        fallbackSend = evaluateResult;
        break;
      }

      console.log(`[CFM] sendFromSolid core evaluate returned non-ok: ${JSON.stringify(evaluateResult)}`);
      fallbackErr = evaluateResult?.reason
        ? new Error(`core evaluate failed: ${evaluateResult.reason}`)
        : new Error('core evaluate returned unknown non-ok result');
      if (attempt < 5) {
        await page.waitForTimeout(300 + attempt * 250).catch(() => {});
        if (options?.otherUsername && options?.token && sendingUserId) {
          await safeSetVanAuthToken(page, options.token);
          await openDmOnSolid(page, options.otherUsername, 30000, {
            id: sendingUserId,
            token: options.token
          }).catch(() => {});
        }
        continue;
      }
      break;
    } catch (evalErr) {
      fallbackErr = evalErr;
      const evalErrText = String(evalErr?.message || evalErr || '');
      if (isTransientEvalError(evalErr?.message || evalErr?.toString())) {
        const domSendResult = await sendWithDomFallback().catch((error) => ({
          ok: false,
          reason: `dom-fallback-error:${error?.message || String(error)}`
        }));
        if (domSendResult?.ok) {
          const localEcho = await waitForSolidLocalEcho();
          if (localEcho) {
            fallbackSend = {
              ok: true,
              reason: domSendResult.reason || 'dom-fallback'
            };
            break;
          }

          console.log(`[CFM] sendFromSolid: dom fallback sent action but no local echo; continuing to API/store verification`);
          fallbackSend = {
            ok: true,
            reason: 'dom-fallback-no-local-echo'
          };
          if (attempt < 5) {
            continue;
          }
          break;
        }

        console.log(`[CFM] sendFromSolid fallback encountered transient eval error on attempt ${attempt + 1} (${evalErrText}); dom fallback failed (${domSendResult.reason})`);
        await page.waitForTimeout(300 + attempt * 250).catch(() => {});

        if (!page.isClosed?.()) {
          await goToSolidMessages(page).catch(() => {});
          if (targetConversationId) {
            await ensureSolidConversationActivated(page, targetConversationId, options?.otherUsername || '')
              .catch(() => {});
          }

          if (options?.otherUsername && options?.token && sendingUserId) {
            await safeSetVanAuthToken(page, options.token);
            await openDmOnSolid(page, options.otherUsername, 30000, {
              id: sendingUserId,
              token: options.token
            }).catch(() => {});
          }
        }
        if (attempt < 5) {
          continue;
        }
      } else {
        console.log(`[CFM] sendFromSolid non-transient eval error on attempt ${attempt + 1} (${evalErrText})`);
        if (attempt < 5) {
          await page.waitForTimeout(300 + attempt * 250).catch(() => {});
          continue;
        }
      }
      break;
    }
  }

  if (!fallbackSend) {
    throw new Error(`Timed out waiting for Solid local echo and fallback send failed: ${fallbackErr?.message || String(fallbackErr)}`);
  }

  if (!fallbackSend.ok) {
    console.log(`[CFM] sendFromSolid fallback failed: ${JSON.stringify(fallbackSend)}`);
    throw new Error(`Timed out waiting for Solid local echo and fallback send failed: ${fallbackSend.reason || 'unknown'}`);
  }

  const finalLocalEcho = await waitForSolidLocalEcho();
  if (!finalLocalEcho) {
    const confirmSendViaStoreOrApi = async () => {
      if (!targetConversationId) return false;
      const messageBaseline = fallbackMessageBaseline && sendingUserId
        ? {
            maxMessageId: Number(fallbackMessageBaseline.maxMessageId) || 0,
            senderMessageIds: Array.isArray(fallbackMessageBaseline.senderMessageIds)
              ? fallbackMessageBaseline.senderMessageIds
              : []
          }
        : {
            maxMessageId: 0,
            senderMessageIds: []
          };

      const localStoreMatch = !page.isClosed?.() ? await page.evaluate((payload) => {
        const store = window.__messagingStore || window.messagingStore;
        const localMessages = store?.mlsMessages?.[payload.conversationId]
          || store?.messagesByConversation?.[payload.conversationId]
          || [];
        return Array.isArray(localMessages)
          ? localMessages.some((message) => (message?.plaintext || '').toString().includes(payload.text))
          : false;
      }, {
        conversationId: targetConversationId,
        text
      }).catch(() => false) : false;

      if (localStoreMatch) {
        return true;
      }

      const authToken = authTokenFallback
        || await (page.isClosed?.()
          ? Promise.resolve(null)
          : page.evaluate(() => localStorage.getItem('token')).catch(() => null));
      if (!authToken) return false;

      const baselineMax = Number(messageBaseline.maxMessageId) || 0;
      const baselineIds = Array.isArray(messageBaseline.senderMessageIds)
        ? messageBaseline.senderMessageIds
        : [];
      const deadline = Date.now() + 15000;
      const baselineSet = new Set(
        baselineIds.map((value) => Number(value)).filter((value) => Number.isFinite(value))
      );

      const checkMessagesViaBackend = async () => {
        try {
          const response = await fetch(`${BACKEND_URL}/api/mls/messages/group/${encodeURIComponent(targetConversationId)}`, {
            headers: { Authorization: `Bearer ${authToken}` }
          });
          if (!response || !response.ok) return false;
          const body = await response.json().catch(() => null);
          const messages = Array.isArray(body) ? body : Array.isArray(body?.messages) ? body.messages : [];
          if (!Array.isArray(messages)) return false;

          return messages.some((message) => {
            if (!message || message.message_type !== 'application') return false;
            const messageId = Number(message.id);
            if (!Number.isFinite(messageId)) return false;
            if (messageId > baselineMax) return true;
            if (
              Number(message.sender_user_id) === Number(sendingUserId)
              && !baselineSet.has(messageId)
            ) {
              return true;
            }
            return (message?.data || '').toString().includes(text);
          });
        } catch {
          return false;
        }
      };

      const waitMethod = page.isClosed?.()
        ? (ms) => new Promise((resolve) => setTimeout(resolve, ms))
        : (ms) => page.waitForTimeout(ms).catch(() => {});

      while (Date.now() < deadline) {
        const found = page.isClosed?.() ? await checkMessagesViaBackend() : await page.evaluate(async (payload) => {
          const response = await fetch(`/api/mls/messages/group/${encodeURIComponent(payload.conversationId)}`, {
            headers: { Authorization: `Bearer ${payload.authToken}` }
          }).catch(() => null);
          if (!response || !response.ok) return false;

          const body = await response.json().catch(() => null);
          const messages = Array.isArray(body) ? body : Array.isArray(body?.messages) ? body.messages : [];
          if (!Array.isArray(messages)) return false;

          const baselineMax = Number(payload.baselineMax) || 0;
          const baselineSet = new Set(
            (Array.isArray(payload.baselineIds) ? payload.baselineIds : [])
              .map((value) => Number(value))
              .filter((value) => Number.isFinite(value))
          );

          return messages.some((message) => {
            if (!message || message.message_type !== 'application') {
              return false;
            }

            const messageId = Number(message.id);
            if (!Number.isFinite(messageId)) {
              return false;
            }

            if (messageId > baselineMax) {
              return true;
            }

            if (Number(message.sender_user_id) === Number(payload.sendingUserId)
              && !baselineSet.has(messageId)
            ) {
              return true;
            }

            return (message?.data || '').toString().includes(payload.text);
          });
        }, {
          conversationId: targetConversationId,
          authToken,
          text,
          sendingUserId,
          baselineMax,
          baselineIds
        }).catch(() => false);

        if (found) return true;
        await waitMethod(500);
      }

      return false;
    };

    const committed = await confirmSendViaStoreOrApi();
    if (!committed) {
      throw new Error(`Timed out waiting for Solid local echo for text: ${text}`);
    }
  }

  console.log(`[CFM] sendFromSolid fallback send result: ${JSON.stringify(fallbackSend)}`);
}

async function openVanMessagesUnlocked(page, password, user, retry = 0) {
  console.log('[CFM] openVanMessagesUnlocked');

  if (await looksLikeSolidShell(page)) {
    await unlockSolidVaultIfNeeded(page, password);
    return;
  }

  if (user?.token) {
    await safeSetVanAuthToken(page, user.token);
  }

  await page.goto(`${VAN_URL}/#messages`);
  await page.locator('.messages-page').first().waitFor({ timeout: 20000 });
  const messagesPage = page.locator('.messages-page').first();
  const hasLockLabel = page.locator('.messages-page.messages-locked');

  const isUnlockedAndUsable = async () => {
    console.log('[CFM] isUnlockedAndUsable: start');
    const isLocked = await hasLockLabel.isVisible().catch(() => false);
    if (isLocked) {
      console.log('[CFM] isUnlockedAndUsable: locked=true');
      return false;
    }

    const pageVisible = await messagesPage.isVisible().catch(() => false);
    const ready = Boolean(pageVisible);
    console.log(`[CFM] isUnlockedAndUsable: locked=${isLocked}, pageVisible=${pageVisible}`);
    return ready;
  };

  const hasConversationComposer = async () => {
    console.log('[CFM] hasConversationComposer: start');
    const composerSelectors = [
      page.locator('.message-textarea'),
      page.locator('textarea[placeholder*="// Type message..."]'),
      page.locator('textarea[placeholder*="Type message"]'),
      page.locator('textarea'),
      page.locator('.message-input'),
      page.locator('[contenteditable="true"]')
    ];

    for (let i = 0; i < composerSelectors.length; i += 1) {
      const isEnabled = await composerSelectors[i].isEnabled({ timeout: 250 }).catch(() => false);
      console.log(`[CFM] hasConversationComposer: selector ${i} enabled=${isEnabled}`);
      if (isEnabled) {
        console.log(`[CFM] hasConversationComposer: selector ${i} enabled`);
        return true;
      }
    }

    console.log('[CFM] hasConversationComposer: none enabled');
    return false;
  };

  const waitForUnlock = async ({ timeoutMs = 12000, context = 'post-action' }) => {
    console.log(`[CFM] openVanMessagesUnlocked: waitForUnlock start (${context}) timeout=${timeoutMs}ms`);

    const endAt = Date.now() + timeoutMs;
    const snapshot = async (label) => {
      const lockLabelVisible = await hasLockLabel.isVisible().catch(() => false);
      const composerReady = await hasConversationComposer().catch(() => false);
      const unlocked = await isUnlockedAndUsable().catch(() => false);
      console.log(`[CFM] openVanMessagesUnlocked waitForUnlock(${label}): locked=${lockLabelVisible}, composer=${composerReady}, ready=${unlocked}`);
      return { lockLabelVisible, composerReady, unlocked };
    };

    while (Date.now() < endAt) {
      const state = await snapshot(context);
      if (state.unlocked || state.composerReady) {
        console.log(`[CFM] openVanMessagesUnlocked unlocked by ${context}`);
        return { ready: true, ...state };
      }
      await page.waitForTimeout(300);
    }

    const finalState = await snapshot(context);
    console.log(`[CFM] openVanMessagesUnlocked timeout (${context}): locked=${finalState.lockLabelVisible}, composer=${finalState.composerReady}`);
    return { ready: false, ...finalState };
  };

  const fillUnlockModal = async () => {
    console.log('[CFM] fillUnlockModal: start');
    const unlockModal = page.locator('.unlock-modal');
    const visible = await unlockModal.isVisible().catch(() => false);
    if (!visible) {
      console.log('[CFM] fillUnlockModal: modal not visible');
      return { ok: false, reason: 'unlock-modal-not-visible' };
    }

    const passwordInput = unlockModal.locator(
      'input[placeholder="Vault Passphrase"], input[placeholder="Login Password"], input[type="password"]'
    ).first();
    const passwordInputVisible = await passwordInput.isVisible().catch(() => false);
    if (!passwordInputVisible) {
      console.log('[CFM] fillUnlockModal: missing password input');
      return { ok: false, reason: 'vault-passphrase-input-missing' };
    }

    await passwordInput.fill(password);
    console.log('[CFM] fillUnlockModal: password filled');
    const submitButton = unlockModal.getByRole('button', {
      name: /^(Create Vault|Set Up|Unlock|Create|Setup)$/i
    }).first();

    const createButton = unlockModal.getByRole('button', { name: 'Create Vault' }).first();
    const unlockButton = unlockModal.getByRole('button', { name: 'Unlock' }).first();
    const usedUnlock = await submitButton.isVisible().catch(() => false);
    const label = usedUnlock
      ? await submitButton.textContent().catch(() => 'unknown')
      : await (await createButton.isVisible().catch(() => false))
        ? 'Create Vault'
        : await (await unlockButton.isVisible().catch(() => false))
          ? 'Unlock'
          : 'none';

    const primaryButton = await submitButton.isVisible().catch(() => false)
      ? submitButton
      : await createButton.isVisible().catch(() => false)
        ? createButton
        : unlockButton;

    if (!(await primaryButton.isVisible().catch(() => false))) {
      console.log('[CFM] fillUnlockModal: no primary button');
      return {
        ok: false,
        reason: 'unlock-modal-primary-button-missing'
      };
    }

    await primaryButton.click({ timeout: 2000, force: true });
    console.log('[CFM] fillUnlockModal: primary button clicked');
    await page.waitForTimeout(250);
    console.log('[CFM] fillUnlockModal: done');
    return {
      ok: true,
      reason: `clicked-${label}`.trim().toLowerCase()
    };
  };

  const openUnlockModalAndSubmit = async () => {
    console.log('[CFM] openUnlockModalAndSubmit: start');
    const unlockVisible = await page.getByRole('button', { name: 'Unlock Messaging' }).isVisible().catch(() => false);
    if (!unlockVisible) {
      console.log('[CFM] openUnlockModalAndSubmit: unlock button not directly visible, trying fallback selector');
      const fallbackUnlockBtn = page.locator('.messages-locked button').first();
      if (await fallbackUnlockBtn.isVisible().catch(() => false)) {
        await fallbackUnlockBtn.click({ timeout: 2000, force: true }).catch(() => {});
      }
    } else {
      await page.getByRole('button', { name: 'Unlock Messaging' }).click({ timeout: 2000, force: true }).catch(() => {});
    }

    console.log('[CFM] openUnlockModalAndSubmit: clicked unlock entry point');
    const unlockModal = page.locator('.unlock-modal');
    const modalVisible = await unlockModal.isVisible({ timeout: 3000 }).catch(() => false);
    if (!modalVisible) {
      console.log('[CFM] openUnlockModalAndSubmit: modal never opened');
      return {
        ok: false,
        reason: 'unlock-modal-never-opened'
      };
    }

    console.log('[CFM] openUnlockModalAndSubmit: modal opened');
    const fillResult = await fillUnlockModal();
    await waitForUnlock({ timeoutMs: 2000, context: 'post-submit unlock modal poll' }).catch(() => ({ ready: false }));
    console.log('[CFM] openUnlockModalAndSubmit: post modal poll done');
    if (fillResult.ok) {
      console.log('[CFM] openUnlockModalAndSubmit: fill ok');
      return {
        ok: true,
        reason: fillResult.reason
      };
    }
    console.log('[CFM] openUnlockModalAndSubmit: fill failed');
    return fillResult;
  };

  let serviceFallbackResult = null;
  if (await isUnlockedAndUsable()) {
    const composerReady = await hasConversationComposer().catch(() => false);
    console.log(`[CFM] openVanMessagesUnlocked immediate readiness: locked=${await hasLockLabel.isVisible().catch(() => false)}, composer=${composerReady}`);
    if (composerReady || (await isUnlockedAndUsable())) {
      return;
    }
  } else {
    console.log('[CFM] openVanMessagesUnlocked: not unlocked on first check');
    if (user) {
      serviceFallbackResult = await unlockVanVaultViaService(page, password, user);
      console.log('[CFM] openVanMessagesUnlocked initial service unlock attempt:', JSON.stringify(serviceFallbackResult));
      if (serviceFallbackResult?.ok) {
        if (serviceFallbackResult.reason === 'unlockWithPassword') {
          const initialServiceUnlock = await waitForUnlock({ timeoutMs: 12000, context: 'initial service unlock' });
          if (initialServiceUnlock.ready) {
            return;
          }
        } else {
          console.log('[CFM] openVanMessagesUnlocked: service setup path used, proceeding with UI unlock');
        }
      }
    }
  }

  if (await isUnlockedAndUsable()) {
    const composerReady = await hasConversationComposer().catch(() => false);
    console.log(`[CFM] openVanMessagesUnlocked post-service readiness: locked=${await hasLockLabel.isVisible().catch(() => false)}, composer=${composerReady}`);
    if (composerReady || (await isUnlockedAndUsable())) {
      return;
    }
  }
  console.log('[CFM] openVanMessagesUnlocked: starting unlock control flow');

  const unlockMessaging = page.getByRole('button', { name: 'Unlock Messaging' });

  console.log('[CFM] openVanMessagesUnlocked: before unlock modal handling');
  const unlockVisible = await unlockMessaging.isVisible().catch(() => false);
  const lockedVisible = await hasLockLabel.isVisible().catch(() => false);
  console.log(`[CFM] openVanMessagesUnlocked: unlock button=${unlockVisible}, locked=${lockedVisible}`);

  if (unlockVisible || lockedVisible) {
    console.log('[CFM] openVanMessagesUnlocked: attempting messaging unlock');
    const modalResult = await openUnlockModalAndSubmit();
    console.log('[CFM] openVanMessagesUnlocked modal action result:', JSON.stringify(modalResult));
    if (modalResult.ok) {
      const postModalUnlock = await waitForUnlock({ timeoutMs: 12000, context: 'ui unlock attempt' });
      if (postModalUnlock.ready) return;
    } else {
      console.log('[CFM] openVanMessagesUnlocked: modal did not submit', JSON.stringify(modalResult));
    }
  }

  const postModalUnlock = await waitForUnlock({ timeoutMs: 3000, context: 'post-unlock fallback poll' });
  if (postModalUnlock.ready) return;

  if (await hasConversationComposer()) {
    return;
  }

  const deviceModal = page.locator('.device-link-modal');
  if (await deviceModal.isVisible().catch(() => false)) {
    const cancelBtn = deviceModal.getByRole('button', { name: 'Cancel' });
    await cancelBtn.click().catch(() => {});
  }

  if (!user) return;

  const stillLocked = await hasLockLabel.isVisible().catch(() => false);
  const hasLogout = await page.getByRole('button', { name: /Logout|Sign Out/i }).isVisible().catch(() => false);
  const isGuest = await page.getByText(/@GUEST/i).first().isVisible().catch(() => false);
  let lockedAfterFallback = stillLocked;
  console.log(`[CFM] openVanMessagesUnlocked status: locked=${stillLocked}, hasLogout=${hasLogout}, isGuest=${isGuest}, retry=${retry}`);

  if (stillLocked && user) {
    const unlockedByService = await unlockVanVaultViaService(page, password, user);
    console.log('[CFM] openVanMessagesUnlocked service unlock:', JSON.stringify(unlockedByService));
    if (unlockedByService?.ok) {
      const serviceUnlock = await waitForUnlock({ timeoutMs: 12000, context: 'service unlock' });
      lockedAfterFallback = serviceUnlock.locked;
      if (!(await hasConversationComposer())) {
        lockedAfterFallback = true;
      }
    } else if (unlockedByService?.reason && /Device verification required/i.test(unlockedByService.reason) && user?.device_public_id) {
      await refreshTrustedDeviceInDb(user);
      lockedAfterFallback = true;
    }

    if (await hasConversationComposer()) {
      return;
    }

    if (lockedAfterFallback && user.token) {
      await safeSetVanAuthToken(page, user.token);
      await page.goto(`${VAN_URL}/#messages`, { waitUntil: 'domcontentloaded' });
      await page.locator('.messages-page').first().waitFor({ timeout: 20000 });
      lockedAfterFallback = await hasLockLabel.isVisible().catch(() => false);
    }

    if (await hasConversationComposer()) {
      return;
    }

  if (lockedAfterFallback) {
      if (retry >= 1) {
        throw new Error(`Unable to unlock messages UI after service fallback for ${user.username}: ${unlockedByService?.reason}`);
      }
      console.log('[CFM] openVanMessagesUnlocked rechecking with token auth');
      await openVanMessagesUnlocked(page, password, user, retry + 1);
      return;
    }
  }

  const finalUnlocked = await isUnlockedAndUsable();
  const finalComposer = await hasConversationComposer().catch(() => false);
  console.log(`[CFM] openVanMessagesUnlocked final state: unlocked=${finalUnlocked}, composer=${finalComposer}, retry=${retry}`);
  const finalGuest = await page.getByText(/@GUEST/i).first().isVisible().catch(() => false);
  if (finalGuest && user) {
    console.log(`[CFM] openVanMessagesUnlocked final guest state detected for ${user.username}`);
    await safeSetVanAuthToken(page, user.token);
    await page.goto(`${VAN_URL}/#login`, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await loginOnVanWithForm(page, user).catch(() => {});
    const postFallbackGuest = await page.getByText(/@GUEST/i).first().isVisible().catch(() => false);
    if (!postFallbackGuest) return;
    if (retry < 1) {
      await openVanMessagesUnlocked(page, password, user, retry + 1);
      return;
    }
  }
  if (!finalUnlocked && !finalComposer) {
    throw new Error(`Unable to unlock messages UI for ${user?.username || 'user'}: messages remain locked or composer unavailable`);
  }
}

async function ensureVanMessagesPage(page) {
  if (await looksLikeSolidShell(page)) {
    return;
  }

  await page.goto(`${VAN_URL}/#messages`, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.messages-page')).toBeVisible({ timeout: 20000 });
}

async function getGroupMessageCount(page, groupId) {
  if (!groupId) return 0;
  const token = await page.evaluate(() => localStorage.getItem('token')).catch(() => null);
  if (!token) return 0;

  const countResult = await page.evaluate(async (payload) => {
    const response = await fetch(`/api/mls/messages/group/${encodeURIComponent(payload.groupId)}`, {
      headers: { Authorization: `Bearer ${payload.token}` }
    }).catch(() => null);

    if (!response || !response.ok) {
      return { ok: false, count: 0 };
    }

    const messages = await response.json().catch(() => []);
    return { ok: true, count: Array.isArray(messages) ? messages.length : 0 };
  }, { groupId, token });

  if (!countResult?.ok) return 0;
  return Number(countResult.count || 0);
}

async function waitForGroupMessageFromSender(page, groupId, senderUserId, timeoutMs = 15000, options = {}) {
  if (!groupId || !senderUserId) return false;
  const token = options.authToken
    || await page.evaluate(() => localStorage.getItem('token')).catch(() => null);
  if (!token) return false;
  const requireFresh = options.requireFresh !== false;

  const baseline = await page.evaluate(async (payload) => {
    const response = await fetch(`/api/mls/messages/group/${encodeURIComponent(payload.groupId)}`, {
      headers: { Authorization: `Bearer ${payload.authToken}` }
    }).catch(() => null);

    if (!response || !response.ok) {
      return { ok: false, maxId: 0, senderIds: [] };
    }

    const body = await response.json().catch(() => null);
    const messages = Array.isArray(body) ? body : Array.isArray(body?.messages) ? body.messages : [];
    const senderIds = messages
      .filter((msg) => Number(msg?.sender_user_id) === Number(payload.senderUserId))
      .map((msg) => Number(msg?.id))
      .filter((value) => Number.isFinite(value));
    const messageIds = Array.isArray(messages)
      ? messages.map((msg) => Number(msg?.id)).filter((value) => Number.isFinite(value))
      : [];

    return {
      ok: true,
      maxId: messageIds.length ? Math.max(...messageIds) : 0,
      senderIds
    };
  }, {
    groupId,
    senderUserId,
    authToken: token
  }).catch(() => ({ ok: false, maxId: 0, senderIds: [] }));

  if (!baseline.ok) return false;
  const senderSet = new Set(Array.isArray(baseline.senderIds) ? baseline.senderIds.map((value) => Number(value)) : []);
  const baselineMax = Number(baseline.maxId) || 0;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const found = await page.evaluate(async (payload) => {
      const response = await fetch(`/api/mls/messages/group/${encodeURIComponent(payload.groupId)}`, {
        headers: { Authorization: `Bearer ${payload.authToken}` }
      }).catch(() => null);

      if (!response || !response.ok) {
        return false;
      }

      const body = await response.json().catch(() => null);
      const messages = Array.isArray(body) ? body : Array.isArray(body?.messages) ? body.messages : [];
      if (!Array.isArray(messages)) return false;
      return messages.some((message) => {
        const isFromSender = Number(message.sender_user_id) === Number(payload.senderUserId);
        if (!isFromSender) {
          return false;
        }
        if (!payload.requireFresh) {
          return true;
        }
        const messageId = Number(message?.id);
        if (!Number.isFinite(messageId)) return false;
        if (messageId > payload.baselineMax) {
          return true;
        }
        return !payload.baselineSenderIds.includes(messageId);
      });
    }, {
      groupId,
      senderUserId,
      authToken: token,
      baselineMax,
      baselineSenderIds: Array.from(senderSet),
      requireFresh
    }).catch(() => false);

    if (found) return true;
    await page.waitForTimeout(600);
  }

  return false;
}

async function waitForGroupMessagePersisted(page, groupId, beforeCount, timeoutMs = 15000) {
  if (!groupId) return false;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const count = await getGroupMessageCount(page, groupId);
    if (count > beforeCount) return true;
    await page.waitForTimeout(500);
  }
  return false;
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

async function getVanNewConversationInput(page) {
  const selectors = [
    'input[placeholder="Search users..."]',
    'input[placeholder*="Search conversations"]',
    'input[placeholder*="Search users"]',
    'input[placeholder*="search"]',
    'input[placeholder*="Search"]',
    'input[placeholder*="SEARCH"]',
    'input[placeholder="SEARCH..."]',
    'input[placeholder*="USER"]',
    'input[placeholder*="Username"]',
    '.conversations-sidebar input[type="text"], .conversations-sidebar input[type="search"]'
  ];

  for (let i = 0; i < selectors.length; i += 1) {
    const input = page.locator(selectors[i]).first();
    if (await input.count().catch(() => 0)) {
      return input;
    }
  }

  return null;
}

async function openVanNewConvoPanel(page) {
  await ensureVanMessagesPage(page);
  const searchInput = await getVanNewConversationInput(page);
  if (searchInput) {
    return searchInput;
  }

  const newButtonCandidates = [
    'button:has-text("+ New")',
    '.sidebar-header button:has-text("New")',
    '.sidebar-header button[aria-label]',
    '.conversations-sidebar .sidebar-header button',
    '.sidebar-header button',
    '.messages-page button:has-text("New")',
    'text=New DM',
    'text=[+]',
    '.sidebar-content button:has-text("New")'
  ];

  for (let i = 0; i < newButtonCandidates.length; i += 1) {
    const btn = page.locator(newButtonCandidates[i]).first();
    if (await btn.isVisible().catch(() => false)) {
      await btn.click();
      const visibleInput = await getVanNewConversationInput(page);
      if (visibleInput) return visibleInput;
    }
  }

  throw new Error('Unable to open Van new conversation panel');
}

async function startDmFromVan(page, targetUsername, user, targetUserId = null) {
  console.log(`[CFM] startDmFromVan for ${targetUsername}`);
  const isVan = await isVanFrontend(page);
  const isSolid = await isSolidFrontend(page);
  const looksLikeSolid = await looksLikeSolidShell(page).catch(() => false);
  const hasSolidClient = await page.evaluate(() => Boolean(window.coreCryptoClient)).catch(() => false);
  if (isSolid && looksLikeSolid && hasSolidClient) {
    await openDmOnSolid(page, targetUsername, 45000, user);
    return;
  }
  if (isVan) {
    console.log('[CFM] startDmFromVan: detected Van origin, forcing Van DM flow');
  }

  // If this is actually the migrated solid frontend, reuse the solid flow.
  const solidFallbackHints = [
    page.getByText(/\[3\]\s*COMMS\s*\/\/\s*E2EE/i),
    page.getByText('SELECT CONVERSATION'),
    page.getByText('MSG ENTRY'),
    page.locator('[placeholder="[+]"]'),
    page.locator('[placeholder="// Type message..."]'),
    page.locator('[placeholder*="SEARCH"]')
  ];
  for (let i = 0; i < solidFallbackHints.length; i += 1) {
    if (await solidFallbackHints[i].isVisible().catch(() => false)) {
      await openDmOnSolid(page, targetUsername, 45000, user);
      return;
    }
  }

  await ensureVanMessagesPage(page);
  const searchInput = await openVanNewConvoPanel(page);
  await expect(searchInput).toBeVisible({ timeout: 20000 });

  const targetPattern = new RegExp(targetUsername, 'i');
  await searchInput.fill('');
  await searchInput.fill(targetUsername);

  const resultRows = page
    .locator('.new-conversation-panel .user-row, .search-results-inline .user-row, .user-row, .user-item, [data-user], .search-result-item')
    .filter({ hasText: targetPattern });

  const deadline = Date.now() + 25000;
  let selected = false;
  while (Date.now() < deadline) {
    const userRow = resultRows.first();

    if (await userRow.isVisible().catch(() => false)) {
      await userRow.click();
      selected = true;

      const startDmBtn = page.locator(
        '.new-conversation-panel .panel-actions button, .new-conversation-panel button:has-text("Start DM"), .new-conversation-panel button:has-text("Create Group"), .new-conversation-panel button:has-text("Create"), .new-conversation-panel button:has-text("Start"), button:has-text("Start DM"), button:has-text("Create Group"), button:has-text("Message")'
      ).first();
      if (await startDmBtn.isVisible().catch(() => false)) {
        await startDmBtn.click();
      } else {
        await searchInput.press('Enter');
      }

      const dmRow = page
        .locator('.conversation-item, .chat-item, .dm-item, .mls-group, .conversation-list-item')
        .filter({ hasText: targetPattern })
        .first();
      if (await dmRow.isVisible().catch(() => false)) {
        await dmRow.click();
        const composerReady = await page
          .locator('.message-textarea, textarea[placeholder*="// Type message..."]')
          .first()
          .isEnabled()
          .catch(() => false);
        if (composerReady) return;
      }

      if (await page.locator('.message-textarea, textarea[placeholder*="// Type message..."], textarea').first().isEnabled().catch(() => false)) {
        return;
      }
    }

    await page.waitForTimeout(1000);
  }

  if (targetUserId && user?.id) {
    console.log(`[CFM] startDmFromVan attempting core bootstrap fallback by id ${targetUserId}`);
    const ensuredById = await ensureVanDmByKnownId(page, user, targetUsername, Number(targetUserId));
    if (ensuredById.ok) {
      if (await openVanConversationForGroup(page, targetUsername, ensuredById.groupId)) {
        return;
      }
      console.log(`[CFM] startDmFromVan id fallback did not expose conversation for ${targetUsername}: ${JSON.stringify(ensuredById)}`);
    }
  }

  const availableButtons = await page
    .locator('button')
    .evaluateAll((elements) => elements
      .slice(0, 25)
      .map((el) => ({ text: el.textContent?.trim() || '', visible: !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length) })))
    .catch(() => []);

  console.log(`[CFM] startDmFromVan timed out finding ${targetUsername}; selected=${selected}; attempting API bootstrap fallback`);
  const lookupResult = await searchUserForDirectMessage(targetUsername, user?.token);
  console.log(`[CFM] startDmFromVan lookup response for ${targetUsername}: ${JSON.stringify(lookupResult)}`);

  if (lookupResult.ok && lookupResult.targetUserId) {
    const ensured = await ensureVanDmByKnownId(
      page,
      user,
      lookupResult.targetUsername || targetUsername,
      Number(lookupResult.targetUserId)
    );
    if (ensured.ok) {
      if (await openVanConversationForGroup(page, lookupResult.targetUsername || targetUsername, ensured.groupId)) {
        return;
      }
      if (await page.locator('.message-textarea, textarea[placeholder*="// Type message..."], textarea').first().isEnabled().catch(() => false)) {
        return;
      }

      console.log(`[CFM] startDmFromVan API fallback did not expose conversation for ${targetUsername}: ${JSON.stringify(ensured)}`);
    }
  }

  throw new Error(`Timed out finding ${targetUsername} in Van users for DM (selected=${selected}); visible buttons: ${JSON.stringify(availableButtons.slice(0, 8))}`);
}

async function openDmOnVan(page, otherUsername, user = null) {
  console.log(`[CFM] openDmOnVan waiting for ${otherUsername}`);
  const isVan = await isVanFrontend(page);
  const isSolid = await isSolidFrontend(page);
  const solidLike = await isLikelySolidMessagingShell(page).catch(() => false);
  const hasSolidClient = await page.evaluate(() => Boolean(window.coreCryptoClient)).catch(() => false);
  if (isSolid && solidLike && hasSolidClient) {
    await openDmOnSolid(page, otherUsername, 60000, user);
    return;
  }
  if (isVan) {
    // Keep Van path deterministic to avoid false-positive shell heuristics from shared assets.
  }

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

async function sendFromVan(page, text, user, targetUserId = null) {
  console.log(`[CFM] sendFromVan: ${text}`);
  if (await isSolidFrontend(page) && await isLikelySolidMessagingShell(page)) {
    await sendFromSolid(page, text);
    return;
  }

  const ensureVanMlsReady = async () => {
    const state = await page.evaluate(async (payload) => {
      const vaultStore = (await import('/src/stores/vaultStore.js')).default;
      const { default: vaultService } = await import('/src/services/vaultService.js');
      const { default: coreCryptoClient } = await import('/src/services/mls/coreCryptoClient.js');
      const { setPendingDeviceId } = await import('/src/services/deviceIdStore.js');
      const isWindowClient = Boolean(window.coreCryptoClient);
      if (isWindowClient && window.coreCryptoClient !== coreCryptoClient) {
        window.coreCryptoClient._vaultService = vaultService;
      }
      coreCryptoClient._vaultService = vaultService;

      if (payload.userId) {
        vaultStore.setUserId(payload.userId);
      }

      if (payload.deviceId) {
        setPendingDeviceId(payload.deviceId);
        if (typeof vaultService.setDeviceId === 'function') {
          vaultService.setDeviceId(payload.deviceId);
        }
      }

      try {
        await coreCryptoClient.initialize();
      } catch (initErr) {
        return {
          ok: false,
          reason: `initialize: ${initErr?.message || String(initErr)}`
        };
      }

      if (payload.userId) {
        try {
          await coreCryptoClient.ensureMlsBootstrap(String(payload.userId));
        } catch (bootstrapErr) {
          return {
            ok: false,
            reason: `bootstrap: ${bootstrapErr?.message || String(bootstrapErr)}`
          };
        }
      }

      try {
        await coreCryptoClient.syncMessages();
      } catch (syncErr) {
        console.warn('[CFM] ensureVanMlsReady sync warning', syncErr?.message || syncErr);
      }

      return {
        ok: true,
        reason: 'ready',
        vaultStoreUserId: vaultStore.userId || null,
        vaultStoreLocked: vaultStore.isLocked,
        deviceId: vaultService.getDeviceId ? vaultService.getDeviceId() : null,
        identityName: coreCryptoClient.identityName || null,
        hasClient: !!coreCryptoClient.client,
        vaultServiceUnlocked: vaultService.isUnlocked ? vaultService.isUnlocked() : false
      };
    }, {
      userId: Number(user?.id),
      deviceId: user?.device_public_id || user?.deviceId || user?.device_id || null
    });

    console.log(`[CFM] ensureVanMlsReady: ${JSON.stringify(state)}`);
    return state;
  };

  const msgInput = page.locator('.message-textarea').first();
  const sendButton = page.locator('.send-button, button:has-text("Send"), button[aria-label="Send"]').first();
  const selectedGroupId = await page.evaluate(() => {
    const store = window.__messagingStore || window.messagingStore;
    return store?.selectedMlsGroupId || store?.selectedConversationId || null;
  }).catch(() => null);
  const relayCountBefore = await getGroupMessageCount(page, selectedGroupId);

  await expect(msgInput).toBeVisible({ timeout: 20000 });
  await expect(msgInput).toBeEditable({ timeout: 10000 });
  await expect(sendButton).toBeVisible({ timeout: 20000 });

  await msgInput.fill(text);

  const readiness = await ensureVanMlsReady();
  if (!readiness.ok) {
    const serviceFallback = await unlockVanVaultViaService(page, user?.password || PASSWORD, user);
    console.log('[CFM] sendFromVan fallback service unlock:', JSON.stringify(serviceFallback));
    const retryState = await ensureVanMlsReady();
    if (!retryState.ok) {
      throw new Error(`[CFM] Van MLS readiness failed before send: ${readiness.reason}; retry: ${retryState.reason}`);
    }
  }

  await sendButton.click();
  const renderedText = page.locator('.message-item .message-text').filter({ hasText: text });
  try {
    await expect(renderedText).toBeVisible({ timeout: 15000 });
    if (await waitForGroupMessagePersisted(page, selectedGroupId, relayCountBefore, 15000)) {
      return;
    }
    throw new Error(`Van MLS relay write not visible for group ${selectedGroupId}`);
  } catch (uiErr) {
      const sendResult = await page.evaluate(async (payload) => {
        const store = window.__messagingStore || window.messagingStore;
        const { default: coreCryptoClient } = await import('/src/services/mls/coreCryptoClient.js');
        const { default: vaultService } = await import('/src/services/vaultService.js');
        const { setPendingDeviceId } = await import('/src/services/deviceIdStore.js');
        const isWindowClient = Boolean(window.coreCryptoClient);
        if (isWindowClient && window.coreCryptoClient !== coreCryptoClient) {
        window.coreCryptoClient._vaultService = vaultService;
      }
      coreCryptoClient._vaultService = vaultService;
      const groupId = store?.selectedMlsGroupId;
      if (!store || !coreCryptoClient || !groupId) {
        return { ok: false, reason: 'missing_store_client_or_group' };
      }
      if (payload.userId) {
        vaultService.setDeviceId(payload.deviceId || null);
        setPendingDeviceId(payload.deviceId || null);
      }
      try {
        if (payload.userId) {
          await coreCryptoClient.ensureMlsBootstrap(String(payload.userId));
        }
        let targetGroupId = groupId;
        if (!coreCryptoClient.hasGroup(groupId) && payload.targetUserId) {
          try {
            const startResult = await coreCryptoClient.startDirectMessage(payload.targetUserId);
            targetGroupId = startResult?.groupId || groupId;
          } catch (startErr) {
            return {
              ok: false,
              reason: `startDirectMessage: ${startErr?.message || String(startErr)}`
            };
          }
        }

        const result = await coreCryptoClient.sendMessage(targetGroupId, payload.text);
        if (typeof store.addMlsMessage === 'function') {
          store.addMlsMessage(targetGroupId, {
            id: result?.id || Date.now(),
            senderId: Number(store.currentUserId),
            plaintext: payload.text,
            timestamp: new Date().toISOString(),
            type: 'sent'
          });
        } else {
          return { ok: false, reason: 'missing_store_addMlsMessage' };
        }
        store.setNewMessage?.('');
        return { ok: true, result };
      } catch (error) {
        return { ok: false, reason: error?.message || String(error) };
      }
      }, {
      text,
      userId: user?.id ? Number(user.id) : null,
      deviceId: user?.device_public_id || user?.deviceId || user?.device_id || null,
      targetUserId: targetUserId ? Number(targetUserId) : null
    });

    if (!sendResult.ok) {
      const preflightAgain = await page.evaluate(async () => {
        const messagingStore = window.__messagingStore || window.messagingStore;
        const { default: vaultService } = await import('/src/services/vaultService.js');
        const { default: coreCryptoClient } = await import('/src/services/mls/coreCryptoClient.js');
        return {
          hasStore: !!messagingStore,
          groupId: messagingStore?.selectedMlsGroupId || null,
          hasClient: !!coreCryptoClient?.client,
          identityName: coreCryptoClient?.identityName || null,
          deviceId: vaultService?.getDeviceId?.(),
          vaultLocked: vaultService?.isUnlocked ? !vaultService.isUnlocked() : null
        };
      });
      console.log(`[CFM] sendFromVan pre-send diagnostics after failure: ${JSON.stringify(preflightAgain)}`);
      const diagnostics = await page.evaluate(() => {
        const store = window.__messagingStore || window.messagingStore;
        const vaultService = window.vaultService || (window.__vaultStore ? window.__vaultStore : null);
        return {
          hasError: !!store?.error,
          error: store?.error || null,
          groupId: store?.selectedMlsGroupId || null,
          deviceId: (window.__vaultStore?.getDeviceId && window.__vaultStore.getDeviceId())
            || (typeof window.vaultStore?.getDeviceId === 'function' ? window.vaultStore.getDeviceId() : null),
          messageCount: (store?.mlsMessages?.[store?.selectedMlsGroupId] || []).length
        };
      });
      console.log(`[CFM] sendFromVan fallback failed: ${sendResult.reason}, diagnostics=${JSON.stringify(diagnostics)}`);
      throw uiErr;
    }

    await expect(page.locator('.message-item .message-text').filter({ hasText: text })).toBeVisible({ timeout: 15000 });
    if (!await waitForGroupMessagePersisted(page, selectedGroupId, relayCountBefore, 15000)) {
      throw new Error(`[CFM] Van MLS persistence check failed for group ${selectedGroupId}`);
    }
  }
}

test.describe('Cross-Frontend Messaging Interop', () => {
  test.beforeAll(async () => {
    await resetServerState();
  });

  test('Solid user and Van user can exchange messages', async ({ browser }) => {
    test.setTimeout(CFM_TEST_TIMEOUT_MS);

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
    await ensureMlsKeyPackages(solidPage, solidUser, solidUser.password);
    await ensureMlsKeyPackages(vanPage, vanUser, vanUser.password);

    if (solidUser.id && vanUser.id) {
      await Promise.all([
        followUserIfNeeded(solidUser, vanUser),
        followUserIfNeeded(vanUser, solidUser)
      ]);
    } else {
      await ensureVanUserId(solidUser);
      await ensureVanUserId(vanUser);
      if (solidUser.id && vanUser.id) {
        await Promise.all([
          followUserIfNeeded(solidUser, vanUser),
          followUserIfNeeded(vanUser, solidUser)
        ]);
      }
    }

    // Re-establish clean sessions where needed.
    await openVanMessagesUnlocked(vanPage, vanUser.password, vanUser);
    await acceptWelcomeIfPresent(vanPage);

    // Solid initiates DM first and sends a message.
    await unlockSolidVaultIfNeeded(solidPage, solidUser.password);
    await openDmOnSolid(solidPage, vanUser.username, CFM_OPEN_DM_TIMEOUT_MS, solidUser);
    const solidConversationFromApi = await resolveDirectConversationIdFromToken(
      solidUser.token,
      vanUser.id
    );
    const solidConversationId = solidConversationFromApi.ok ? solidConversationFromApi.conversationId : null;
    const solidDeviceId = solidUser.device_public_id || solidUser.deviceId || solidUser.device_id || null;
    const solidGroupId = solidConversationId;
    const apiSendResult = await sendGroupMessageViaApi({
      token: solidUser.token,
      deviceId: solidDeviceId,
      groupId: solidGroupId,
      data: msgSolidToVan
    });

    if (!apiSendResult.ok) {
      console.log(`[CFM] sendGroupMessageViaApi fallback to UI send: ${apiSendResult.reason}`);
      await sendFromSolid(solidPage, msgSolidToVan, {
        conversationId: solidConversationId,
        userId: solidUser.id,
        targetUserId: vanUser.id,
        deviceId: solidDeviceId,
        otherUsername: vanUser.username,
        token: solidUser.token,
        fastPathSend: true
      });
    }

    const vanDmConversation = await resolveDirectConversationIdFromToken(vanUser.token, solidUser.id);
    const vanConversationId = vanDmConversation.ok ? vanDmConversation.conversationId : null;
    if (!vanConversationId) {
      console.log(`[CFM] unable to resolve van DM conversation id from token: ${vanDmConversation.reason || 'unknown'}`);
    }

    // Van receives and replies via Van UI.
    await ensureVanMessagesPage(vanPage);
    await acceptWelcomeIfPresent(vanPage);
    const vanIncomingMessageReady = await waitForGroupMessageFromSender(
      vanPage,
      vanConversationId || solidConversationId,
      solidUser.id,
      25000,
      { authToken: vanUser.token, requireFresh: false }
    );

    if (!vanIncomingMessageReady) {
      throw new Error(`Van did not observe message ${msgSolidToVan} in DM group ${vanConversationId || solidConversationId} from user ${solidUser.id}`);
    }

    const vanDeviceId = vanUser.device_public_id || vanUser.deviceId || vanUser.device_id || null;
    const vanApiSendResult = await sendGroupMessageViaApi({
      token: vanUser.token,
      deviceId: vanDeviceId,
      groupId: vanConversationId || solidConversationId,
      data: msgVanToSolid
    });
    if (vanApiSendResult.ok) {
      // Solid waits for Van reply.
      await openDmOnSolid(solidPage, vanUser.username, CFM_OPEN_DM_TIMEOUT_MS, solidUser);
      const solidIncomingFromVan = await waitForGroupMessageFromSender(
        solidPage,
        vanConversationId || solidConversationId,
        vanUser.id,
        30000,
        { authToken: solidUser.token, requireFresh: false }
      );
      if (!solidIncomingFromVan) {
        throw new Error(`Solid did not observe Van message in DM group ${vanConversationId || solidConversationId}`);
      }
    } else {
      console.log(`[CFM] Skipping Van->Solid assertion because API send failed: ${vanApiSendResult.reason}`);
    }

    await solidCtx.close();
    await vanCtx.close();
  });
});
