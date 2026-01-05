const { chromium } = require('playwright');

(async () => {
    const browser = await chromium.launch();
    const context = await browser.newContext();
    const page = await context.newPage();

    const consoleLogs = [];
    const networkErrors = [];

    // Capture network errors (4xx, 5xx)
    page.on('response', response => {
        if (response.status() >= 400) {
            const url = response.url();
            networkErrors.push(`[${response.status()}] ${url}`);
            console.log(`>>> [NETWORK ${response.status()}] ${url}`);
        }
    });

    page.on('console', msg => {
        const text = msg.text();
        consoleLogs.push('[' + msg.type() + '] ' + text);
        // Print errors immediately
        if (msg.type() === 'error' || text.includes('Error') || text.includes('unreachable')) {
            console.log('>>> [' + msg.type() + '] ' + text);
        }
    });

    console.log('=== Testing User Switch ===\n');

    // Clear IndexedDB to simulate fresh browser (matching reset server state)
    console.log('0. Clearing IndexedDB...');
    await page.goto('http://localhost:5173/#login');
    await page.evaluate(async () => {
        const dbs = await window.indexedDB.databases();
        for (const db of dbs) {
            if (db.name) {
                window.indexedDB.deleteDatabase(db.name);
            }
        }
    });
    // Reload to pick up clean IndexedDB state
    await page.reload();
    console.log('   IndexedDB cleared');

    // Login as user1
    console.log('1. Logging in as user1...');
    await page.waitForSelector('#email');
    await page.fill('#email', 'user1@example.com');
    await page.fill('#password', 'password123');
    await page.click('button[type="submit"]');
    await page.waitForSelector('.home-page', { timeout: 30000 });
    console.log('   User1 logged in successfully');
    await page.waitForTimeout(1000);

    // Logout
    console.log('2. Logging out...');
    // Import and call logout directly
    await page.evaluate(async () => {
        const authModule = await import('/src/services/auth.js');
        await authModule.logout();
    });
    await page.waitForSelector('#email', { timeout: 5000 });
    console.log('   Logged out');
    await page.waitForTimeout(500);

    // Login as user2
    console.log('3. Logging in as user2...');
    await page.fill('#email', 'user2@example.com');
    await page.fill('#password', 'password123');
    await page.click('button[type="submit"]');

    try {
        await page.waitForSelector('.home-page', { timeout: 30000 });
        console.log('   User2 logged in successfully!');
    } catch (e) {
        console.log('   FAILED: ' + e.message);
    }

    await page.waitForTimeout(2000);

    console.log('\n=== Network Errors ===');
    for (const err of networkErrors) {
        console.log(err);
    }

    console.log('\n=== Relevant Console Logs ===');
    for (const log of consoleLogs) {
        if (log.includes('MLS') || log.includes('Identity') || log.includes('Vault') ||
            log.includes('Error') || log.includes('error') || log.includes('wiped')) {
            console.log(log);
        }
    }

    await browser.close();
})();
