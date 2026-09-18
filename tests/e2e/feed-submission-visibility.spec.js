const { test, expect } = require('@playwright/test');

for (const [terminal, delayed] of [[false, false], [false, true], [true, false], [true, true]]) {
  test(`visible posts stay chronological (${terminal ? 'terminal' : 'van'}, delayed feed: ${delayed})`, async ({ page }) => {
    const token = `e30.${Buffer.from(JSON.stringify({ userId: 42, exp: 9999999999 })).toString('base64url')}.test`;
    await page.addInitScript(t => localStorage.setItem('token', t), token);
    let nextId = 10;
    let weightsRequested = false;
    let releaseFeed;
    const feedReady = new Promise(resolve => { releaseFeed = resolve; });
    await page.route('**/api/**', async route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/api/posts' && route.request().method() === 'POST') {
        return route.fulfill({ status: 201, json: {
          id: nextId++, user_id: 42, username: 'author',
          content: route.request().postDataJSON().content,
          created_at: new Date().toISOString(), link_metadata_id: null
        } });
      }
      if (url.pathname === '/api/feed') {
        if (delayed) await feedReady;
        return route.fulfill({ json: {
        items: [{ id: 2, user_id: 9, username: 'newcomer', content: 'Recent article without engagement',
          created_at: '2026-04-01T00:00:00Z', like_count: 0, view_count: 0, author_followers: 0 },
          { id: 1, user_id: 7, username: 'popular', content: 'Older popular article',
          like_count: 20, view_count: 100, author_accuracy: 90, author_followers: 200,
          created_at: '2026-01-01T00:00:00Z' }], hasMore: false
        } });
      }
      if (url.pathname.endsWith('/feed-weights')) {
        weightsRequested = true;
        return route.fulfill({ json: { weights: { accuracy: 25, followers: 25, likes: 25, views: 25 } } });
      }
      if (url.pathname === '/api/posts/metadata') return route.fulfill({ json: { posts: [] } });
      return route.fulfill({ json: {} });
    });
    await page.goto(`/test/feed-submission.html${terminal ? '?terminal' : ''}`);
    if (!delayed) await expect(page.getByText('Older popular article', { exact: true })).toBeVisible();
    const input = terminal ? page.getByPlaceholder('TRANSMIT TO FEED...') : page.locator('#solid-post-content');
    const submit = page.getByRole('button', { name: terminal ? 'SUBMIT' : 'Post', exact: true });
    for (const text of ['First article https://example.com/one', 'Second article https://example.com/two']) {
      await input.fill(text);
      await submit.click();
      await expect(input).toHaveValue('');
      releaseFeed();
      await expect(page.getByText('Older popular article', { exact: true })).toBeVisible();
      await expect(page.getByText(text, { exact: false }).first()).toBeVisible();
    }
    // Engagement and author signals cannot move older visible posts above newer ones.
    const ordered = await page.locator('body').innerText();
    expect(ordered.indexOf('Second article')).toBeLessThan(ordered.indexOf('First article'));
    expect(ordered.indexOf('First article')).toBeLessThan(ordered.indexOf('Older popular article'));
    expect(ordered.indexOf('Recent article without engagement')).toBeLessThan(ordered.indexOf('Older popular article'));
    expect(weightsRequested).toBe(false);
    await page.screenshot({ path: test.info().outputPath('new-post-visible.png'), fullPage: true });
  });
}
