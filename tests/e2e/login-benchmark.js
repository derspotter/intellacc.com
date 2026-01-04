const { chromium } = require('playwright');

(async () => {
    const browser = await chromium.launch();
    // Fresh context with no cache
    const context = await browser.newContext();
    const page = await context.newPage();

    // Collect browser console logs
    const consoleLogs = [];
    page.on('console', msg => {
        consoleLogs.push(`[${msg.type()}] ${msg.text()}`);
    });

    const timings = {};
    console.log('=== Login Performance Benchmark (Fresh Context) ===\n');

    // Navigate to login page
    const navStart = Date.now();
    await page.goto('http://localhost:5173/#login');
    await page.waitForSelector('#email');
    timings.pageLoad = Date.now() - navStart;
    console.log(`1. Page load (login form visible): ${timings.pageLoad}ms`);

    // Simulate user typing (gives WASM time to preload)
    const typeStart = Date.now();
    await page.fill('#email', 'user1@example.com');
    await page.waitForTimeout(200); // Simulate thinking
    await page.fill('#password', 'password123');
    await page.waitForTimeout(300); // Simulate finding submit button
    timings.userInput = Date.now() - typeStart;
    console.log(`2. User input simulation: ${timings.userInput}ms`);

    // Submit and measure time to home page
    const loginStart = Date.now();
    await page.click('button[type="submit"]');

    // Wait for home page
    await page.waitForSelector('.home-page', { timeout: 30000 });
    timings.loginToHome = Date.now() - loginStart;
    console.log(`3. Click submit → Home visible: ${timings.loginToHome}ms`);

    // Total
    timings.total = Date.now() - navStart;
    console.log(`\n=== Total: ${timings.total}ms ===`);

    if (timings.loginToHome > 1500) {
        console.log('\n⚠️  Login still slow. Consider:');
        console.log('   - Lazy-load MLS (only when Messages opened)');
        console.log('   - Enable Brotli compression in production');
    } else if (timings.loginToHome > 800) {
        console.log('\n✓ Login acceptable but could be faster');
    } else {
        console.log('\n✓ Login is fast!');
    }

    // Wait a bit for background tasks to complete
    await page.waitForTimeout(2000);

    // Print browser console logs
    console.log('\n=== Browser Console Logs ===');
    for (const log of consoleLogs) {
        console.log(log);
    }

    await browser.close();
})();
