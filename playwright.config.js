const fs = require('fs');
const { defineConfig } = require('@playwright/test');

const baseURL = process.env.E2E_BASE_URL || 'http://127.0.0.1:5173';
const useExistingServer = process.env.E2E_USE_EXISTING_SERVER === 'true';
const chromiumPath = process.env.CHROMIUM_PATH;
const launchOptions = {
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  chromiumSandbox: false
};

if (chromiumPath && fs.existsSync(chromiumPath)) {
  launchOptions.executablePath = chromiumPath;
}

const config = {
  testDir: 'tests/e2e',
  timeout: 60_000,
  // Serial by default to avoid shared test-user resets colliding across files.
  workers: 1,
  use: {
    baseURL,
    browserName: 'chromium',
    headless: true,
    launchOptions
  }
};

if (!useExistingServer) {
  config.webServer = {
    command: 'npm --prefix frontend run dev -- --host 127.0.0.1 --port 5173',
    port: 5173,
    reuseExistingServer: true,
    timeout: 120_000
  };
}

module.exports = defineConfig(config);
