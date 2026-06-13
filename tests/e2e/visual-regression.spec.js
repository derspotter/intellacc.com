// Visual-regression baselines for the van skin. See
// docs/superpowers/specs/2026-06-13-visual-regression-baseline-design.md
//
// Run (dev stack must be up: docker compose -p solid-local -f docker-compose.solid-local.yml up -d):
//   npx playwright test tests/e2e/visual-regression.spec.js
// Generate / update baselines after an intentional visual change:
//   npx playwright test tests/e2e/visual-regression.spec.js --update-snapshots
// Keep test users for debugging: KEEP_E2E_USERS=1
//
// Baselines are environment-specific (font anti-aliasing): generate & run them
// in the same containerized dev environment.
const { test, expect } = require('@playwright/test');
const { createUser, apiFetch, cleanupUsers } = require('./helpers/solidMessaging');
const { masks, gotoStable } = require('./helpers/visual');

const created = [];

test.afterAll(async () => {
  cleanupUsers(created);
});

test('home logged-out', async ({ page }) => {
  await gotoStable(page, 'home');
  await expect(page).toHaveScreenshot('home-logged-out.png', { mask: masks(page), fullPage: true });
});
