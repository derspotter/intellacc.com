const { test, expect } = require('@playwright/test');
const token = (id) => `e30.${Buffer.from(JSON.stringify({ userId: id, exp: 9999999999 })).toString('base64url')}.test`;
const metadata = (id, status = 'complete', title = 'Linked market') => ({
  post_id: id, status: { processing_status: status },
  link: id === 1 && status === 'complete'
    ? { event_id: 90, title, confirmed: true, match_method: 'manual', market_prob: 0.6 } : null,
  markets: [], signal: { episode_count: 0 }
});
test('critiques render without a market and treat model output as text', async ({ page }) => {
  const description = '<img src=x onerror=alert(1)> Explain why this sample represents the electorate.';
  await page.route('**/api/**', (route) => {
    if (!route.request().url().endsWith('/posts/metadata')) return route.fulfill({ json: {} });
    return route.fulfill({ json: { posts: route.request().postDataJSON().post_ids.map((id) => ({
      ...metadata(id), link: null, critiques: id === 2 ? [{ id: 10,
        critique_type: 'unsupported_assumption', description, severity: 'warning' }] : []
    })) } });
  });
  await page.goto('/test/post-metadata.html');
  const summary = page.getByText('AI critique · 1', { exact: true });
  await expect(summary).toHaveCount(1);
  await expect(page.getByText(description, { exact: true })).toBeHidden();
  await summary.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByText(description, { exact: true })).toBeVisible();
  await expect(page.locator('.post-ai-critiques img')).toHaveCount(0);
  await expect(page.getByText('Unsupported assumption', { exact: true })).toBeVisible();
  await page.evaluate(() => window.setAccount(null));
  await expect(summary).toHaveCount(0);
});

test('Jev link arrives during reasoning and critiques arrive on completion', async ({ page }) => {
  let stage = 'retrieving';
  let polls = 0;
  await page.route('**/api/**', (route) => {
    if (!route.request().url().endsWith('/posts/metadata')) return route.fulfill({ json: {} });
    const body = route.request().postDataJSON();
    if (body.status_only) { polls++; stage = polls === 1 ? 'reasoning' : 'complete'; }
    return route.fulfill({ json: { posts: body.post_ids.map((id) => id !== 1 ? metadata(id) : body.status_only
      ? { post_id: id, status: { processing_status: stage } }
      : { ...metadata(id, stage), link: stage === 'retrieving' ? null : metadata(id).link,
        critiques: stage === 'complete' ? [{ id: 10, critique_type: 'logical_leap', description: 'Explain the causal step.' }] : [] }
    ) } });
  });
  await page.goto('/test/post-metadata.html');
  await expect(page.getByText('AI is matching markets...', { exact: true })).toHaveCount(1);
  await expect(page.getByText('Linked market', { exact: true })).toBeVisible({ timeout: 10000 });
  await expect(page.getByText('AI is reviewing the argument...', { exact: true })).toBeVisible();
  await expect(page.getByText('AI critique · 1', { exact: true })).toBeVisible({ timeout: 10000 });
  await expect(page.getByText('AI is reviewing the argument...', { exact: true })).toHaveCount(0);
  expect(polls).toBe(2);
});
test.beforeEach(async ({ page }) => {
  await page.addInitScript((value) => localStorage.setItem('token', value), token(42));
});

test('twenty posts share one metadata request; only pending posts poll and refresh once', async ({ page }) => {
  const batches = [];
  const legacy = [];
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/posts/metadata') {
      const body = route.request().postDataJSON();
      batches.push(body);
      const initial = batches.length === 1;
      return route.fulfill({ json: { posts: body.post_ids.map((id) => body.status_only
        ? { post_id: id, status: { processing_status: 'complete' } }
        : metadata(id, initial && id <= 2 ? 'reasoning' : 'complete')) } });
    }
    if (/\/(markets|market-link|analysis-status|signal-summary)$/.test(url.pathname)) legacy.push(url.pathname);
    return route.fulfill({ json: {} });
  });
  await page.goto('/test/post-metadata.html');
  await expect(page.getByText('AI is matching markets...', { exact: true })).toHaveCount(2);
  expect(batches).toHaveLength(1);
  expect(batches[0].post_ids).toHaveLength(20);
  await expect(page.getByText('Linked market', { exact: true })).toBeVisible({ timeout: 10000 });
  expect(batches).toHaveLength(3);
  expect(batches[1]).toEqual({ post_ids: [1, 2], status_only: true });
  expect(batches[2]).toEqual({ post_ids: [1, 2], status_only: false });
  await page.waitForTimeout(5500);
  expect(batches).toHaveLength(3);
  expect(legacy).toEqual([]);
});

test('manual detach refreshes only its post and preserves other metadata', async ({ page }) => {
  const batches = [];
  let detached = false;
  await page.route('**/api/**', (route) => {
    if (route.request().method() === 'DELETE') detached = true;
    if (route.request().url().endsWith('/posts/metadata')) {
      const body = route.request().postDataJSON();
      batches.push(body);
      return route.fulfill({ json: { posts: body.post_ids.map((id) => ({ ...metadata(id), ...(detached ? { link: null } : {}) })) } });
    }
    return route.fulfill({ json: {} });
  });
  await page.goto('/test/post-metadata.html');
  await page.getByTitle('Detach this market').click();
  await expect(page.getByText('Linked market', { exact: true })).toHaveCount(0);
  expect(batches).toHaveLength(2);
  expect(batches[1].post_ids).toEqual([1]);
});

test('unmounting stops pending polls', async ({ page }) => {
  let count = 0;
  await page.route('**/api/**', (route) => {
    if (!route.request().url().endsWith('/posts/metadata')) return route.fulfill({ json: {} });
    count++;
    return route.fulfill({ json: { posts: route.request().postDataJSON().post_ids.map((id) => metadata(id, 'pending')) } });
  });
  await page.goto('/test/post-metadata.html');
  await expect(page.getByText('AI is matching markets...', { exact: true })).toHaveCount(20);
  await page.evaluate(() => window.unmountPosts());
  await page.waitForTimeout(5500);
  expect(count).toBe(1);
});

test('an old account response cannot populate the new account or survive logout', async ({ page }) => {
  let oldRoute;
  await page.route('**/api/**', (route) => {
    if (!route.request().url().endsWith('/posts/metadata')) return route.fulfill({ json: {} });
    if (route.request().headers().authorization === `Bearer ${token(42)}`) { oldRoute = route; return; }
    return route.fulfill({ json: { posts: route.request().postDataJSON().post_ids.map((id) => metadata(id, 'complete', 'New account market')) } });
  });
  await page.goto('/test/post-metadata.html');
  await expect.poll(() => !!oldRoute).toBe(true);
  await page.evaluate((value) => window.setAccount(value), token(43));
  await expect(page.getByText('New account market', { exact: true })).toBeVisible();
  await oldRoute.fulfill({ json: { posts: Array.from({ length: 20 }, (_, i) => metadata(i + 1, 'complete', 'Old account market')) } });
  await page.waitForTimeout(100);
  await expect(page.getByText('Old account market', { exact: true })).toHaveCount(0);
  await page.evaluate(() => window.setAccount(null));
  await expect(page.getByText('New account market', { exact: true })).toHaveCount(0);
});

for (const status of [403, 500]) {
  test(`metadata errors have bounded retries (${status})`, async ({ page }) => {
    await page.clock.install();
    let count = 0;
    await page.route('**/api/**', (route) => {
      if (!route.request().url().endsWith('/posts/metadata')) return route.fulfill({ json: {} });
      count++;
      return route.fulfill({ status, json: { message: 'Test failure' } });
    });
    await page.goto('/test/post-metadata.html');
    await expect.poll(() => count).toBe(1);
    // Let each response settle before moving the mocked browser clock.
    await page.waitForTimeout(100);
    if (status === 500) {
      for (const [seconds, expected] of [[6, 2], [11, 3], [21, 4]]) {
        await page.clock.fastForward(seconds * 1000);
        await expect.poll(() => count).toBe(expected);
        await page.waitForTimeout(100);
      }
    }
    await page.clock.fastForward(120000);
    await page.waitForTimeout(100);
    expect(count).toBe(status === 500 ? 4 : 1);
  });
}
