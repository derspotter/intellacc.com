const { chromium } = require('playwright');

(async () => {
    const browser = await chromium.launch();
    const context = await browser.newContext();
    const page = await context.newPage();

    const consoleMessages = [];
    page.on('console', msg => {
        const text = msg.text();
        const type = msg.type();
        consoleMessages.push({ type, text });
        // Print errors and warnings immediately
        if (type === 'error' || type === 'warning' || text.includes('Error') || text.includes('Unsupported')) {
            console.log('>>> ' + type + ': ' + text);
        }
    });

    // Login
    await page.goto('http://localhost:5173/#login');
    await page.fill('#email', 'user1@example.com');
    await page.fill('#password', 'password123');
    await page.click('button[type="submit"]');
    await page.waitForSelector('.home-page', { timeout: 10000 });
    await page.waitForTimeout(5000); // Wait for MLS init including last-resort

    // Print all MLS-related messages
    console.log('\n=== All MLS/Key Package related messages ===');
    consoleMessages
        .filter(m => m.text.includes('MLS') || m.text.includes('key') || m.text.includes('Key') || m.text.includes('last') || m.text.includes('Last') || m.text.includes('lifetime'))
        .forEach(m => console.log('[' + m.type + '] ' + m.text));

    await browser.close();
})();
