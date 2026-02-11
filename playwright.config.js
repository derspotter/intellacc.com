// Playwright config for this repo.
// Keeps all Playwright artifacts in a writable directory (avoids root-owned `test-results`).
const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: 'tests/e2e',
  outputDir: '.playwright-test-results',
  reporter: [['line']],
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:5173',
    trace: 'retain-on-failure'
  }
});

