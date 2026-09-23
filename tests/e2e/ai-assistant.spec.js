const { test, expect } = require('@playwright/test');

async function mockAi(page, { configured = true, failOnce = false, assistantText = 'Renewable electricity depends on deployment, grid capacity, and demand.' } = {}) {
  const token = `e30.${Buffer.from(JSON.stringify({ userId: 42, exp: 9999999999 })).toString('base64url')}.test`;
  await page.addInitScript(t => localStorage.setItem('token', t), token);
  const calls = [];
  let settings = { available: true, configured, provider: 'openrouter', model: configured ? 'example/model' : '', keyHint: '…test', publicReplies: true };
  let critiqueModel = '';
  let critiquesEnabled = false;
  let conversations = [];
  const history = new Map();
  await page.route('**/api/**', async route => {
    const req = route.request();
    const url = new URL(req.url());
    const method = req.method();
    const body = req.postDataJSON();
    const json = (value, status = 200) => route.fulfill({ status, json: value });
    if (url.pathname.startsWith('/api/ai/')) calls.push({ path: url.pathname, method, body });
    if (url.pathname === '/api/ai/critique-settings') {
      if (method === 'PUT') { critiqueModel = body.model; critiquesEnabled = body.enabled; }
      return json({ model: critiqueModel, enabled: critiquesEnabled, configured: settings.configured, provider: settings.provider });
    }
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
        const messages = [{ id: 1, role: 'user', content: body.message }, { id: 2, role: 'assistant', model: settings.model, content: assistantText }];
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
  test(`AI Markdown renders in the drawer and saved Messages history (${terminal ? 'terminal mobile' : 'van'})`, async ({ page }) => {
    if (terminal) await page.setViewportSize({ width: 390, height: 844 });
    const assistantText = [
      '## Critique of @der\\_spotter', '', '**Scope:** Only the supplied text.', '',
      '### Substantive observations', '', '1. **Evidence:** Explain the uncertainty.', '2. A *personal forecast* is not certainty.', '',
      '- Include sources.', '- Consider alternatives.', '', '> A useful qualification.', '',
      '[Source](https://example.com/article)', '', '`inline code`', '',
      '```js', 'const value = "<strong>literal</strong>";', '```', '',
      '| Claim | Evidence |', '| --- | --- |', '| Forecast | Limited |'
    ].join('\n');
    const calls = await mockAi(page, { assistantText });
    await page.goto(`/test/ai-assistant.html${terminal ? '?terminal' : ''}`);
    await page.getByRole('button', { name: 'Ask AI about this post' }).click();
    const drawer = page.getByRole('dialog', { name: 'AI assistant' });
    await drawer.getByRole('textbox', { name: 'Message AI' }).fill('Please critique this.');
    await drawer.getByRole('button', { name: 'Send', exact: true }).click();
    const reply = drawer.locator('.ai-markdown');
    await expect(reply.getByRole('heading', { level: 2, name: 'Critique of @der_spotter' })).toBeVisible();
    await expect(reply.locator('strong').first()).toHaveText('Scope:');
    await expect(reply.locator('ol > li')).toHaveCount(2);
    await expect(reply.locator('ul > li')).toHaveCount(2);
    await expect(reply.locator('pre code')).toContainText('<strong>literal</strong>');
    await expect(reply.locator('pre strong')).toHaveCount(0);
    await expect(reply.getByRole('table')).toContainText('Forecast');
    await expect(reply.getByRole('link', { name: 'Source', exact: true })).toHaveAttribute('rel', 'noopener noreferrer');
    expect(await drawer.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    await drawer.locator('.ai-messages').evaluate(el => { el.scrollTop = 0; });
    await page.screenshot({ path: test.info().outputPath(`ai-markdown-${terminal ? 'terminal' : 'van'}.png`) });
    await drawer.getByRole('link', { name: 'Messages', exact: true }).click();
    await expect(page.getByRole('log', { name: 'Private AI messages' }).getByRole('heading', { level: 2 })).toHaveText('Critique of @der_spotter');
    expect(calls.filter(c => c.path.endsWith('/messages'))).toHaveLength(1);
  });

  test(`private critique stays in the reader's selected AI conversation (${terminal ? 'terminal' : 'van'})`, async ({ page }) => {
    const calls = await mockAi(page);
    await page.goto(`/test/ai-assistant.html${terminal ? '?terminal' : ''}`);
    await page.getByRole('button', { name: 'Ask AI about this post' }).click();
    const drawer = page.getByRole('dialog', { name: 'AI assistant' });
    await drawer.getByRole('textbox', { name: 'Message AI' }).fill('Give me a careful, constructive critique of this post.');
    expect(calls.filter(c => c.path.endsWith('/messages'))).toHaveLength(0);
    await drawer.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(drawer.getByText('AI · example/model', { exact: true })).toBeVisible();
    expect(calls.filter(c => c.path.endsWith('/messages'))).toHaveLength(1);
    expect(calls.some(c => c.path.includes('public-replies') && c.method === 'POST')).toBe(false);
  });
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

test('AI Markdown blocks executable HTML, unsafe links and remote embeds', async ({ page }) => {
  const attempts = [];
  page.on('request', req => { if (req.url().includes('tracker.invalid')) attempts.push(req.url()); });
  await mockAi(page, { assistantText: [
    '## Safe heading', '',
    '<script>window.aiMarkdownExecuted = true</script>',
    '<img src="https://tracker.invalid/pixel" onerror="window.aiMarkdownExecuted = true">',
    '<svg onload="window.aiMarkdownExecuted = true"></svg>',
    '<iframe src="https://tracker.invalid/embed"></iframe>',
    '<form><input name="token"></form>',
    '<p id="spoof" style="position:fixed" onclick="window.aiMarkdownExecuted = true">Safe text</p>', '',
    '[Unsafe](javascript:alert%281%29)', '', '[Data](data:text/html,unsafe)', '',
    '<a href="java&#x73;cript:alert(1)">Encoded unsafe</a>', '',
    '![remote image](https://tracker.invalid/markdown-image)'
  ].join('\n') });
  await page.goto('/test/ai-assistant.html');
  await page.getByRole('button', { name: 'Open private AI chat' }).click();
  const drawer = page.getByRole('dialog', { name: 'AI assistant' });
  await drawer.getByRole('textbox', { name: 'Message AI' }).fill('**Keep my input literal**');
  await drawer.getByRole('button', { name: 'Send', exact: true }).click();
  const reply = drawer.locator('.ai-markdown');
  await expect(reply.getByRole('heading')).toHaveText('Safe heading');
  await expect(reply.locator('script, img, svg, iframe, form, input, [onclick], [onerror], [style], [id]')).toHaveCount(0);
  await expect(reply.locator('a[href]')).toHaveCount(0);
  expect(await page.evaluate(() => window.aiMarkdownExecuted)).toBeUndefined();
  expect(attempts).toEqual([]);
  await expect(drawer.locator('.ai-message-user .ai-message-content')).toHaveText('**Keep my input literal**');
});

test('public reviews accept any model on the saved provider and persist the opt-in', async ({ page }) => {
  const calls = await mockAi(page);
  await page.goto('/test/ai-assistant.html#settings');
  const enabled = page.getByLabel('Automatically critique my new posts publicly using my API key');
  await expect(enabled).not.toBeChecked();
  await page.getByLabel('Public critique model ID', { exact: true }).fill('custom/any-model-123');
  await enabled.check();
  await page.getByRole('button', { name: 'Save critique settings', exact: true }).click();
  await expect(page.getByText('Critique settings saved. Applies to future reviews.')).toBeVisible();
  expect(calls.filter(c => c.path === '/api/ai/settings' && c.method === 'PUT')).toHaveLength(0);
  await page.reload();
  await expect(page.getByLabel('Public critique model ID', { exact: true })).toHaveValue('custom/any-model-123');
  await expect(enabled).toBeChecked();
  await expect(page.getByLabel('Model ID', { exact: true })).toHaveValue('example/model');
});

test('public reviews require a personal key and have no global Opus default', async ({ page }) => {
  await mockAi(page, { configured: false });
  await page.goto('/test/ai-assistant.html#settings');
  await expect(page.getByLabel('Model ID', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('Public critique model ID', { exact: true })).toHaveValue('');
  await page.getByLabel('Automatically critique my new posts publicly using my API key').check();
  await expect(page.getByRole('button', { name: 'Save critique settings', exact: true })).toBeDisabled();
  await page.getByLabel('Model ID', { exact: true }).fill('custom/my-own-model');
  await page.getByLabel('API key', { exact: true }).fill('test-own-key-no-network');
  await page.getByRole('button', { name: 'Save AI settings', exact: true }).click();
  await expect(page.getByText('AI settings saved.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save critique settings', exact: true })).toBeEnabled();
});

test('reopening the post AI chat preserves an existing draft', async ({ page }) => {
  await mockAi(page);
  await page.goto('/test/ai-assistant.html');
  await page.getByRole('button', { name: 'Ask AI about this post' }).click();
  const draft = page.getByRole('textbox', { name: 'Message AI' });
  await expect(draft).toBeEnabled();
  await draft.fill('My unfinished question');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Ask AI about this post' }).click();
  await expect(draft).toHaveValue('My unfinished question');
});

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
