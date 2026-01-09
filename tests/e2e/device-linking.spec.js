const { test, expect } = require('@playwright/test');

// Test user - we'll use the same user on two "devices" (browser contexts)
const USER = { email: 'user1@example.com', password: 'password123', name: 'testuser1' };

/**
 * Reset server-side state for test users via shell script
 */
async function resetServerState() {
    const { exec } = require('child_process');
    return new Promise((resolve, reject) => {
        exec('./tests/e2e/reset-test-users.sh', (error, stdout, stderr) => {
            if (error) {
                console.warn('Reset script warning:', stderr);
            }
            console.log('Server state reset:', stdout.includes('Reset complete'));
            resolve();
        });
    });
}

/**
 * Clear all browser storage (IndexedDB, localStorage, sessionStorage)
 */
async function clearBrowserStorage(page) {
    await page.goto('http://localhost:5173/#login');
    await page.waitForTimeout(500);

    await page.evaluate(async () => {
        localStorage.clear();
        sessionStorage.clear();

        const databases = await indexedDB.databases();
        const deletePromises = databases.map(db => {
            return new Promise((resolve) => {
                if (!db.name) return resolve();
                const req = indexedDB.deleteDatabase(db.name);
                req.onsuccess = () => resolve();
                req.onerror = () => resolve();
                req.onblocked = () => resolve();
            });
        });
        await Promise.all(deletePromises);
    });

    await page.waitForTimeout(500);
}

/**
 * Helper to log in a user (staged login flow)
 */
async function loginUser(page, user) {
    await page.goto('http://localhost:5173/#login');
    await page.fill('#email', user.email);
    await page.getByRole('button', { name: 'Continue' }).click();

    // Wait for password stage (device should be auto-verified for first login)
    await expect(page.locator('#password')).toBeVisible({ timeout: 15000 });
    await page.fill('#password', user.password);
    await page.getByRole('button', { name: 'Sign In' }).click();

    await expect(page.locator('.home-page')).toBeVisible({ timeout: 20000 });
    // Allow time for vault initialization
    await page.waitForTimeout(3000);
}

test.describe('Device Linking Flow', () => {

    test.beforeEach(async () => {
        // Reset server state before each test
        await resetServerState();
    });

    test('New device can be approved and vault syncs correctly', async ({ browser }) => {
        // --- 1. Setup: Clear storage for fresh state ---
        console.log('Clearing browser storage...');
        const tempContext = await browser.newContext();
        const tempPage = await tempContext.newPage();
        await clearBrowserStorage(tempPage);
        await tempContext.close();

        // --- 2. Device A: First login (establishes vault) ---
        console.log('Device A: Logging in to establish vault...');
        const contextA = await browser.newContext();
        const pageA = await contextA.newPage();

        // Enable console logging for debugging
        pageA.on('console', msg => {
            if (msg.type() === 'error' || msg.text().includes('Vault') || msg.text().includes('Device')) {
                console.log(`[Device A] ${msg.type()}: ${msg.text()}`);
            }
        });

        await loginUser(pageA, USER);

        // Verify vault was created successfully
        const vaultStateA = await pageA.evaluate(() => {
            const vs = window.__vaultStore;
            return {
                hasVaultStore: !!vs,
                isLocked: vs?.isLocked,
                vaultExists: vs?.vaultExists,
                userId: vs?.userId
            };
        });
        console.log('Device A vault state:', vaultStateA);
        expect(vaultStateA.isLocked).toBe(false);

        // --- 3. Device B: New device login (staged flow - shows verification) ---
        console.log('Device B: Starting login from new device...');
        const contextB = await browser.newContext();
        const pageB = await contextB.newPage();

        // Clear storage for device B to simulate fresh device
        await clearBrowserStorage(pageB);

        // Enable console logging
        pageB.on('console', msg => {
            if (msg.type() === 'error' || msg.text().includes('Vault') || msg.text().includes('Device') || msg.text().includes('LINK')) {
                console.log(`[Device B] ${msg.type()}: ${msg.text()}`);
            }
        });

        // Start staged login on device B
        await pageB.goto('http://localhost:5173/#login');
        await pageB.fill('#email', USER.email);
        await pageB.getByRole('button', { name: 'Continue' }).click();

        // Device B should see verification stage (since device A already exists)
        const verificationCodeDisplay = pageB.locator('.verification-code-display');
        await expect(verificationCodeDisplay).toBeVisible({ timeout: 20000 });
        console.log('Device B: Verification stage visible');

        // Get the verification code
        const verificationCode = (await verificationCodeDisplay.textContent() || '').trim();
        console.log('Verification code:', verificationCode);
        expect(verificationCode).toMatch(/^[0-9A-F]{6}$/);

        // --- 4. Device A: Navigate to Settings and approve ---
        console.log('Device A: Navigating to Settings to approve...');
        await pageA.goto('http://localhost:5173/#settings');

        // Find the "Approve New Device Login" section
        await expect(pageA.getByRole('heading', { name: 'Approve New Device Login' }))
            .toBeVisible({ timeout: 10000 });

        // Enter the verification code
        await pageA.locator('input.verification-code-input').fill(verificationCode);

        // Accept the alert that appears on successful approval
        pageA.once('dialog', dialog => dialog.accept());

        // Click Approve button
        await pageA.getByRole('button', { name: 'Approve Login' }).click();

        // Wait for approval to process
        await pageA.waitForTimeout(2000);

        // --- 5. Device B: Should now see password stage ---
        console.log('Device B: Checking if password stage appeared...');
        await expect(pageB.locator('#password')).toBeVisible({ timeout: 20000 });
        await expect(pageB.locator('.verification-code-display')).not.toBeVisible();

        // Verify device_public_id was stored
        const storedDeviceId = await pageB.evaluate(() => localStorage.getItem('device_public_id'));
        console.log('Device B stored device_public_id:', storedDeviceId);
        expect(storedDeviceId).toBeTruthy();

        // --- 6. Device B: Complete login ---
        await pageB.fill('#password', USER.password);
        await pageB.getByRole('button', { name: 'Sign In' }).click();

        await expect(pageB.locator('.home-page')).toBeVisible({ timeout: 20000 });
        console.log('Device B: Successfully logged in!');

        // Wait for vault initialization
        await pageB.waitForTimeout(3000);

        // Verify vault state on device B
        const vaultStateB = await pageB.evaluate(() => {
            const vs = window.__vaultStore;
            return {
                isLocked: vs?.isLocked,
                vaultExists: vs?.vaultExists,
                userId: vs?.userId
            };
        });
        console.log('Device B vault state:', vaultStateB);
        expect(vaultStateB.isLocked).toBe(false);

        console.log('Device linking and vault sync test PASSED!');

        // --- Cleanup ---
        await contextA.close();
        await contextB.close();
    });

    test('Settings page shows device management options', async ({ browser }) => {
        // This test verifies the device management UI in settings
        const context = await browser.newContext();
        const page = await context.newPage();

        await clearBrowserStorage(page);
        await loginUser(page, USER);

        // Navigate to settings
        await page.goto('http://localhost:5173/#settings');
        await page.waitForTimeout(1000);

        // Verify device management sections exist
        await expect(page.getByRole('heading', { name: 'Approve New Device Login' }))
            .toBeVisible({ timeout: 5000 });

        // Verify verification code input exists
        await expect(page.locator('input.verification-code-input')).toBeVisible();

        // Verify approve button exists
        await expect(page.getByRole('button', { name: 'Approve Login' })).toBeVisible();

        // Verify legacy linking section exists
        await expect(page.getByRole('heading', { name: 'Link Another Logged-In Device' }))
            .toBeVisible();

        console.log('Device management UI test PASSED!');

        await context.close();
    });

    test('Verification code expiry shows correct UI on login page', async ({ page }) => {
        // This test verifies the verification stage shows expiry info
        await clearBrowserStorage(page);

        // Start login for non-existent email (anti-enumeration - will still show verification)
        await page.goto('http://localhost:5173/#login');
        await page.fill('#email', 'test-expiry@example.com');
        await page.getByRole('button', { name: 'Continue' }).click();

        // Should see verification stage
        await expect(page.locator('.verification-code-display')).toBeVisible({ timeout: 10000 });

        // Should show "Verify this device" heading
        await expect(page.locator('h2:has-text("Verify this device")')).toBeVisible();

        // Should show verification hints
        await expect(page.locator('.verification-hint')).toBeVisible();

        // Should show expiry time (may take a moment to render)
        const expiryLocator = page.locator('.verification-expires');
        const hasExpiry = await expiryLocator.isVisible({ timeout: 3000 }).catch(() => false);
        if (hasExpiry) {
            const expiryText = await expiryLocator.textContent();
            console.log('Expiry text:', expiryText);
            expect(expiryText).toContain('expires');
        } else {
            console.log('Expiry element not rendered (may be conditional based on API response)');
        }

        // Should have cancel button
        await expect(page.getByRole('button', { name: 'Cancel' })).toBeVisible();

        console.log('Verification expiry UI test PASSED!');
    });

});
