const { test, expect } = require('@playwright/test');
const path = require('path');
const jwt = require('jsonwebtoken');

const EMAIL_TOKEN_SECRET = process.env.EMAIL_TOKEN_SECRET || 'dev-email-secret-change-in-production';

async function registerAndVerifyUser(request) {
  const unique = Date.now();
  const user = {
    email: `imgtest_${unique}@example.com`,
    username: `imgtest_${unique}`,
    password: 'password123'
  };

  const registerRes = await request.post('/api/users/register', {
    data: {
      username: user.username,
      email: user.email,
      password: user.password
    }
  });
  expect(registerRes.ok()).toBeTruthy();
  const registerBody = await registerRes.json();
  const userId = registerBody?.user?.id;
  expect(userId).toBeTruthy();

  const token = jwt.sign(
    { userId, email: user.email, purpose: 'email_verify' },
    EMAIL_TOKEN_SECRET,
    { expiresIn: '24h' }
  );

  const verifyRes = await request.post('/api/auth/verify-email/confirm', {
    data: { token }
  });
  expect(verifyRes.ok()).toBeTruthy();

  return user;
}

async function loginUser(page, user) {
  await page.goto('/#login');
  await page.fill('#email', user.email);
  await page.getByRole('button', { name: 'Continue' }).click();

  const passwordInput = page.locator('#password');
  await expect(passwordInput).toBeVisible({ timeout: 15000 });
  await page.fill('#password', user.password);
  await page.getByRole('button', { name: 'Sign In' }).click();

  await expect(page.getByRole('button', { name: 'Logout' })).toBeVisible({ timeout: 15000 });
  await page.waitForFunction(() => window.__vaultStore?.userId, null, { timeout: 15000 });

  const deviceModal = page.locator('.device-link-modal');
  if (await deviceModal.isVisible({ timeout: 2000 }).catch(() => false)) {
    await deviceModal.getByRole('button', { name: 'Cancel' }).click();
    await expect(deviceModal).toBeHidden({ timeout: 5000 });
  }
}

test('Image upload renders without corrupt/truncated warnings', async ({ page, request }) => {
  const consoleMessages = [];
  const imageWarnings = [];

  page.on('console', (msg) => {
    const text = msg.text();
    consoleMessages.push(`${msg.type()}: ${text}`);
    if (text.toLowerCase().includes('image') && (text.toLowerCase().includes('corrupt') || text.toLowerCase().includes('truncated'))) {
      imageWarnings.push(text);
    }
  });

  const user = await registerAndVerifyUser(request);
  await loginUser(page, user);

  const filePath = path.resolve(__dirname, 'fixtures/pixel.png');
  const textarea = page.getByPlaceholder("What's on your mind?");
  const fileInput = page.locator('input[type="file"]');

  const postText = `Image console test ${Date.now()}`;
  await textarea.fill(postText);
  await fileInput.setInputFiles(filePath);
  await page.getByRole('button', { name: 'POST' }).click();

  const postCard = page.locator('.post-card').filter({ hasText: postText }).first();
  await expect(postCard).toBeVisible({ timeout: 15000 });

  const img = postCard.locator('img');
  await expect(img).toBeVisible({ timeout: 15000 });
  const imgHandle = await img.elementHandle();
  await page.waitForFunction((el) => el && el.complete && el.naturalWidth > 0, imgHandle);

  if (consoleMessages.length) {
    console.log('[Playwright console]');
    for (const line of consoleMessages) {
      console.log(line);
    }
  }

  expect(imageWarnings).toEqual([]);
});
