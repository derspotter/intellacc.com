const { test, expect } = require('@playwright/test');

const VAN_URL = process.env.VAN_URL || 'http://127.0.0.1:5173';
const SOLID_URL = process.env.SOLID_URL || 'http://127.0.0.1:5174';
const PASSWORD = 'password123';

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

async function signupOnSolid(page, user) {
  await page.goto(`${SOLID_URL}/#login`);
  await page.getByRole('button', { name: 'Register here' }).click();

  await page.getByPlaceholder('Choose handle...').fill(user.username);
  await page.getByPlaceholder('Enter system address...').fill(user.email);
  await page.getByPlaceholder('Create access key...').fill(user.password);
  await page.getByRole('button', { name: /> REGISTER/ }).click();

  await expect(page.getByText(`[INTELLACC] USER: @${user.username}`)).toBeVisible({ timeout: 20000 });
}

async function signupOnVan(page, user) {
  await page.goto(`${VAN_URL}/#signup`);

  await page.locator('#username').fill(user.username);
  await page.locator('input#email').fill(user.email);
  await page.locator('#password').fill(user.password);
  await page.locator('#confirmPassword').fill(user.password);
  await page.getByRole('button', { name: 'Create Account' }).click();

  await expect(page.getByRole('button', { name: 'Logout' })).toBeVisible({ timeout: 20000 });
}

async function loginOnSolid(page, user) {
  await page.goto(`${SOLID_URL}/#login`);
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
