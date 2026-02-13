const { test, expect } = require('@playwright/test');
const path = require('path');
const USER = { email: 'user1@example.com', password: 'password123' };

async function resetServerState() {
  const { exec } = require('child_process');
  return new Promise((resolve) => {
    exec('./tests/e2e/reset-test-users.sh', (error, stdout, stderr) => {
      if (error) {
        console.warn('Reset script warning:', stderr);
      }
      console.log('Server state reset:', stdout.includes('Reset complete'));
      resolve();
    });
  });
}

async function loginUser(page, user) {
  await page.goto('/#login');
  await page.fill('#email', user.email);
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
  await resetServerState();

  const consoleMessages = [];
  const imageWarnings = [];

  page.on('console', (msg) => {
    const text = msg.text();
    consoleMessages.push(`${msg.type()}: ${text}`);
    if (text.toLowerCase().includes('image') && (text.toLowerCase().includes('corrupt') || text.toLowerCase().includes('truncated'))) {
      imageWarnings.push(text);
    }
  });

  const user = USER;
  await loginUser(page, user);

  const filePath = path.resolve(__dirname, 'fixtures/pixel.png');
  const textarea = page.getByPlaceholder("What's on your mind?");
  const fileInput = page.locator('input[type="file"]');

  const postText = `Image console test ${Date.now()}`;
  await textarea.fill(postText);
  await fileInput.setInputFiles(filePath);

  const createPost = page.waitForResponse(async (response) => {
    const req = response.request();
    return req.method() === 'POST' && req.url().includes('/api/posts');
  });

  await page.getByRole('button', { name: 'POST' }).click();

  const createResponse = await createPost;
  expect(createResponse.ok()).toBeTruthy();
  const createdBody = await createResponse.json().catch(() => null);
  expect(createdBody).toBeTruthy();

  const postTextLocator = page.getByText(postText, { exact: false });
  await expect(postTextLocator).toBeVisible({ timeout: 15000 });

  const postCard = page.locator('.post-card').filter({ hasText: postText });
  await expect(postCard.first()).toBeVisible({ timeout: 15000 });

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
