# MLS Welcome Credential Validation Bug - RESOLVED

## Issue Summary
~~Messages sent via MLS are encrypted locally and displayed for the sender, but are NOT being stored in the relay queue for the recipient.~~

**RESOLVED**: Three bugs were found and fixed on 2026-01-04.

---

## Bugs Found and Fixes Applied

### Bug 1: Regex Escaping in groupIdFromBytes
**File**: `frontend/src/services/mls/coreCryptoClient.js`
**Line**: 69

The regex `/^dm_\\d+_\\d+$/` used `\\d` which matches literal backslash+d, not digits. This caused DM group IDs like `dm_55_56` to not be recognized, falling back to hex encoding.

**Fix**: Changed to `/^dm_\d+_\d+$/`

### Bug 2: KeyPackage Not Saved to Vault After Regeneration
**File**: `frontend/src/services/mls/coreCryptoClient.js`
**Function**: `regenerateKeyPackage()`

When a KeyPackage was regenerated, the new private key wasn't being saved to the vault. This caused `NoMatchingKeyPackage` errors when the client tried to process a Welcome that used the new KeyPackage.

**Fix**: Added `vaultService.saveCurrentState()` call after regenerating KeyPackage.

### Bug 3: StagedWelcome Consumed KeyPackage in Two-Phase Join
**File**: `openmls-wasm/src/lib.rs`
**Functions**: `stage_welcome()`, `accept_staged_welcome()`

The `stage_welcome()` function created a `StagedWelcome` object (which consumes the KeyPackage from OpenMLS storage), but only stored the raw welcome bytes. When `accept_staged_welcome()` tried to recreate the `StagedWelcome` from bytes, the KeyPackage was already consumed.

**Fix**: Store the actual `StagedWelcome` object in `PendingStagedWelcome` struct and use it directly in `accept_staged_welcome()`.

---

## Test Script (Working)

```javascript
async (page) => {
  const browser = page.context().browser();
  const results = {};

  // IMPORTANT: Separate browser contexts for isolated localStorage/IndexedDB
  const aliceContext = await browser.newContext();
  const alicePage = await aliceContext.newPage();
  const bobContext = await browser.newContext();
  const bobPage = await bobContext.newPage();

  // Register helper
  async function register(p, username, email, password) {
    await p.goto('http://localhost:5173/#signup');
    await p.fill('input[placeholder="Choose a username"]', username);
    await p.fill('input[placeholder="Enter your email"]', email);
    await p.fill('input[placeholder="Choose a password"]', password);
    await p.fill('input[placeholder="Confirm your password"]', password);
    await p.click('button:has-text("Create Account")');
    await p.waitForSelector('.home-page', { timeout: 15000 });
    await p.waitForTimeout(4000);
  }

  // Register both users
  await register(alicePage, 'e2e_alice', 'e2e_alice@test.com', 'testpass123');
  await register(bobPage, 'e2e_bob', 'e2e_bob@test.com', 'testpass123');

  // Alice creates DM with Bob
  await alicePage.goto('http://localhost:5173/#messages');
  await alicePage.waitForTimeout(2000);
  await alicePage.click('button:has-text("+ New")');
  await alicePage.waitForTimeout(500);
  await alicePage.fill('input[placeholder*="Search users"]', 'e2e_bob');
  await alicePage.waitForTimeout(1000);
  await alicePage.click('li:has-text("e2e_bob")');
  await alicePage.click('button:has-text("Start DM")');
  await alicePage.waitForTimeout(3000);

  // Send message
  await alicePage.fill('.message-textarea', 'Hello Bob from Alice!');
  await alicePage.click('.send-button');
  await alicePage.waitForTimeout(3000);

  // Check Alice sees her message
  const aliceSent = await alicePage.$('.message-item.sent .message-text');
  results.aliceSentMessage = aliceSent ? await aliceSent.textContent() : null;

  // Bob opens messages
  await bobPage.goto('http://localhost:5173/#messages');
  await bobPage.waitForTimeout(3000);

  const bobDm = await bobPage.$('li:has-text("e2e_alice")');
  if (bobDm) {
    await bobDm.click();
    await bobPage.waitForTimeout(2000);
    results.bobFoundDm = true;

    const bobReceived = await bobPage.$('.message-item.received .message-text');
    results.bobReceivedMessage = bobReceived ? await bobReceived.textContent() : null;
  }

  await aliceContext.close();
  await bobContext.close();

  return results;
}
```

## Expected Result (Now Working)

```json
{
  "aliceSentMessage": "Hello Bob from Alice!",
  "bobFoundDm": true,
  "bobReceivedMessage": "Hello Bob from Alice!"
}
```
