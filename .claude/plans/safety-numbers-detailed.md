# Safety Numbers / Trust Layer - Detailed Implementation Plan

## Overview

Implement TOFU (Trust on First Use) verification for E2EE messaging. Users can verify contact fingerprints to detect MITM attacks.

---

## Current State

### What Exists
- `coreCryptoClient.getIdentityFingerprint()` - returns user's own fingerprint from WASM
- `SafetyNumbers.js` - modal showing own fingerprint (hex + numeric formats)
- `SafetyNumbersButton` - shield icon in Messages.js header
- Two-phase welcome join: `stageWelcome()` → `acceptStagedWelcome()`
- `getStagedWelcomeInfo(stagingId)` - returns sender identity from welcome
- `vaultService.js` - encrypted IndexedDB storage with granular persistence

### What's Missing
1. Per-contact fingerprint storage in IndexedDB
2. Fingerprint capture on welcome acceptance
3. Fingerprint change detection + warning UI
4. Contact verification status tracking
5. Fingerprint comparison UI (side-by-side)
6. "Verified" badge in conversation list

---

## Implementation Tasks

### Task 1: Add IndexedDB Schema for Contact Fingerprints

**File:** `frontend/src/services/vaultService.js`

**Changes:**
1. Bump `KEYSTORE_DB_VERSION` from 7 to 8
2. Add new object store `contact_fingerprints`
3. Add migration handler for version 8

**Schema:**
```javascript
const CONTACT_FINGERPRINTS_STORE = 'contact_fingerprints';

// Object store structure:
{
  id: 'contact:{contactUserId}',  // keyPath
  contactUserId: number,
  fingerprint: string,           // hex fingerprint
  firstSeenAt: number,           // timestamp
  verifiedAt: number | null,     // null if unverified
  status: 'unverified' | 'verified' | 'changed',
  previousFingerprint: string | null,  // if changed
  encryptedValue: { iv, ciphertext }   // encrypted blob
}
```

**New Methods:**
```javascript
async saveContactFingerprint(contactUserId, fingerprint)
async getContactFingerprint(contactUserId)
async setContactVerified(contactUserId, verified)
async getAllContactFingerprints()
async checkFingerprintChanged(contactUserId, newFingerprint)
```

**Implementation:**
```javascript
// Line ~80 - Add store constant
const CONTACT_FINGERPRINTS_STORE = 'contact_fingerprints';

// Line ~87 - In openDatabase(), add version 8 upgrade handler:
if (event.oldVersion < 8) {
  if (!db.objectStoreNames.contains(CONTACT_FINGERPRINTS_STORE)) {
    const store = db.createObjectStore(CONTACT_FINGERPRINTS_STORE, { keyPath: 'id' });
    store.createIndex('contactUserId', 'contactUserId', { unique: true });
    store.createIndex('status', 'status', { unique: false });
  }
}

// New method ~line 600:
async saveContactFingerprint(contactUserId, fingerprint) {
  const db = await this.openDatabase();
  const record = {
    id: `contact:${contactUserId}`,
    contactUserId,
    fingerprint,
    firstSeenAt: Date.now(),
    verifiedAt: null,
    status: 'unverified',
    previousFingerprint: null
  };

  // Encrypt before storing
  const encrypted = await this.encryptRecord(record);

  return new Promise((resolve, reject) => {
    const tx = db.transaction(CONTACT_FINGERPRINTS_STORE, 'readwrite');
    const store = tx.objectStore(CONTACT_FINGERPRINTS_STORE);
    store.put({ id: record.id, encryptedValue: encrypted });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
```

---

### Task 2: Add Fingerprint Extraction Methods to coreCryptoClient

**File:** `frontend/src/services/mls/coreCryptoClient.js`

**New Methods (after line 1864):**

```javascript
/**
 * Extract fingerprint from a user's identity bytes (from welcome/commit)
 * @param {Uint8Array} identityBytes - The identity credential bytes
 * @returns {string|null} - Hex fingerprint or null
 */
extractFingerprintFromIdentity(identityBytes) {
  if (!identityBytes || identityBytes.length === 0) return null;
  try {
    // Hash the identity bytes to create fingerprint (SHA-256)
    return this.client.hash_identity_to_fingerprint(identityBytes);
  } catch (e) {
    console.error('[MLS] Error extracting fingerprint:', e);
    return null;
  }
}

/**
 * Get stored fingerprint for a contact from vault
 * @param {number} contactUserId
 * @returns {Promise<{fingerprint: string, status: string, verifiedAt: number|null}|null>}
 */
async getContactFingerprint(contactUserId) {
  const vault = await getVaultService();
  return vault.getContactFingerprint(contactUserId);
}

/**
 * Store a contact's fingerprint (TOFU - Trust on First Use)
 * @param {number} contactUserId
 * @param {string} fingerprint - Hex fingerprint
 * @returns {Promise<{isNew: boolean, changed: boolean, previousFingerprint?: string}>}
 */
async recordContactFingerprint(contactUserId, fingerprint) {
  const vault = await getVaultService();
  const existing = await vault.getContactFingerprint(contactUserId);

  if (!existing) {
    // First contact - TOFU
    await vault.saveContactFingerprint(contactUserId, fingerprint);
    console.log(`[MLS] TOFU: Recorded fingerprint for user ${contactUserId}`);
    return { isNew: true, changed: false };
  }

  if (existing.fingerprint !== fingerprint) {
    // FINGERPRINT CHANGED - potential MITM!
    await vault.updateContactFingerprint(contactUserId, fingerprint, existing.fingerprint);
    console.warn(`[MLS] WARNING: Fingerprint changed for user ${contactUserId}!`);
    return { isNew: false, changed: true, previousFingerprint: existing.fingerprint };
  }

  return { isNew: false, changed: false };
}

/**
 * Mark a contact as verified after out-of-band comparison
 * @param {number} contactUserId
 */
async verifyContact(contactUserId) {
  const vault = await getVaultService();
  await vault.setContactVerified(contactUserId, true);
  console.log(`[MLS] Contact ${contactUserId} marked as verified`);
}

/**
 * Get verification status for a contact
 * @param {number} contactUserId
 * @returns {Promise<'unverified'|'verified'|'changed'>}
 */
async getContactVerificationStatus(contactUserId) {
  const vault = await getVaultService();
  const record = await vault.getContactFingerprint(contactUserId);
  return record?.status || 'unverified';
}
```

---

### Task 3: Integrate Fingerprint Capture in Welcome Flow

**File:** `frontend/src/services/mls/coreCryptoClient.js`

**Modify `stageWelcome()` (line ~925):**

```javascript
async stageWelcome(welcomeBytes, ratchetTreeBytes = null) {
  // ... existing code ...

  const info = this.client.get_staged_welcome_info(stagingId);

  // NEW: Extract and record sender fingerprint
  if (info.sender?.identity) {
    const senderFingerprint = this.extractFingerprintFromIdentity(info.sender.identity);
    if (senderFingerprint) {
      const senderUserId = parseInt(new TextDecoder().decode(info.sender.identity), 10);
      const result = await this.recordContactFingerprint(senderUserId, senderFingerprint);

      // Attach fingerprint status to return value for UI
      info.senderFingerprintStatus = result;
      info.senderFingerprint = senderFingerprint;
    }
  }

  return { stagingId, groupId, sender: info.sender, ... };
}
```

**Modify `acceptStagedWelcome()` (line ~968):**

```javascript
async acceptStagedWelcome(stagingId) {
  // ... existing code ...

  // NEW: Also record fingerprints of all group members
  const info = this.getStagedWelcomeInfo(stagingId);
  for (const member of info.members || []) {
    if (member.identity) {
      const fingerprint = this.extractFingerprintFromIdentity(member.identity);
      const userId = parseInt(new TextDecoder().decode(member.identity), 10);
      if (fingerprint && userId !== this.userId) {
        await this.recordContactFingerprint(userId, fingerprint);
      }
    }
  }

  // ... rest of existing code ...
}
```

---

### Task 4: Add Fingerprint Warning Detection

**File:** `frontend/src/services/mls/coreCryptoClient.js`

**New method for checking incoming messages:**

```javascript
/**
 * Check if a message sender's fingerprint has changed
 * Called when processing incoming messages
 * @param {number} senderId
 * @param {Uint8Array} senderIdentity
 * @returns {Promise<{warning: boolean, message?: string}>}
 */
async checkSenderFingerprint(senderId, senderIdentity) {
  if (!senderIdentity) return { warning: false };

  const currentFingerprint = this.extractFingerprintFromIdentity(senderIdentity);
  if (!currentFingerprint) return { warning: false };

  const result = await this.recordContactFingerprint(senderId, currentFingerprint);

  if (result.changed) {
    return {
      warning: true,
      message: `Security warning: ${senderId}'s encryption key has changed. ` +
               `This could indicate a security issue. Please verify their identity.`
    };
  }

  return { warning: false };
}
```

---

### Task 5: Enhance SafetyNumbers.js for Contact Comparison

**File:** `frontend/src/components/SafetyNumbers.js`

**Add new component for contact comparison:**

```javascript
import van from 'vanjs-core';
import coreCryptoClient from '../services/mls/coreCryptoClient.js';

const { div, h3, p, button, span, pre, i } = van.tags;

/**
 * Modal for comparing fingerprints with a specific contact
 */
export function ContactVerificationModal({ contactUserId, contactUsername, onClose, onVerify }) {
  const loading = van.state(true);
  const myFingerprint = van.state('');
  const contactFingerprint = van.state('');
  const verificationStatus = van.state('unverified');
  const error = van.state(null);

  // Load fingerprints
  (async () => {
    try {
      // Get own fingerprint
      const my = coreCryptoClient.getIdentityFingerprint();
      myFingerprint.val = coreCryptoClient.fingerprintToNumeric(my);

      // Get contact's fingerprint from vault
      const contact = await coreCryptoClient.getContactFingerprint(contactUserId);
      if (contact) {
        contactFingerprint.val = coreCryptoClient.fingerprintToNumeric(contact.fingerprint);
        verificationStatus.val = contact.status;
      } else {
        error.val = 'No fingerprint recorded for this contact yet.';
      }
    } catch (e) {
      error.val = e.message;
    } finally {
      loading.val = false;
    }
  })();

  const handleVerify = async () => {
    await coreCryptoClient.verifyContact(contactUserId);
    verificationStatus.val = 'verified';
    onVerify?.();
  };

  return div({ class: "modal-overlay", onclick: (e) => e.target === e.currentTarget && onClose() }, [
    div({ class: "safety-numbers-modal contact-verification" }, [
      div({ class: "modal-header" }, [
        h3(`Verify ${contactUsername}`),
        button({ class: "close-btn", onclick: onClose }, "×")
      ]),

      () => loading.val ? div({ class: "loading" }, "Loading...") :
        error.val ? div({ class: "error" }, error.val) :
        div({ class: "fingerprint-comparison" }, [
          // Your fingerprint
          div({ class: "fingerprint-section yours" }, [
            h4("Your Safety Number"),
            pre({ class: "fingerprint-display" }, myFingerprint.val)
          ]),

          // Contact's fingerprint
          div({ class: "fingerprint-section theirs" }, [
            h4(`${contactUsername}'s Safety Number`),
            pre({ class: "fingerprint-display" }, contactFingerprint.val),
            () => verificationStatus.val === 'changed' ?
              div({ class: "warning-banner" }, [
                i({ class: "icon-warning" }),
                span("This contact's safety number has changed!")
              ]) : null
          ]),

          // Verification status
          div({ class: "verification-status" }, [
            () => verificationStatus.val === 'verified' ?
              div({ class: "verified-badge" }, [
                i({ class: "icon-check" }),
                span("Verified")
              ]) :
              div({ class: "verify-prompt" }, [
                p("Compare these numbers with your contact over a secure channel (in person, video call, etc.)"),
                p("If they match, tap 'Mark as Verified' to confirm."),
                button({
                  class: "btn-primary verify-btn",
                  onclick: handleVerify
                }, "Mark as Verified")
              ])
          ])
        ])
    ])
  ]);
}

/**
 * Small verification badge for conversation list
 */
export function VerificationBadge({ contactUserId }) {
  const status = van.state('loading');

  coreCryptoClient.getContactVerificationStatus(contactUserId)
    .then(s => status.val = s)
    .catch(() => status.val = 'unknown');

  return () => {
    switch (status.val) {
      case 'verified':
        return span({ class: "verification-badge verified", title: "Verified" }, "✓");
      case 'changed':
        return span({ class: "verification-badge warning", title: "Key changed!" }, "⚠");
      case 'unverified':
        return span({ class: "verification-badge unverified", title: "Not verified" }, "");
      default:
        return null;
    }
  };
}
```

---

### Task 6: Update Messages.js UI

**File:** `frontend/src/pages/Messages.js`

**Changes:**

1. **Add verification badge to conversation list items (line ~400):**

```javascript
// In conversation list item render
import { VerificationBadge, ContactVerificationModal } from '../components/SafetyNumbers.js';

// In the conversation item:
li({ class: "conversation-item", ... }, [
  div({ class: "conversation-info" }, [
    span({ class: "conversation-name" }, conv.name),
    // NEW: Add verification badge for DMs
    conv.isDm ? VerificationBadge({ contactUserId: conv.otherUserId }) : null
  ]),
  // ... rest
])
```

2. **Add "Verify Contact" button to chat header (line ~525):**

```javascript
div({ class: "chat-header-actions" }, [
  SafetyNumbersButton(),  // Existing - shows own
  // NEW: Add contact verification for DMs
  isDm ? button({
    class: "btn-verify-contact",
    onclick: () => showContactVerification.val = true,
    title: "Verify contact"
  }, [i({ class: "icon-shield-check" }), "Verify"]) : null,
  // ... rest
])
```

3. **Add fingerprint change warning banner (new, after chat header):**

```javascript
// State for fingerprint warning
const fingerprintWarning = van.state(null);

// Listen for fingerprint changes
messagingStore.onFingerprintWarning = (warning) => {
  fingerprintWarning.val = warning;
};

// Render warning banner
() => fingerprintWarning.val ?
  div({ class: "fingerprint-warning-banner" }, [
    i({ class: "icon-warning" }),
    span(fingerprintWarning.val.message),
    button({ onclick: () => fingerprintWarning.val = null }, "Dismiss")
  ]) : null
```

---

### Task 7: Add CSS Styles

**File:** `frontend/styles.css`

```css
/* Safety Numbers / Verification Styles */
.contact-verification .fingerprint-comparison {
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
}

.fingerprint-section {
  padding: 1rem;
  border-radius: 8px;
  background: var(--bg-secondary);
}

.fingerprint-section.yours {
  border-left: 4px solid var(--primary);
}

.fingerprint-section.theirs {
  border-left: 4px solid var(--accent);
}

.fingerprint-display {
  font-family: monospace;
  font-size: 1.2rem;
  letter-spacing: 2px;
  word-break: break-all;
  padding: 0.5rem;
  background: var(--bg-tertiary);
  border-radius: 4px;
}

.verification-badge {
  display: inline-flex;
  align-items: center;
  margin-left: 0.5rem;
  font-size: 0.8rem;
}

.verification-badge.verified {
  color: var(--success);
}

.verification-badge.warning {
  color: var(--warning);
  animation: pulse 1.5s infinite;
}

.warning-banner {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.75rem 1rem;
  background: var(--warning-bg);
  color: var(--warning);
  border-radius: 4px;
  margin-top: 0.5rem;
}

.fingerprint-warning-banner {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.75rem 1rem;
  background: var(--error-bg);
  color: var(--error);
  border-radius: 4px;
  margin-bottom: 0.5rem;
}

.verify-btn {
  margin-top: 1rem;
}

.verified-badge {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  color: var(--success);
  font-weight: 500;
}

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
}
```

---

## Testing Plan

### Unit Tests

1. **vaultService tests:**
   - `saveContactFingerprint()` stores encrypted data
   - `getContactFingerprint()` retrieves and decrypts
   - `checkFingerprintChanged()` detects changes
   - `setContactVerified()` updates status

2. **coreCryptoClient tests:**
   - `extractFingerprintFromIdentity()` returns valid hex
   - `recordContactFingerprint()` handles TOFU correctly
   - `recordContactFingerprint()` detects changes

### E2E Tests

**New test file:** `tests/e2e/safety-numbers.spec.js`

```javascript
test('should record contact fingerprint on first message', async () => {
  // User1 sends message to User2
  // Verify User2's vault contains User1's fingerprint
});

test('should show verification badge after verifying contact', async () => {
  // User1 verifies User2
  // Check for verified badge in UI
});

test('should show warning when fingerprint changes', async () => {
  // Simulate fingerprint change (e.g., user reinstalls)
  // Verify warning banner appears
});
```

---

## Implementation Order

1. **Task 1**: IndexedDB schema (vaultService.js) - Foundation
2. **Task 2**: Fingerprint methods (coreCryptoClient.js) - Core logic
3. **Task 3**: Welcome flow integration - Capture fingerprints
4. **Task 4**: Warning detection - Security feature
5. **Task 5**: SafetyNumbers.js enhancement - Comparison UI
6. **Task 6**: Messages.js UI updates - User-facing
7. **Task 7**: CSS styles - Polish

---

## Files Modified Summary

| File | Changes |
|------|---------|
| `frontend/src/services/vaultService.js` | +IndexedDB store, +5 methods |
| `frontend/src/services/mls/coreCryptoClient.js` | +6 methods, modify stageWelcome/acceptStagedWelcome |
| `frontend/src/components/SafetyNumbers.js` | +ContactVerificationModal, +VerificationBadge |
| `frontend/src/pages/Messages.js` | +verification badges, +verify button, +warning banner |
| `frontend/styles.css` | +verification styles |
| `tests/e2e/safety-numbers.spec.js` | New test file |

---

## Success Criteria

1. First message to a contact stores their fingerprint (TOFU)
2. Users can view and compare fingerprints with contacts
3. Users can mark contacts as "verified" after out-of-band comparison
4. Verified badge shows in conversation list
5. Warning banner appears if fingerprint changes
6. All data encrypted in IndexedDB
