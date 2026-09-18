const { test, expect } = require('@playwright/test');

async function mockAi(page, { configured = true, failOnce = false } = {}) {
  const token = `e30.${Buffer.from(JSON.stringify({ userId: 42, exp: 9999999999 })).toString('base64url')}.test`;
  await page.addInitScript(t => localStorage.setItem('token', t), token);
  const calls = [];
  let settings = { available: true, configured, provider: 'openrouter', model: configured ? 'example/model' : '', keyHint: '…test', publicReplies: true };
  let conversations = [];
  const history = new Map();
  await page.route('**/api/**', async route => {
    const req = route.request();
    const url = new URL(req.url());
    const method = req.method();
    const body = req.postDataJSON();
    const json = (value, status = 200) => route.fulfill({ status, json: value });
    if (url.pathname.startsWith('/api/ai/')) calls.push({ path: url.pathname, method, body });
    if (url.pathname === '/api/ai/settings') {
      if (method === 'PUT') settings = { ...settings, ...body, configured: true, apiKey: undefined };
      if (method === 'DELETE') settings = { ...settings, configured: false, model: '' };
      return json(settings);
    }
    if (url.pathname === '/api/ai/test') return json({ ok: true });
    if (url.pathname === '/api/ai/conversations') {
      if (method === 'POST') {
        const conversation = { id: String(conversations.length + 1), title: body.postId ? `Post #${body.postId}` : 'Private AI chat', post_id: body.postId || null };
        conversations.unshift(conversation);
        history.set(conversation.id, []);
        return json({ conversation }, 201);
      }
      return json({ conversations });
    }
    const match = url.pathname.match(/^\/api\/ai\/conversations\/([^/]+)(\/messages)?$/);
    if (match) {
      const id = match[1];
      if (match[2]) {
        if (failOnce) { failOnce = false; return route.abort(); }
        const messages = [{ id: 1, role: 'user', content: body.message }, { id: 2, role: 'assistant', model: settings.model, content: 'Renewable electricity depends on deployment, grid capacity, and demand.' }];
        history.set(id, [...history.get(id), ...messages]);
        return json({ messages });
      }
      if (method === 'DELETE') { conversations = conversations.filter(c => c.id !== id); return json({ ok: true }); }
      return json({ conversation: conversations.find(c => c.id === id), messages: history.get(id) });
    }
    if (url.pathname === '/api/posts/metadata') return json({ posts: [] });
    if (url.pathname.includes('/comments')) return json([]);
    return json({});
  });
  return calls;
}

for (const terminal of [false, true]) {
  test(`post opens private bottom-right drawer and continues in Messages (${terminal ? 'terminal' : 'van'})`, async ({ page }) => {
    const calls = await mockAi(page);
    await page.goto(`/test/ai-assistant.html${terminal ? '?terminal' : ''}`);
    await page.getByRole('button', { name: 'Ask AI about this post' }).click();
    const drawer = page.getByRole('dialog', { name: 'AI assistant' });
    await expect(drawer).toBeVisible();
    await expect(drawer.getByText('Context: post #10')).toBeVisible();
    await expect(drawer.getByRole('textbox', { name: 'Message AI' })).toBeEnabled();
    const rect = await drawer.boundingBox();
    const viewport = page.viewportSize();
    expect(rect.x).toBeGreaterThan(viewport.width / 2);
    expect(viewport.height - rect.y - rect.height).toBeLessThan(40);
    await expect(drawer).toHaveCSS('border-radius', '0px');
    await drawer.getByRole('textbox', { name: 'Message AI' }).fill('What evidence matters?');
    await page.keyboard.press('Escape');
    await expect(drawer).not.toBeVisible();
    await expect(page.getByRole('button', { name: 'Ask AI about this post' })).toBeFocused();
    await page.getByRole('button', { name: 'Open private AI chat' }).click();
    await expect(drawer.getByRole('textbox', { name: 'Message AI' })).toHaveValue('What evidence matters?');
    await drawer.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(drawer.getByText('Renewable electricity depends on deployment, grid capacity, and demand.')).toBeVisible();
    await page.screenshot({ path: test.info().outputPath(`ai-drawer-${terminal ? 'terminal' : 'van'}.png`) });
    await drawer.getByRole('link', { name: 'Messages', exact: true }).click();
    await expect(drawer).not.toBeVisible();
    await expect(page.getByRole('log', { name: 'Private AI messages' })).toContainText('What evidence matters?');
    expect(calls.filter(c => c.path.endsWith('/messages') && c.method === 'POST')).toHaveLength(1);
    await page.getByRole('button', { name: 'Log out fixture' }).click();
    await expect(page.getByRole('button', { name: 'Open private AI chat' })).not.toBeVisible();
    await expect(page.getByText('What evidence matters?', { exact: true })).not.toBeVisible();
  });
}

test('mobile sheet stays inside viewport and retry reuses its request ID', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const calls = await mockAi(page, { failOnce: true });
  await page.goto('/test/ai-assistant.html');
  await page.getByRole('button', { name: 'Open private AI chat' }).click();
  const drawer = page.getByRole('dialog', { name: 'AI assistant' });
  const input = drawer.getByRole('textbox', { name: 'Message AI' });
  await expect(input).toBeEnabled();
  await input.fill('Explain energy forecasts');
  await drawer.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(drawer.getByRole('alert')).toBeVisible();
  await drawer.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(drawer.getByText('Renewable electricity depends on deployment, grid capacity, and demand.')).toBeVisible();
  const requests = calls.filter(c => c.path.endsWith('/messages'));
  expect(requests).toHaveLength(2);
  expect(requests[0].body.requestId).toBe(requests[1].body.requestId);
  const rect = await drawer.boundingBox();
  expect(rect.x).toBe(0);
  // Desktop Chromium reserves a 15px stable scrollbar gutter even at this
  // viewport. The sheet must fill the usable width without hiding controls.
  expect(rect.width).toBeGreaterThanOrEqual(375);
  expect(rect.x + rect.width).toBeLessThanOrEqual(390);
  expect(rect.y + rect.height).toBeLessThanOrEqual(845);
  await page.screenshot({ path: test.info().outputPath('ai-drawer-mobile.png') });
});

test('setup saves provider credentials without browser persistence and sends only after setup', async ({ page }) => {
  const calls = await mockAi(page, { configured: false });
  await page.goto('/test/ai-assistant.html');
  await page.getByRole('button', { name: 'Open private AI chat' }).click();
  await expect(page.getByRole('textbox', { name: 'Message AI' })).toBeDisabled();
  await page.getByRole('link', { name: 'Open AI settings' }).click();
  await page.getByLabel('Provider', { exact: true }).selectOption('anthropic');
  await page.getByLabel('Model ID', { exact: true }).fill('example-model');
  await page.getByLabel('API key', { exact: true }).fill('fake-test-only-key');
  await page.getByRole('button', { name: 'Save AI settings' }).click();
  await expect(page.getByText('AI settings saved.')).toBeVisible();
  await expect(page.getByLabel('API key', { exact: true })).toHaveValue('');
  const browserStorage = await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }));
  expect(browserStorage).not.toContain('fake-test-only-key');
  expect(calls.some(c => c.path.endsWith('/messages'))).toBe(false);
  await page.getByRole('button', { name: 'Test saved connection' }).click();
  await expect(page.getByText('Connection verified.')).toBeVisible();
  await page.getByRole('button', { name: 'Remove key', exact: true }).click();
  await page.getByRole('button', { name: 'Remove saved key', exact: true }).click();
  await expect(page.getByText('API key removed.')).toBeVisible();
});
