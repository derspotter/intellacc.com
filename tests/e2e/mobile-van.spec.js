// Mobile-viewport regression suite for the VAN skin (iPhone-13-ish, 390x844).
// Each test pins down a recently fixed mobile behavior:
//   1. #predictions tab strip scrolls sideways instead of clipping LEADERBOARD
//      (and never makes the page itself scroll horizontally),
//   2. #home composer: the empty-feed notice no longer overlaps the Post button,
//      and posting works at phone width,
//   3. binary trade form fits and works inside 390px,
//   4. numeric distribution chart fits 390px and its P10/P50/P90 handles are
//      draggable by touch,
//   5. the bottom tab bar stays fixed (visible + tappable) after scrolling,
//   6. #settings sections (password reset + danger zone) are reachable and fit.
//
// Markets are seeded directly in the DB (same pattern as market-detail.spec.js
// and numeric-market.spec.js) so the suite never depends on what happens to be
// listed in the shared database. The disposable user + both events are removed
// in afterAll.
const { test, expect } = require('@playwright/test');
const {
  createUser,
  provisionTopics,
  cleanupUsers,
  dbQuery,
  SOLID_URL
} = require('./helpers/solidMessaging');
const { refundEventStakes } = require('./helpers/stakeRefund');

// isMobile is essential, not cosmetic: desktop Chromium reserves a ~15px
// classic scrollbar gutter that no phone has, which falsifies every
// "fits in 390px" assertion below. hasTouch enables real touch input.
const VIEWPORT = { width: 390, height: 844 };
test.use({ viewport: VIEWPORT, isMobile: true, hasTouch: true });

// Mobile pages load a full market list + chart data over the shared backend;
// give slow CI headroom rather than sprinkling per-assertion retries.
test.setTimeout(120000);

const stamp = `${Date.now()}_${Math.floor(Math.random() * 10000)}`;
const binaryTitle = `E2E mobile-van binary ${stamp}`;
const numericTitle = `E2E mobile-van numeric ${stamp}`;

const created = [];
let user;
let binaryEventId;
let numericEventId;

test.beforeAll(async () => {
  user = await createUser('mvan');
  created.push(user);
  // Without topics the blocking onboarding gate replaces every authed page.
  await provisionTopics(user);
  // Trading requires verification tier 2 (same bump market-detail.spec.js
  // does for user1); this user is disposable so no restore is needed.
  dbQuery(`UPDATE users SET verification_tier = 2 WHERE id = ${user.id};`);

  // Open binary market at 50% — the trade in test 3 stakes against it.
  binaryEventId = Number(dbQuery(`
    INSERT INTO events (title, details, closing_date, event_type, liquidity_b, market_prob)
    VALUES ('${binaryTitle}', 'Seeded by mobile-van.spec.js', NOW() + INTERVAL '30 days', 'binary', 5000, 0.5)
    RETURNING id;
  `).split('\n')[0]);
  expect(binaryEventId).toBeGreaterThan(0);

  // Numeric market: 50 linear bins over [0,10], uniform 2% prior, b_numeric
  // copied from the production seed (see numeric-market.spec.js) so quotes
  // and handle math behave exactly like a real market. Uniform prior means
  // the P50 handle deterministically initializes to 5.00.
  numericEventId = Number(dbQuery(`
    INSERT INTO events (title, details, closing_date, event_type)
    VALUES ('${numericTitle}', 'Seeded by mobile-van.spec.js', NOW() + INTERVAL '30 days', 'numeric')
    RETURNING id;
  `).split('\n')[0]);
  expect(numericEventId).toBeGreaterThan(0);
  dbQuery(`
    INSERT INTO event_outcomes (event_id, outcome_key, label, sort_order, lower_bound, upper_bound)
    SELECT ${numericEventId}, 'bin_' || i,
           (round((i*0.2)::numeric,1))::text || '-' || (round(((i+1)*0.2)::numeric,1))::text,
           i, i*0.2, (i+1)*0.2
    FROM generate_series(0,49) AS i;

    INSERT INTO event_outcome_states (event_id, outcome_id, q_value, prob)
    SELECT ${numericEventId}, id, 0, 0.02 FROM event_outcomes WHERE event_id = ${numericEventId};

    INSERT INTO numeric_market_config
      (event_id, range_min, range_max, zero_point, open_lower_bound, open_upper_bound,
       unit, bin_count, transform, binning_version, b_numeric, numeric_market_version)
    VALUES (${numericEventId}, 0, 10, NULL, false, false, NULL, 50, 'linear', 1, 885.9866097900589, 0);
  `);
});

test.afterAll(async () => {
  const ids = [binaryEventId, numericEventId].filter(Boolean).join(',');
  if (ids) {
    // Unwind rp_staked_ledger BEFORE deleting the events (event deletion
    // cascades the share rows but not the users' staked counters).
    refundEventStakes(dbQuery, ids);
    dbQuery(`DELETE FROM market_updates WHERE event_id IN (${ids});
             DELETE FROM events WHERE id IN (${ids});`);
  }
  cleanupUsers(created);
});

// Log in via token (no login-form round trip) and pin the van skin both via
// query param and the persisted preference, mirroring __mobile-audit.spec.js.
async function openVan(page, route) {
  await page.addInitScript((t) => localStorage.setItem('token', t), user.token);
  await page.addInitScript(() => localStorage.setItem('intellacc.ui.skin', 'van'));
  await page.goto(`${SOLID_URL}/?skin=van#${route}`, { waitUntil: 'domcontentloaded' });
}

// The page itself must never scroll horizontally on a phone — individual
// widgets (the tab strip) may scroll internally, the document may not.
async function expectNoPageOverflow(page, label) {
  const metrics = await page.evaluate(() => ({
    htmlScroll: document.documentElement.scrollWidth,
    bodyScroll: document.body.scrollWidth,
    client: document.documentElement.clientWidth
  }));
  expect(metrics.client, `${label}: isMobile viewport must be full-bleed 390`).toBe(VIEWPORT.width);
  expect(metrics.htmlScroll, `${label}: html must not scroll horizontally`).toBeLessThanOrEqual(metrics.client);
  expect(metrics.bodyScroll, `${label}: body must not scroll horizontally`).toBeLessThanOrEqual(metrics.client);
}

// "Fully inside the 390px viewport" for a control: on-screen and not clipped.
async function expectInsideViewportWidth(locator, label) {
  const box = await locator.boundingBox();
  expect(box, `${label} must be visible (have a bounding box)`).not.toBeNull();
  expect(box.x, `${label} must not start left of the viewport`).toBeGreaterThanOrEqual(-0.5);
  expect(box.x + box.width, `${label} must not overflow the 390px viewport`)
    .toBeLessThanOrEqual(VIEWPORT.width + 0.5);
}

test('predictions tab strip scrolls horizontally; LEADERBOARD is reachable without page overflow', async ({ page }) => {
  await openVan(page, 'predictions');

  const strip = page.locator('.predictions-tabs');
  await expect(strip).toBeVisible({ timeout: 20000 });
  // Logged in there are 4 tabs (Positions/Markets/Submit/Leaderboard) — more
  // than fits in 390px. The fix makes the STRIP scroll internally.
  await expect(page.getByRole('tab', { name: 'Leaderboard' })).toBeAttached({ timeout: 20000 });
  const stripMetrics = await strip.evaluate((el) => ({
    scrollWidth: el.scrollWidth,
    clientWidth: el.clientWidth
  }));
  expect(stripMetrics.clientWidth, 'strip must be capped at the viewport').toBeLessThanOrEqual(VIEWPORT.width);
  expect(stripMetrics.scrollWidth, 'strip must overflow internally (that is what makes it scrollable)')
    .toBeGreaterThan(stripMetrics.clientWidth);

  // ...while the PAGE stays exactly 390 wide (the old bug: tabs widened html).
  await expectNoPageOverflow(page, 'predictions');

  // The last tab must be reachable by scrolling the strip and actually work.
  const leaderboardTab = page.getByRole('tab', { name: 'Leaderboard' });
  await leaderboardTab.scrollIntoViewIfNeeded();
  await expectInsideViewportWidth(leaderboardTab, 'Leaderboard tab after strip scroll');
  await leaderboardTab.click();
  await expect(page).toHaveURL(/#predictions\/leaderboard$/);
  await expect(leaderboardTab).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByText('Reputation Leaderboard')).toBeVisible({ timeout: 20000 });
  await expectNoPageOverflow(page, 'predictions/leaderboard');
});

test('home composer posts at 390px and nothing overlaps the Post button', async ({ page }) => {
  await openVan(page, 'home');

  const composer = page.locator('.create-post-card');
  await expect(composer).toBeVisible({ timeout: 20000 });
  const postButton = composer.locator('button.submit-button');
  await postButton.scrollIntoViewIfNeeded();
  await expectInsideViewportWidth(postButton, 'Post button');

  // Regression: the empty-feed notice used to be absolutely pinned into the
  // card's bottom padding and rendered ON TOP of the Post button at phone
  // width. When the notice is present (fresh accounts can instead get the
  // discover feed, which has posts), it must now flow BELOW the button.
  const buttonBox = await postButton.boundingBox();
  const emptyFeed = page.locator('.empty-feed');
  if (await emptyFeed.count()) {
    const emptyBox = await emptyFeed.first().boundingBox();
    expect(emptyBox, 'empty-feed notice should be rendered').not.toBeNull();
    expect(emptyBox.y, 'empty-feed notice must sit fully below the Post button')
      .toBeGreaterThanOrEqual(buttonBox.y + buttonBox.height - 0.5);
  }
  // Overlap check that holds in both feed states: the topmost element at the
  // button's center must be the button itself (or a descendant of it).
  const hit = await page.evaluate(({ x, y }) => {
    const el = document.elementFromPoint(x, y);
    return { tag: el?.tagName, insideButton: !!el?.closest('button.submit-button') };
  }, { x: buttonBox.x + buttonBox.width / 2, y: buttonBox.y + buttonBox.height / 2 });
  expect(hit.insideButton, `Post button is covered by <${hit.tag}> at its center`).toBe(true);

  // Create a post through the composer and expect it to show up in the feed
  // (HomePage prepends the created post client-side — no reload needed).
  const text = `Mobile van spec post ${stamp}`;
  await composer.locator('#solid-post-content').fill(text);
  await postButton.click();
  await expect(page.locator('.post-card', { hasText: text }).first()).toBeVisible({ timeout: 20000 });
  // Composer cleared = the create call round-tripped successfully.
  await expect(composer.locator('#solid-post-content')).toHaveValue('');
  await expectNoPageOverflow(page, 'home after posting');
});

test('binary market: trade controls fit inside 390px and a real stake goes through', async ({ page }) => {
  await openVan(page, `predictions/${binaryEventId}`);

  const detail = page.locator('.market-detail');
  await expect(detail).toBeVisible({ timeout: 20000 });
  await expect(detail.locator('.market-detail-title')).toHaveText(binaryTitle);
  await expectNoPageOverflow(page, 'binary market detail');

  // Every trade control must be fully inside the viewport width — the old
  // failure mode was the form spilling past 390 so YES/submit were off-screen.
  const card = detail.locator('.event-card');
  const yesBtn = card.locator('.direction-btn.yes-btn');
  const noBtn = card.locator('.direction-btn.no-btn');
  const stakeInput = card.locator('.stake-input');
  const submit = card.getByRole('button', { name: /place stake/i });
  for (const [locator, label] of [
    [yesBtn, 'YES direction button'],
    [noBtn, 'NO direction button'],
    [stakeInput, 'stake input'],
    [submit, 'Place Stake button']
  ]) {
    await locator.scrollIntoViewIfNeeded();
    await expect(locator).toBeVisible();
    await expectInsideViewportWidth(locator, label);
  }

  // Place a small real trade (disposable tier-2 user, 1000 RP default) and
  // require a UI reaction: the freshly seeded market has zero activity rows,
  // so exactly one row naming this user must appear after the stake.
  await yesBtn.click();
  await stakeInput.fill('10');
  await submit.click();
  const tradeRows = detail.locator('.market-detail-trade-row');
  await expect(tradeRows).toHaveCount(1, { timeout: 20000 });
  await expect(tradeRows.first()).toContainText(user.username);
});

test('numeric market: chart fits 390px and a touch drag moves the P50 handle', async ({ page }) => {
  await openVan(page, `predictions/${numericEventId}`);

  const card = page.locator('.distribution-market-card');
  await expect(card).toBeVisible({ timeout: 20000 });
  const svg = card.locator('svg.distribution-card-chart');
  await expect(svg).toBeVisible({ timeout: 20000 });
  // Chart becomes pointer-interactive only once market state is loaded.
  await expect(svg).toHaveClass(/distribution-card-chart-interactive/, { timeout: 20000 });
  await expectNoPageOverflow(page, 'numeric market detail');
  await expectInsideViewportWidth(svg, 'distribution chart svg');

  const centerInput = card.locator('.distribution-card-handle-input').nth(1);
  await expect(centerInput).toHaveValue('5.00'); // uniform prior P50 on [0,10]

  await svg.scrollIntoViewIfNeeded();
  const box = await svg.boundingBox();
  // viewBox 640x200, preserveAspectRatio=none, no open tails: plot spans
  // viewBox x 10..630 over nominal 0..10, so a screen-x fraction maps to
  // nominal value ((fx*640 - 10) / 620) * 10.
  const nominalAt = (fx) => ((fx * 640 - 10) / 620) * 10;
  const y = box.y + box.height / 2;
  const xAt = (fx) => box.x + box.width * fx;

  // Real touch drag via the DevTools protocol (Playwright's touchscreen API
  // only taps). Chromium synthesizes pointerdown/move/up with
  // pointerType:'touch' from these, which is exactly what the chart's
  // pointer handlers + touch-action:none are meant to support on phones.
  // Start at 55% width (nearest guide is Center, P50 at 50%) and drag to 70%.
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: xAt(0.55), y }]
  });
  for (const fx of [0.60, 0.65, 0.70]) {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: xAt(fx), y }]
    });
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();

  // The Center (P50) input must have followed the finger to ~7.06.
  await expect
    .poll(async () => Number(await centerInput.inputValue()), {
      timeout: 10000,
      message: 'P50 input should follow the touch drag'
    })
    .toBeGreaterThan(6);
  const centerValue = Number(await centerInput.inputValue());
  expect(Math.abs(centerValue - nominalAt(0.70))).toBeLessThan(0.3);

  // All three handle inputs stay inside the viewport width at 390px.
  const handleInputs = card.locator('.distribution-card-handle-input');
  await expect(handleInputs).toHaveCount(3);
  for (let i = 0; i < 3; i += 1) {
    await handleInputs.nth(i).scrollIntoViewIfNeeded();
    await expectInsideViewportWidth(handleInputs.nth(i), `handle input #${i}`);
  }
});

test('bottom tab bar stays fixed and tappable after scrolling the markets list', async ({ page }) => {
  await openVan(page, 'predictions/markets');

  // Wait for the list to actually render so the page has real height.
  await expect(page.locator('.event-list-item').first()).toBeVisible({ timeout: 20000 });
  const bar = page.locator('.mobile-tab-bar');
  await expect(bar).toBeVisible();

  // The van markets page scrolls INSIDE ul.events-simple-list (the document
  // itself stays ~viewport-height), so scroll that container — it is what a
  // user swiping the list moves. Scroll all the way down and prove it moved
  // (the list holds hundreds of markets plus this spec's two seeded ones).
  const list = page.locator('ul.events-simple-list');
  await expect(list).toBeVisible();
  const scrolled = await list.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
    return el.scrollTop;
  });
  expect(scrolled, 'markets list should actually scroll').toBeGreaterThan(0);
  // Belt-and-braces: also push the document itself down in case a future
  // layout change makes the window scrollable again.
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));

  // Fixed positioning: the bar must still hug the bottom edge of the layout
  // viewport after the scroll, fully on-screen.
  await expect(bar).toBeVisible();
  const barBox = await bar.boundingBox();
  expect(barBox.y).toBeGreaterThanOrEqual(0);
  expect(Math.abs(barBox.y + barBox.height - VIEWPORT.height),
    'tab bar must sit flush with the viewport bottom after scrolling').toBeLessThanOrEqual(2);
  await expectInsideViewportWidth(bar, 'mobile tab bar');

  // Tappable, not just painted: tapping Home must navigate.
  await bar.getByRole('link', { name: 'Home' }).click();
  await expect(page).toHaveURL(/#home$/);
});

test('settings: password-reset and danger-zone sections are reachable and fit 390px', async ({ page }) => {
  await openVan(page, 'settings');

  await expect(page.locator('.settings-page')).toBeVisible({ timeout: 20000 });
  await expectNoPageOverflow(page, 'settings');

  // Password section (cancel pending password reset) — scroll it into view
  // and require its action button to be fully inside the viewport width.
  const passwordSection = page.locator('.settings-section.password-reset-cancel');
  await passwordSection.scrollIntoViewIfNeeded();
  await expect(passwordSection).toBeVisible();
  await expectInsideViewportWidth(passwordSection.locator('button').first(), 'password-reset button');

  // Danger zone at the very bottom: reachable by scrolling, with every
  // control (password confirm, DELETE confirm, delete button) inside 390px.
  const dangerZone = page.locator('.settings-section.danger-zone');
  await dangerZone.scrollIntoViewIfNeeded();
  await expect(dangerZone).toBeVisible();
  await expect(dangerZone.locator('input[type="password"]')).toBeVisible();
  for (const [locator, label] of [
    [dangerZone.locator('input[type="password"]'), 'danger-zone password input'],
    [dangerZone.locator('input[type="text"]'), 'danger-zone DELETE-confirm input'],
    [dangerZone.locator('button.button-danger'), 'Delete Account button']
  ]) {
    await expectInsideViewportWidth(locator, label);
  }
});
