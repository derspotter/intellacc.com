const { test, expect } = require('@playwright/test');

const USER = { email: 'user1@example.com', password: 'password123' };

async function resetServerState() {
  const { exec } = require('child_process');
  return new Promise((resolve) => {
    exec('./tests/e2e/reset-test-users.sh', (error, stdout, stderr) => {
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
  
  const deviceModal = page.locator('.device-link-modal');
  if (await deviceModal.isVisible({ timeout: 2000 }).catch(() => false)) {
    await deviceModal.getByRole('button', { name: 'Cancel' }).click();
  }
}

test('User can post a link and see the generated preview card', async ({ page }) => {
  await resetServerState();
  await loginUser(page, USER);

  const postText = `Check out the latest tech news: https://news.ycombinator.com/ ${Date.now()}`;

  // Create the post
  const textarea = page.getByPlaceholder("What's on your mind?");
  await textarea.fill(postText);
  await page.getByRole('button', { name: 'POST', exact: true }).click();

  // Wait for post to render
  const postCard = page.locator('.post-card').filter({ hasText: postText });
  await expect(postCard.first()).toBeVisible({ timeout: 15000 });

  // Verify the link is rendered as an actual clickable anchor tag
  const link = postCard.first().locator('a[href="https://news.ycombinator.com/"]');
  await expect(link).toBeVisible({ timeout: 15000 });
});
