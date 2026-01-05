const { chromium } = require('playwright');

(async () => {
    const browser = await chromium.launch();
    const context = await browser.newContext();
    const page = await context.newPage();

    const consoleLogs = [];
    page.on('console', msg => {
        consoleLogs.push('[' + msg.type() + '] ' + msg.text());
    });

    console.log('=== Testing User2 Login ===\n');

    await page.goto('http://localhost:5173/#login');
    await page.waitForSelector('#email');

    await page.fill('#email', 'user2@example.com');
    await page.fill('#password', 'password123');

    const start = Date.now();
    await page.click('button[type="submit"]');
    await page.waitForSelector('.home-page', { timeout: 30000 });
    console.log('Login time: ' + (Date.now() - start) + 'ms');

    await page.waitForTimeout(2000);

    console.log('\n=== Console Logs ===');
    for (const log of consoleLogs) {
        console.log(log);
    }

    await browser.close();
})();
