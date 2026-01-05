const { chromium } = require('playwright');

/**
 * Test that messages are held back until welcome is accepted
 * Similar to test-user-switch.js pattern
 */

(async () => {
    const browser = await chromium.launch();
    const context = await browser.newContext();
    const page = await context.newPage();

    const consoleLogs = [];

    page.on('response', response => {
        if (response.status() >= 400) {
            console.log(`>>> [NETWORK ${response.status()}] ${response.url()}`);
        }
    });

    page.on('console', msg => {
        const text = msg.text();
        consoleLogs.push('[' + msg.type() + '] ' + text);
        if (msg.type() === 'error' || text.includes('Error') || text.includes('unreachable')) {
            console.log('>>> [' + msg.type() + '] ' + text);
        }
    });

    console.log('=== Test: Invite Before Messages ===\n');

    // Step 0: Clear IndexedDB once at start
    console.log('0. Clearing IndexedDB...');
    await page.goto('http://localhost:5173/#login');
    await page.evaluate(async () => {
        const dbs = await window.indexedDB.databases();
        for (const db of dbs) {
            if (db.name) window.indexedDB.deleteDatabase(db.name);
        }
    });
    await page.reload();
    console.log('   Done\n');

    // Step 1: User2 logs in first to upload key packages
    console.log('1. User2 logging in (to upload key packages)...');
    await page.waitForSelector('#email');
    await page.fill('#email', 'user2@example.com');
    await page.fill('#password', 'password123');
    await page.click('button[type="submit"]');
    await page.waitForSelector('.home-page', { timeout: 30000 });
    await page.waitForTimeout(3000);
    console.log('   Logged in');

    // Step 2: User2 logs out
    console.log('2. User2 logging out...');
    await page.evaluate(async () => {
        const authModule = await import('/src/services/auth.js');
        await authModule.logout();
    });
    await page.waitForSelector('#email', { timeout: 5000 });
    console.log('   Logged out\n');

    // Step 3: User1 logs in (no IDB clear - user2's server key packages remain)
    console.log('3. User1 logging in...');
    await page.fill('#email', 'user1@example.com');
    await page.fill('#password', 'password123');
    await page.click('button[type="submit"]');
    await page.waitForSelector('.home-page', { timeout: 30000 });
    await page.waitForTimeout(3000);
    console.log('   Logged in');

    // Step 4: User1 sends DM to user2
    console.log('4. User1 sending message to user2...');
    // Wait for vault restore to complete (look for the log message)
    await page.waitForFunction(() => {
        return window.__mlsClientReady === true;
    }, { timeout: 15000 }).catch(() => {
        console.log('   Warning: MLS ready flag not set, continuing anyway');
    });

    const sendResult = await page.evaluate(async () => {
        const coreCryptoClient = window.coreCryptoClient;
        if (!coreCryptoClient) return { error: 'coreCryptoClient not on window' };
        try {
            const dm = await coreCryptoClient.startDirectMessage(25);
            console.log('[Test] DM created:', dm.groupId);
            await coreCryptoClient.sendMessage(dm.groupId, 'Hello from user1!');
            console.log('[Test] Message sent');
            return { success: true, groupId: dm.groupId };
        } catch (e) {
            console.error('[Test] Error:', e);
            return { error: e.message };
        }
    });
    console.log('   Result:', JSON.stringify(sendResult));

    if (sendResult.error) {
        console.log('\n✗ FAILED: Could not send message');
        console.log('\n=== Relevant Logs ===');
        consoleLogs.filter(l => l.includes('MLS') || l.includes('Test') || l.includes('Error'))
            .forEach(l => console.log(l));
        await browser.close();
        return;
    }
    await page.waitForTimeout(1000);

    // Step 5: User1 logs out
    console.log('5. User1 logging out...');
    await page.evaluate(async () => {
        const authModule = await import('/src/services/auth.js');
        await authModule.logout();
    });
    await page.waitForSelector('#email', { timeout: 5000 });
    console.log('   Logged out\n');

    // Step 6: User2 logs in (no IDB clear - testing server-side message ordering)
    console.log('6. User2 logging in to receive invite...');
    await page.waitForSelector('#email');
    await page.fill('#email', 'user2@example.com');
    await page.fill('#password', 'password123');
    await page.click('button[type="submit"]');
    await page.waitForSelector('.home-page', { timeout: 30000 });
    await page.waitForTimeout(3000);
    console.log('   Logged in');

    // Step 7: Check state BEFORE accepting
    console.log('7. Checking state BEFORE accepting...');
    const beforeAccept = await page.evaluate(async () => {
        const coreCryptoClient = window.coreCryptoClient;
        const pending = coreCryptoClient.pendingWelcomes; // Map
        const { default: messagingStore } = await import('/src/stores/messagingStore.js');
        const msgs = messagingStore.mlsMessages || {};
        let msgCount = 0;
        for (const gid in msgs) msgCount += (msgs[gid] || []).length;
        return { invites: pending.size, messages: msgCount };
    });
    console.log('   Pending invites:', beforeAccept.invites);
    console.log('   Messages visible:', beforeAccept.messages);

    const inviteOk = beforeAccept.invites > 0;
    const noMsgYet = beforeAccept.messages === 0;
    console.log('   ' + (inviteOk ? '✓' : '✗') + ' Has invite');
    console.log('   ' + (noMsgYet ? '✓' : '✗') + ' No messages yet\n');

    // Step 8: Accept invite and capture messages
    console.log('8. Accepting invite...');
    const acceptResult = await page.evaluate(async () => {
        const coreCryptoClient = window.coreCryptoClient;
        const pending = coreCryptoClient.pendingWelcomes; // Map
        if (pending.size === 0) return { error: 'No invites' };
        const firstEntry = pending.entries().next().value;
        const [pendingId, invite] = firstEntry;

        // Track received messages
        window.__receivedMessages = [];
        coreCryptoClient.onMessage((msg) => {
            window.__receivedMessages.push(msg);
        });

        try {
            const groupId = await coreCryptoClient.acceptWelcome(invite);
            await coreCryptoClient.syncMessages();
            // Wait a bit for messages to be processed
            await new Promise(r => setTimeout(r, 500));
            return { success: true, groupId, messageCount: window.__receivedMessages.length };
        } catch (e) {
            return { error: e.message };
        }
    });
    console.log('   Result:', JSON.stringify(acceptResult));
    await page.waitForTimeout(1000);

    // Step 9: Check state AFTER accepting
    console.log('9. Checking state AFTER accepting...');
    const afterAccept = await page.evaluate(async () => {
        const receivedMsgs = window.__receivedMessages || [];
        // Filter for user messages (exclude system messages)
        const userMsgs = receivedMsgs.filter(m => m.plaintext && !m.plaintext.includes('__mls_type'));
        return { count: userMsgs.length, messages: userMsgs.map(m => ({ groupId: m.groupId, text: m.plaintext })) };
    });
    console.log('    Messages received:', afterAccept.count);
    if (afterAccept.messages.length > 0) {
        console.log('    Content:', afterAccept.messages[0]?.text);
    }

    const hasMsg = afterAccept.count > 0;
    console.log('    ' + (hasMsg ? '✓' : '✗') + ' Messages now visible\n');

    // Summary
    console.log('=== Summary ===');
    const passed = inviteOk && noMsgYet && hasMsg;
    console.log('Invite shown: ' + (inviteOk ? 'YES' : 'NO'));
    console.log('Messages held back: ' + (noMsgYet ? 'YES' : 'NO'));
    console.log('Messages after accept: ' + (hasMsg ? 'YES' : 'NO'));
    console.log('\nOverall: ' + (passed ? '✓ PASS' : '✗ FAIL'));

    if (!passed) {
        console.log('\n=== Relevant Console Logs ===');
        consoleLogs.filter(l => l.includes('MLS') || l.includes('Test') || l.includes('Welcome') ||
            l.includes('invite') || l.includes('pending') || l.includes('Error'))
            .forEach(l => console.log(l));
    }

    await browser.close();
})();
