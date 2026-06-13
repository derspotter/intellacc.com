// Helpers for visual-regression screenshots: fixed viewport, mask list for
// dynamic regions, and stable navigation that settles the page before snapshot.
const { SOLID_URL } = require('./solidMessaging');

const VIEWPORT = { width: 1280, height: 720 };

// Locators for regions whose pixels legitimately change between runs. Mask
// matches zero elements harmlessly on screens where a selector is absent.
const masks = (page) => [
  page.locator('.post-date'),
  page.locator('.post-header-likes'),
  page.locator('.post-header-comments'),
  page.locator('.user-stats-horizontal'),
  page.locator('canvas') // Network page WebGL graph
];

// Navigate to a hash route with a stable, screenshot-ready page. If `token` is
// given, it is injected into localStorage before any app script runs.
async function gotoStable(page, hash, { token } = {}) {
  await page.setViewportSize(VIEWPORT);
  if (token) {
    await page.addInitScript((t) => localStorage.setItem('token', t), token);
  }
  await page.goto(`${SOLID_URL}/#${hash}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(500);
}

module.exports = { VIEWPORT, masks, gotoStable };
