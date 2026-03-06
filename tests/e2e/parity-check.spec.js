const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const VAN_URL = process.env.VAN_URL || 'http://127.0.0.1:5186';
const SOLID_URL = process.env.SOLID_URL || 'http://127.0.0.1:4174';

const ROUTES = [
  { name: 'home', path: '#home' },
  { name: 'login', path: '#login' },
  { name: 'signup', path: '#signup' },
  { name: 'predictions', path: '#predictions' },
  { name: 'search', path: '#search' },
  { name: 'notifications', path: '#notifications' },
  { name: 'messages', path: '#messages' },
  { name: 'settings', path: '#settings' }
];

const SHOTS_DIR = path.join(__dirname, '../../parity-shots');

test.beforeAll(async () => {
  if (!fs.existsSync(SHOTS_DIR)) {
    fs.mkdirSync(SHOTS_DIR, { recursive: true });
  }
});

test.describe('Frontend Parity Check', () => {
  for (const route of ROUTES) {
    test(`Visual parity for ${route.name} route`, async ({ page }) => {
      // 1. Capture VanJS screenshot
      await page.goto(`${VAN_URL}/${route.path}`);
      // Wait for some content to load if necessary
      await page.waitForTimeout(2000); 
      await page.screenshot({ path: path.join(SHOTS_DIR, `van-${route.name}.png`), fullPage: true });

      // 2. Capture SolidJS (Van Skin) screenshot
      await page.goto(`${SOLID_URL}/${route.path}${route.path.includes('?') ? '&' : '?'}skin=van`);
      await page.waitForTimeout(2000);
      await page.screenshot({ path: path.join(SHOTS_DIR, `solid-van-${route.name}.png`), fullPage: true });

      // 3. Capture SolidJS (Terminal Skin) screenshot
      await page.goto(`${SOLID_URL}/${route.path}${route.path.includes('?') ? '&' : '?'}skin=terminal`);
      await page.waitForTimeout(2000);
      await page.screenshot({ path: path.join(SHOTS_DIR, `solid-terminal-${route.name}.png`), fullPage: true });

      console.log(`Captured screenshots for ${route.name}`);
    });
  }
});
