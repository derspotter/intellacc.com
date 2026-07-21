// Terminal skin on a phone viewport (390x844, touch): regression locks for
// the mobile status-bar rebuild and the touch navigation paths.
//
// What this file pins down (see the 2026-07 mobile fixes):
// - The tmux status bar hides its low-value segments below md ([INTELLACC]
//   USER:, [VAN], [LOGOUT], SYS:, date) so @username + RP always fit in 390px,
//   and gains a [MENU] button (data-testid="nav-menu-mobile") below sm that
//   opens the command palette — the only touch path to Van-skin switch/logout.
// - Views are hash-routed overlays closable via the [X] ESC TO CLOSE button;
//   the md:hidden bottom nav ([1] FEED / [2] MARKET / [3] CHAT) switches panes.
const { test, expect } = require('@playwright/test');
const { createUser, provisionTopics, cleanupUsers, dbQuery, SOLID_URL } = require('./helpers/solidMessaging');

// iPhone-14-ish. isMobile is essential: without it Chromium reports a desktop
// visualViewport and the max-md/sm breakpoint layout under test never engages
// the way it does on a real phone.
test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

const VIEWPORT_WIDTH = 390;

const created = [];
test.afterAll(async () => cleanupUsers(created));

async function loginTerminal(page, prefix, route = 'home') {
  const u = await createUser(prefix);
  await provisionTopics(u);
  created.push(u);
  await page.addInitScript((t) => localStorage.setItem('token', t), u.token);
  await page.goto(`${SOLID_URL}/?skin=terminal#${route}`, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('body')).toHaveAttribute('data-skin', 'terminal', { timeout: 15000 });
  return u;
}

// The element must be fully inside the 390px viewport width (not clipped on
// either edge). Vertical position is irrelevant here.
async function expectInsideViewportWidth(locator) {
  await expect(locator).toBeVisible({ timeout: 10000 });
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  expect(box.x).toBeGreaterThanOrEqual(-0.5);
  expect(box.x + box.width).toBeLessThanOrEqual(VIEWPORT_WIDTH + 0.5);
}

async function expectNoHorizontalOverflow(page) {
  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(scrollWidth).toBe(VIEWPORT_WIDTH);
}

test('status bar fits 390px: readouts inside, desktop segments hidden, [MENU] present', async ({ page }) => {
  await loginTerminal(page, 'mterm1');
  const header = page.locator('header');

  // @username and RP must be fully visible inside the phone viewport.
  await expectInsideViewportWidth(header.locator('[data-testid="user-readout"]'));
  const rp = header.locator('[data-testid="rp-readout"]');
  await expect(rp).toContainText(/RP:\d/, { timeout: 10000 });
  await expectInsideViewportWidth(rp);

  // No horizontal scrolling — neither the document nor inside the bar itself
  // (the header is overflow-x-auto, so document.scrollWidth alone would not
  // catch bar content wider than the screen).
  await expectNoHorizontalOverflow(page);
  const headerOverflow = await header.evaluate((el) => el.scrollWidth - el.clientWidth);
  expect(headerOverflow).toBeLessThanOrEqual(0);

  // Touch affordance for the command palette is present below sm...
  await expect(header.locator('[data-testid="nav-menu-mobile"]')).toBeVisible();
  // ...and the desktop-only segments are collapsed below md.
  await expect(header.getByText('[VAN]')).toBeHidden();
  await expect(header.getByText('[LOGOUT]')).toBeHidden();
  await expect(header.getByText(/^SYS:/)).toBeHidden();
});

test('[MENU] opens the palette by touch; palette carries Van-skin + Logout and opens views', async ({ page }) => {
  await loginTerminal(page, 'mterm2');

  await page.locator('[data-testid="nav-menu-mobile"]').tap();
  await expect(page.getByPlaceholder('Type a command...')).toBeVisible({ timeout: 10000 });

  // [VAN] and [LOGOUT] are hidden in the bar on phones — the palette is their
  // only touch path, so both entries must be listed. (Do NOT tap Logout.)
  await expect(page.getByRole('button', { name: 'Switch to Van Skin' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Logout', exact: true })).toBeVisible();

  await page.getByPlaceholder('Type a command...').fill('leader');
  await page.getByRole('button', { name: /Open Leaderboard/i }).tap();

  const view = page.locator('[data-view="leaderboard"]');
  await expect(view).toBeVisible({ timeout: 10000 });
  await expect(view).toContainText('[VIEW] LEADERBOARD');
});

test('bottom nav switches panes by touch; trade ticket fits 390px', async ({ page }) => {
  // The binary YES/NO trade ticket under test only renders for binary
  // markets (numeric/multiple_choice markets get their own trade UIs since
  // the terminal market-type fix), so tapping whatever market happens to be
  // first in the shared DB is no longer deterministic. Seed a disposable
  // binary market and search for it instead.
  const binaryTitle = `E2E mterm binary ${Date.now()}_${Math.floor(Math.random() * 10000)}`;
  const binaryEventId = Number(dbQuery(`
    INSERT INTO events (title, details, closing_date, event_type, liquidity_b, market_prob)
    VALUES ('${binaryTitle}', 'Seeded by mobile-terminal.spec.js', NOW() + INTERVAL '30 days', 'binary', 5000, 0.5)
    RETURNING id;
  `).split('\n')[0]);
  expect(binaryEventId).toBeGreaterThan(0);

  try {
    await loginTerminal(page, 'mterm3');

    // The md:hidden bottom tab bar is the mobile pane switcher.
    const nav = page.locator('nav.md\\:hidden');
    await expect(nav).toBeVisible({ timeout: 10000 });
    await nav.getByRole('button', { name: '[2] MARKET' }).tap();

    // Market pane (single-pane mobile layout) with the quotes list.
    await expect(page.getByText('[2] MARKET DATA // QUOTES')).toBeVisible({ timeout: 10000 });
    await page.locator('[data-testid="market-search"]:visible').fill(binaryTitle);
    // The search is debounced + server-side: wait for the filtered list (the
    // row showing the seeded title), not just any first row — tapping a
    // stale pre-filter row selects a market the filtered store then drops.
    const row = page.locator('[data-testid="market-row"]', { hasText: binaryTitle }).first();
    await expect(row).toBeVisible({ timeout: 15000 });
    await row.tap();

    // On phones the selection swaps the list for the ORDER BOOK / detail panel.
    await expect(page.getByText('ORDER BOOK // DEPTH')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('[data-testid="market-detail-title"]')).toBeVisible({ timeout: 10000 });

    // Trade ticket controls must be fully usable inside 390px.
    const placeTrade = page.getByRole('button', { name: 'PLACE TRADE' });
    await placeTrade.scrollIntoViewIfNeeded();
    await expectInsideViewportWidth(page.getByRole('button', { name: 'BUY YES' }));
    await expectInsideViewportWidth(page.getByRole('button', { name: 'BUY NO' }));
    await expectInsideViewportWidth(page.getByPlaceholder('e.g. 10'));
    await expectInsideViewportWidth(placeTrade);
    await expectNoHorizontalOverflow(page);
  } finally {
    // Nothing was traded against the seeded market, so a bare delete is safe.
    dbQuery(`DELETE FROM events WHERE id = ${binaryEventId};`);
  }
});

test('settings view scrolls to the DANGER ZONE with no horizontal overflow', async ({ page }) => {
  await loginTerminal(page, 'mterm4', 'settings');

  const view = page.locator('[data-view="settings"]');
  await expect(view).toBeVisible({ timeout: 10000 });
  await expect(view).toContainText('[VIEW] SETTINGS');

  // Single-column masonry on phones: DANGER ZONE (SET-10) is the last section
  // and starts far below the fold.
  const danger = view.getByText('[DANGER ZONE]');
  await expect(danger).not.toBeInViewport();

  // Drive the view host's internal scroller to the bottom. If the container
  // were not scrollable (the pre-fix failure mode), scrollTop would stay 0
  // and the section would remain out of the viewport.
  const scroller = view.locator('> div.overflow-y-auto');
  await scroller.evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await expect(danger).toBeInViewport({ timeout: 10000 });

  await expectNoHorizontalOverflow(page);
});

test('[X] ESC TO CLOSE dismisses a view by touch and returns to the panes', async ({ page }) => {
  await loginTerminal(page, 'mterm5');

  await page.evaluate(() => { window.location.hash = '#leaderboard'; });
  const view = page.locator('[data-view="leaderboard"]');
  await expect(view).toBeVisible({ timeout: 10000 });

  await view.getByRole('button', { name: '[X] ESC TO CLOSE' }).tap();
  await expect(view).not.toBeVisible();
  expect(new URL(page.url()).hash).toBe('#home');

  // Back on the single-pane mobile layout: FEED pane + bottom tab bar.
  await expect(page.getByText('[1] FEED // LIVE')).toBeVisible({ timeout: 10000 });
  await expect(page.locator('nav.md\\:hidden')).toBeVisible();
});

test('logged out: auth screen renders and the status bar stays inside 390px', async ({ page }) => {
  await page.goto(`${SOLID_URL}/?skin=terminal#home`, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('body')).toHaveAttribute('data-skin', 'terminal', { timeout: 15000 });

  // LoginModal is the logged-out surface (two-stage: identifier first).
  await expect(page.getByPlaceholder('Enter email or handle...')).toBeVisible({ timeout: 15000 });
  await expect(page.getByRole('button', { name: /CONTINUE/ })).toBeVisible();

  // Status bar shows the guest readout and never forces horizontal scroll.
  const header = page.locator('header');
  await expectInsideViewportWidth(header.getByText('@GUEST'));
  await expectNoHorizontalOverflow(page);
  const headerOverflow = await header.evaluate((el) => el.scrollWidth - el.clientWidth);
  expect(headerOverflow).toBeLessThanOrEqual(0);
});

test('[N] notification button is visible and opens the notifications overlay', async ({ page }) => {
  await loginTerminal(page, 'mterm7');

  // Compact affordance: on phones the NOTIF segment collapses to [N].
  const notifButton = page.locator('header button', { hasText: '[N]' });
  await expectInsideViewportWidth(notifButton);
  await notifButton.tap();

  await expect(page.getByText('[NOTIFICATIONS]')).toBeVisible({ timeout: 10000 });
  // Fresh user: the explicit empty state, never a blank overlay.
  await expect(page.getByText('NO NOTIFICATIONS YET')).toBeVisible();
});
