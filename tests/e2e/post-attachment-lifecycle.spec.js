// Isolated component + mocked API. No users, uploads or production writes.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const pixel = fs.readFileSync(path.join(__dirname, 'fixtures/pixel.png'));

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.attachmentUrls = { created: [], revoked: [] };
    const create = URL.createObjectURL.bind(URL);
    const revoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = (blob) => {
      const url = create(blob);
      window.attachmentUrls.created.push(url);
      return url;
    };
    URL.revokeObjectURL = (url) => {
      window.attachmentUrls.revoked.push(url);
      revoke(url);
    };
  });
});

const expectLoadedImage = async (page) => {
  await expect(page.getByAltText('Post image')).toBeVisible();
  await expect.poll(() => page.getByAltText('Post image').evaluate(
    (img) => img.complete && img.naturalWidth > 0
  )).toBe(true);
};

test('one download per attachment ID, with URL cleanup on replacement and unmount', async ({ page }) => {
  const requests = [];
  await page.route('**/api/**', (route) => {
    requests.push(new URL(route.request().url()).pathname);
    return route.fulfill({ contentType: 'image/png', body: pixel });
  });
  await page.goto('/test/post-attachment.html');
  await expectLoadedImage(page);
  await page.evaluate(() => window.updatePost({ content: 'Updated text only', like_count: 2 }));
  await expect(page.getByText('Updated text only')).toBeVisible();
  // Allow several response/effect cycles: a self-triggering effect fails this.
  await page.waitForTimeout(250);
  expect(requests).toEqual(['/api/attachments/1']);
  expect(await page.evaluate(() => window.attachmentUrls.revoked)).toEqual([]);

  await page.evaluate(() => window.updatePost({ image_attachment_id: 2 }));
  await expectLoadedImage(page);
  expect(requests).toEqual(['/api/attachments/1', '/api/attachments/2']);
  let urls = await page.evaluate(() => window.attachmentUrls);
  expect(urls.created).toHaveLength(2);
  expect(urls.revoked).toEqual([urls.created[0]]);
  await page.evaluate(() => window.unmountPost());
  urls = await page.evaluate(() => window.attachmentUrls);
  expect(urls.revoked).toEqual(urls.created);
});

test('a stale download cannot overwrite a newer image or create a leaked URL', async ({ page }) => {
  let staleRequest;
  await page.route('**/api/**', async (route) => {
    if (route.request().url().endsWith('/attachments/1')) {
      staleRequest = route;
      return;
    }
    await route.fulfill({ contentType: 'image/png', body: pixel });
  });
  await page.goto('/test/post-attachment.html');
  await expect.poll(() => Boolean(staleRequest)).toBe(true);
  await page.evaluate(() => window.updatePost({ image_attachment_id: 2 }));
  await expectLoadedImage(page);
  const currentUrl = await page.getByAltText('Post image').getAttribute('src');
  await staleRequest.fulfill({ contentType: 'image/png', body: pixel }).catch(() => {});
  await page.waitForTimeout(100);
  await expect(page.getByAltText('Post image')).toHaveAttribute('src', currentUrl);
  expect(await page.evaluate(() => window.attachmentUrls)).toEqual({ created: [currentUrl], revoked: [] });
  await page.evaluate(() => window.updatePost({ image_attachment_id: null }));
  await expect(page.getByAltText('Post image')).toHaveCount(0);
  expect(await page.evaluate(() => window.attachmentUrls.revoked)).toEqual([currentUrl]);
});

test('unmount cancels a pending download without allocating an object URL', async ({ page }) => {
  let pendingRequest;
  await page.route('**/api/**', (route) => { pendingRequest = route; });
  await page.goto('/test/post-attachment.html');
  await expect.poll(() => Boolean(pendingRequest)).toBe(true);
  const failed = page.waitForEvent('requestfailed', (req) => req.url().endsWith('/attachments/1'));
  await page.evaluate(() => window.unmountPost());
  await failed;
  await pendingRequest.fulfill({ contentType: 'image/png', body: pixel }).catch(() => {});
  expect(await page.evaluate(() => window.attachmentUrls)).toEqual({ created: [], revoked: [] });
});
