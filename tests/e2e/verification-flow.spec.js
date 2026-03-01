const { test, expect } = require('@playwright/test');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { execSync } = require('child_process');

test.describe('Tiered Verification Flow', () => {
    let userEmail;
    let userPassword;
    let userName;

    test.beforeEach(async ({ page }) => {
        // Clear all browser storage before registering
        await page.goto('/#login');
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

        const uniqueSuffix = Date.now().toString().slice(-6);
        userName = `veriftest${uniqueSuffix}`;
        userEmail = `veriftest${uniqueSuffix}@example.com`;
        userPassword = 'TestPassword123!';
    });

    test('should progress from Tier 0 to Tier 2 via Email and Phone verification', async ({ page }) => {
        test.setTimeout(60000);

        // 1. Register a new user natively via DB insertion (Test users bypass UI registration issues)
        console.log(`Injecting user ${userName} into DB...`);
        execSync(`docker exec intellacc_db psql -U intellacc_user -d intellaccdb -c "CREATE EXTENSION IF NOT EXISTS pgcrypto; INSERT INTO users (username, email, password_hash, created_at, updated_at) VALUES ('${userName}', '${userEmail}', crypt('${userPassword}', gen_salt('bf')), NOW(), NOW());"`);

        // Now log the user in
        await page.goto('/#login');
        await page.fill('#email', userEmail);
        await page.fill('#password', userPassword);
        await page.getByRole('button', { name: 'Sign In' }).click();

        // Wait for login to complete and home page to load
        try {
            await Promise.race([
                page.waitForFunction(() => window.location.hash === '#home', { timeout: 15000 }),
                page.waitForSelector('.home-page', { state: 'visible', timeout: 15000 })
            ]);
        } catch (error) {
            console.error('Timeout waiting for home page. Current HTML:', await page.innerHTML('body'));
            throw error;
        }

        const isAuthenticated = await page.evaluate(() => {
            return Boolean(window.location.hash.startsWith('#home') || window.__vaultStore?.userId);
        });
        expect(isAuthenticated).toBeTruthy();

        // Check starting point in Settings
        await page.goto('/#settings');
        await page.waitForSelector('.verification-status');

        // Wait for tier to show as "0" initially
        await expect(page.locator('.tier-level-0')).toHaveClass(/current/, { timeout: 10000 });

        // 2. Fetch User ID to generate an Email Verification Token
        const userId = await page.evaluate(async (emailToFind) => {
            const token = localStorage.getItem('token');
            if (!token) return null;

            // Use the "me" endpoint or search endpoint to get our ID
            const res = await fetch(`/api/me`, {
                headers: { Authorization: `Bearer ${token}` }
            });
            const data = await res.json();
            return data?.id ?? null;
        }, userEmail);

        expect(userId).toBeTruthy();

        // 3. Generate Valid JWT Token for Email
        const EMAIL_TOKEN_SECRET = process.env.EMAIL_TOKEN_SECRET || 'change_me_email_token_secret';
        const verifyToken = jwt.sign(
            { userId, email: userEmail, purpose: 'email_verify' },
            EMAIL_TOKEN_SECRET,
            { expiresIn: '24h' }
        );
        const tokenHash = crypto.createHash('sha256').update(verifyToken).digest('hex');

        // Insert the generated token's hash into the database so the backend accepts it
        console.log(`Injecting email verification token into DB for user ${userId}...`);
        execSync(`docker exec intellacc_db psql -U intellacc_user -d intellaccdb -c "DELETE FROM email_verification_tokens WHERE user_id = ${userId}; INSERT INTO email_verification_tokens (user_id, token_hash, expires_at) VALUES (${userId}, '${tokenHash}', NOW() + INTERVAL '1 day');"`);

        // 4. Navigate to the verification link using the fake token
        await page.goto(`/#verify-email?token=${verifyToken}`);

        // Ensure success message is shown
        try {
            await expect(page.locator('text=Email Verified!')).toBeVisible({ timeout: 15000 });
        } catch (error) {
            console.error('Timeout waiting for Email Verified. Current HTML:', await page.innerHTML('body'));
            throw error;
        }

        // 5. Navigate back to Settings and verify Tier 1
        await page.goto('/#settings');
        await expect(page.locator('.tier-level-1')).toHaveClass(/current/, { timeout: 15000 });

        // Wait for the UI to settle and show "Verify Phone" button
        await page.getByRole('button', { name: 'Verify Phone' }).click();

        // 6. Complete Tier 2 Phone Verification
        await page.fill('input[type="tel"]', '+15555550123');
        await page.getByRole('button', { name: 'Send Code' }).click();

        // Since we are in non-production environment, the test code is normally 000000
        await expect(page.locator('text=Enter Verification Code')).toBeVisible({ timeout: 10000 });
        await page.fill('input[placeholder="000 000"]', '000000');
        await page.getByRole('button', { name: 'Verify Phone' }).click();

        // Validate that phone verification success triggers an upgrade to Tier 2
        await expect(page.locator('.tier-level-2')).toHaveClass(/current/, { timeout: 15000 });

        // Assert we got the success prompt
        await expect(page.locator('text=Configure Payment Verification').or(page.locator('text=Payment verification is unavailable'))).toBeVisible({ timeout: 10000 });
    });
});
