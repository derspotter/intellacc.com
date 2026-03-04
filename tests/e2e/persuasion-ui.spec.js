const { test, expect } = require('@playwright/test');

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

  // If device linking modal blocks clicks, cancel it
  const deviceModal = page.locator('.device-link-modal');
  if (await deviceModal.isVisible({ timeout: 2000 }).catch(() => false)) {
    await deviceModal.getByRole('button', { name: 'Cancel' }).click();
    await expect(deviceModal).toBeHidden({ timeout: 5000 });
  }
}

test('User can see and click market match chips on a post', async ({ page }) => {
  page.on('console', msg => console.log('PAGE LOG:', msg.text()));
  page.on('pageerror', err => console.error('PAGE ERROR:', err));

  await resetServerState();
  await loginUser(page, USER);

  const postText = `Prediction test ${Date.now()}: Artificial intelligence will achieve AGI before 2030.`;

  // 1. Intercept the GET markets endpoint to guarantee a match appears quickly
  await page.route('**/api/posts/*/markets', async (route) => {
    const json = {
      markets: [
        {
          event_id: 99999,
          title: "Will AGI be achieved before 2030?",
          market_prob: 0.75,
          match_score: 0.95
        }
      ]
    };
    await route.fulfill({ json });
  });

  // Mock analysis-status endpoint
  await page.route('**/api/posts/*/analysis-status', async (route) => {
    await route.fulfill({ json: { processing_status: 'complete', has_claim: true } });
  });

  // Mock market-link endpoint
  await page.route('**/api/posts/*/market-link', async (route) => {
    const json = {
      linked_market: {
        event_id: 99999,
        title: "Will AGI be achieved before 2030?",
        match_confidence: 0.95,
        stance: 'agrees'
      }
    };
    await route.fulfill({ json });
  });

  // 2. Listen for the attribution POST request
  const marketClickPromise = page.waitForResponse(response => 
    response.url().includes('/market-click') && response.request().method() === 'POST'
  );

  // 3. Create the post
  const textarea = page.getByPlaceholder("What's on your mind?");
  await textarea.fill(postText);
  await page.getByRole('button', { name: 'POST', exact: true }).click();

  // 4. Wait for post to render
  const postCard = page.locator('.post-card').filter({ hasText: postText });
  await expect(postCard.first()).toBeVisible({ timeout: 15000 });

  // 5. Verify the market chip is rendered with correct title and probability
  const marketChip = postCard.first().locator('.market-chip');
  await expect(marketChip).toBeVisible();
  await expect(marketChip).toContainText('Will AGI be achieved before 2030?');
  await expect(marketChip).toContainText('75%');

  // 6. Click the chip
  // We mock the click response as well just in case the backend complains about fake event_id
  await page.route('**/api/posts/*/market-click', async (route) => {
    await route.fulfill({ json: { success: true, click: { id: 1 } }, status: 201 });
  });

  await marketChip.click();

  // 7. Verify attribution API was called
  const clickRequest = await marketClickPromise;
  expect(clickRequest.ok()).toBeTruthy();

  // 8. Verify navigation occurred (hash should change to #market/99999)
  await expect(page).toHaveURL(/.*#market\/99999/);
});
