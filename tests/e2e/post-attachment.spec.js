const { test, expect } = require('@playwright/test');
const path = require('path');

const USER = { email: 'user1@example.com', password: 'password123' };

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

  // If device linking modal blocks clicks, cancel it (skip messaging setup)
  const deviceModal = page.locator('.device-link-modal');
  if (await deviceModal.isVisible({ timeout: 2000 }).catch(() => false)) {
    await deviceModal.getByRole('button', { name: 'Cancel' }).click();
    await expect(deviceModal).toBeHidden({ timeout: 5000 });
  }
}

test('User can create a post with an image attachment', async ({ page }) => {
  await loginUser(page, USER);

  const filePath = path.resolve(__dirname, 'fixtures/pixel.png');
  const textarea = page.getByPlaceholder("What's on your mind?");
  const fileInput = page.locator('input[type="file"]');

  const postText = `Attachment post ${Date.now()}`;
  await textarea.fill(postText);
  await fileInput.setInputFiles(filePath);
  await page.getByRole('button', { name: 'POST' }).click();

  const postCard = page.locator('.post-card').filter({ hasText: postText }).first();
  await expect(postCard).toBeVisible({ timeout: 15000 });

  const img = postCard.locator('img');
  const src = await img.getAttribute('src');
  expect(src).toBeTruthy();
  expect(src.startsWith('blob:')).toBeTruthy();
});
