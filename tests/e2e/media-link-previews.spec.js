const { test, expect } = require('@playwright/test');

test.beforeEach(async ({ page }) => {
  await page.route('**/api/**', (route) => route.fulfill({ json: {} }));
  await page.route('https://i.ytimg.com/**', (route) => route.fulfill({ status: 404 }));
  await page.route('https://www.youtube-nocookie.com/**', (route) => route.fulfill({ body: '<html><body>Player fixture</body></html>', contentType: 'text/html' }));
  await page.route('https://player.vimeo.com/**', (route) => route.fulfill({ body: '<html><body>Vimeo fixture</body></html>', contentType: 'text/html' }));
});

for (const skin of ['van', 'terminal']) {
  test(`${skin}: legacy YouTube preview plays on click, survives updates, closes and resets on edit`, async ({ page }) => {
    let playerRequests = 0;
    page.on('request', (request) => { if (request.url().includes('youtube-nocookie.com/embed')) playerRequests++; });
    await page.goto(`/test/link-previews.html?skin=${skin}`);
    const card = page.getByTestId('link-preview');
    await expect(card).toBeVisible();
    await expect(card.locator('iframe')).toHaveCount(0);
    expect(playerRequests).toBe(0);
    await card.getByRole('button', { name: 'Play YouTube video' }).click();
    await expect(card.locator('iframe')).toHaveAttribute('src', 'https://www.youtube-nocookie.com/embed/ebac4NojRsI?autoplay=1&playsinline=1');
    await expect(card.locator('iframe')).toHaveAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
    await expect.poll(() => playerRequests).toBe(1);
    await page.evaluate(() => window.updatePost({ like_count: 2, link_meta_url: 'https://youtu.be/ebac4NojRsI?si=22t3dAYr9z37I63k', link_meta_title: 'Cybersocialism podcast' }));
    await expect(card.locator('strong')).toHaveText('Cybersocialism podcast');
    await expect(card.locator('iframe')).toBeVisible();
    expect(playerRequests).toBe(1);
    await card.getByRole('button', { name: 'Close player' }).click();
    await expect(card.locator('iframe')).toHaveCount(0);
    await card.getByRole('button', { name: 'Play Cybersocialism podcast' }).click();
    await page.evaluate(() => window.updatePost({ content: 'New video https://vimeo.com/12345' }));
    await expect(card.locator('iframe')).toHaveCount(0);
    await card.getByRole('button', { name: 'Play Vimeo video' }).click();
    await expect(card.locator('iframe')).toHaveAttribute('src', 'https://player.vimeo.com/video/12345?autoplay=1');
  });

  test(`${skin}: article metadata, safe fallback, reposts and narrow screens`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/test/link-previews.html?skin=${skin}`);
    await page.evaluate(() => window.updatePost({
      content: 'Read https://example.com/article. Also https://other.test/page',
      link_meta_url: 'https://example.com/article', link_meta_title: 'Cybersocialism article',
      link_meta_description: 'An article description', link_meta_image_url: 'javascript:alert(1)',
      reposted_post: { user_id: 22, username: 'Author', created_at: '2026-08-31', content: 'https://youtu.be/ebac4NojRsI' }
    }));
    const cards = page.getByTestId('link-preview');
    await expect(cards).toHaveCount(3);
    await expect(cards.nth(0)).toContainText('Cybersocialism article');
    await expect(cards.nth(0)).toContainText('An article description');
    await expect(cards.nth(0).locator('img')).toHaveCount(0);
    await expect(cards.nth(0).locator('.link-preview-details')).toHaveAttribute('href', 'https://example.com/article');
    await expect(cards.nth(1)).toContainText('other.test');
    await expect(cards.nth(2).getByRole('button', { name: 'Play YouTube video' })).toBeVisible();
    for (const card of await cards.all()) {
      const box = await card.boundingBox();
      expect(box.x + box.width).toBeLessThanOrEqual(390);
      expect(await card.evaluate((element) => getComputedStyle(element).borderRadius)).toBe('0px');
    }
    await page.screenshot({ path: `.playwright-test-results/link-previews-${skin}-mobile.png`, fullPage: true });
  });
}

test('direct media stays unloaded until play', async ({ page }) => {
  await page.goto('/test/link-previews.html');
  await page.evaluate(() => window.updatePost({ content: 'https://example.com/podcast.mp3 https://example.com/clip.mp4' }));
  await expect(page.locator('audio, video')).toHaveCount(0);
  await page.getByRole('button', { name: 'Play Audio recording' }).click();
  await expect(page.locator('audio')).toHaveAttribute('controls', '');
  await page.getByRole('button', { name: 'Play Video', exact: true }).click();
  await expect(page.locator('video')).toHaveAttribute('controls', '');
});
