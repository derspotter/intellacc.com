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

  // If device linking modal blocks clicks, cancel it (skip messaging setup)
  const deviceModal = page.locator('.device-link-modal');
  if (await deviceModal.isVisible({ timeout: 2000 }).catch(() => false)) {
    await deviceModal.getByRole('button', { name: 'Cancel' }).click();
    await expect(deviceModal).toBeHidden({ timeout: 5000 });
  }
}

test('User can create a post with an image attachment', async ({ page }) => {
  await resetServerState();

  await loginUser(page, USER);

  const filePath = path.resolve(__dirname, 'fixtures/pixel.png');
  const textarea = page.getByPlaceholder("What's on your mind?");
  const fileInput = page.locator('input[type="file"]');

  const postText = `Attachment post ${Date.now()}`;
  await textarea.fill(postText);
  await fileInput.setInputFiles(filePath);
  const createPost = page.waitForResponse(async (response) => {
    const request = response.request();
    return request.method() === 'POST' &&
      response.url().includes('/api/posts');
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
  const src = await img.getAttribute('src');
  expect(src).toBeTruthy();
  expect(src.startsWith('blob:')).toBeTruthy();
});
