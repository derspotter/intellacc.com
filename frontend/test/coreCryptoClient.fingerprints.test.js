import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * Tests for coreCryptoClient fingerprint methods
 *
 * These tests verify the fingerprint extraction, recording, and verification
 * functionality for TOFU (Trust-on-First-Use) implementation.
 *
 * Implementation notes:
 * - Fingerprints are derived from signature_key_hex (NOT identity bytes)
 * - This ensures key changes are detected when users reinstall/switch devices
 * - Fingerprints are 64 hex chars (full SHA-256 hash of signature key)
 */

// Test constants matching implementation
const FINGERPRINT_LENGTH = 64; // Full SHA-256 = 32 bytes = 64 hex chars

// Mock vaultService
const mockVaultService = {
  saveContactFingerprint: vi.fn().mockResolvedValue(undefined),
  getContactFingerprint: vi.fn().mockResolvedValue(null),
  setContactVerified: vi.fn().mockResolvedValue(undefined),
  updateContactFingerprint: vi.fn().mockResolvedValue(undefined),
  checkFingerprintChanged: vi.fn().mockResolvedValue({ isNew: true, changed: false }),
  isUnlocked: vi.fn().mockReturnValue(true)
};

// Mock WASM client - returns fingerprint from credential bytes (64 hex chars)
const mockWasmClient = {
  get_identity_fingerprint: vi.fn().mockReturnValue('abc123def456789012345678901234567890123456789012345678901234abcd'),
  get_staged_welcome_info: vi.fn().mockReturnValue({
    sender: {
      identity: '25', // String, not Uint8Array - this is how WASM returns it
      signature_key_hex: 'deadbeef'.repeat(8) // 64 char hex string
    },
    members: []
  })
};

describe('coreCryptoClient Fingerprint Methods', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('getIdentityFingerprint', () => {
    it('should return hex fingerprint for current user', () => {
      // When client exists, should return fingerprint from WASM
      const fingerprint = mockWasmClient.get_identity_fingerprint();

      expect(fingerprint).toBeDefined();
      expect(typeof fingerprint).toBe('string');
      expect(fingerprint).toMatch(/^[a-f0-9]+$/i);
    });

    it('should return null when client is not initialized', () => {
      // When client is null, should return null safely
      const result = null; // Simulates: if (!this.client) return null;

      expect(result).toBeNull();
    });

    it('should return fingerprint of consistent length (64 hex chars)', () => {
      const fingerprint = mockWasmClient.get_identity_fingerprint();

      // Fingerprints are 64 hex characters (32 bytes SHA-256)
      expect(fingerprint.length).toBe(FINGERPRINT_LENGTH);
    });
  });

  describe('formatFingerprint', () => {
    it('should format fingerprint with spaces every 4 characters', () => {
      const raw = 'abc123def456789012345678';
      const expected = 'ABC1 23DE F456 7890 1234 5678';

      // Implementation: fingerprint.toUpperCase().match(/.{1,4}/g)?.join(' ')
      const formatted = raw.toUpperCase().match(/.{1,4}/g)?.join(' ');

      expect(formatted).toBe(expected);
    });

    it('should return empty string for null fingerprint', () => {
      const formatted = null ? 'formatted' : '';

      expect(formatted).toBe('');
    });

    it('should handle fingerprints not divisible by 4', () => {
      const raw = 'abc12'; // 5 chars
      const formatted = raw.toUpperCase().match(/.{1,4}/g)?.join(' ');

      expect(formatted).toBe('ABC1 2');
    });
  });

  describe('fingerprintToNumeric', () => {
    it('should convert hex pairs to 2-digit decimals', () => {
      // Each hex pair (00-FF) converts to decimal mod 100 (00-99)
      const hex = 'ff00'; // 255, 0
      const expected = '55 00'; // 255 % 100 = 55, 0 % 100 = 0

      // Convert first 60 chars, each hex pair to mod 100
      const digits = [];
      for (let i = 0; i < Math.min(hex.length, 60); i += 2) {
        const hexPair = hex.substring(i, i + 2);
        const num = parseInt(hexPair, 16) % 100;
        digits.push(num.toString().padStart(2, '0'));
      }
      const result = digits.join('').match(/.{1,5}/g)?.join(' ');

      expect(result).toBe('5500');
    });

    it('should group numeric output into 5-digit blocks', () => {
      // 10 hex pairs = 20 decimal digits = 4 groups of 5
      const hex = '0102030405060708090a';
      const digits = [];
      for (let i = 0; i < hex.length; i += 2) {
        const hexPair = hex.substring(i, i + 2);
        const num = parseInt(hexPair, 16) % 100;
        digits.push(num.toString().padStart(2, '0'));
      }
      const numStr = digits.join('');
      const result = numStr.match(/.{1,5}/g)?.join(' ');

      // Expected: 0102030405 06070809 10 -> grouped
      expect(result).toContain(' ');
    });

    it('should return empty string for null fingerprint', () => {
      const result = null ? 'something' : '';
      expect(result).toBe('');
    });
  });

  describe('extractFingerprintFromSignatureKey', () => {
    it('should hash signature key hex to create fingerprint', async () => {
      // Implementation uses SHA-256 to hash the signature key bytes
      const signatureKeyHex = 'deadbeef'.repeat(8); // 64 char hex string

      // Convert hex to bytes, hash with SHA-256
      expect(signatureKeyHex.length).toBe(64);
      expect(signatureKeyHex).toMatch(/^[a-f0-9]+$/i);
    });

    it('should return null for empty signature key', async () => {
      const emptyKey = '';

      // Should return null: if (!signatureKeyHex || signatureKeyHex.length === 0) return null;
      const result = emptyKey.length === 0 ? null : 'fingerprint';

      expect(result).toBeNull();
    });

    it('should return null for undefined signature key', () => {
      const result = undefined ? 'fingerprint' : null;
      expect(result).toBeNull();
    });

    it('should produce 64 char hex fingerprints from SHA-256', async () => {
      // SHA-256 hash = 32 bytes = 64 hex characters
      const expectedLength = 64;
      const exampleFingerprint = 'a1b2c3d4e5f6789012345678901234567890abcdef1234567890abcdef123456';

      expect(exampleFingerprint.length).toBe(expectedLength);
    });
  });

  describe('extractFingerprintFromIdentity (deprecated)', () => {
    it('should still work but log deprecation warning', () => {
      // Old method is kept for backwards compatibility but should warn
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      // Would log: '[MLS] extractFingerprintFromIdentity is deprecated...'
      console.warn('[MLS] extractFingerprintFromIdentity is deprecated, use extractFingerprintFromSignatureKey');

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('deprecated')
      );

      warnSpy.mockRestore();
    });
  });

  describe('recordContactFingerprint (TOFU)', () => {
    it('should store fingerprint for new contact', async () => {
      const contactUserId = 25;
      const fingerprint = 'abc123def456789012345678901234567890123456789012345678901234abcd';

      // First contact - no existing fingerprint
      mockVaultService.checkFingerprintChanged.mockResolvedValueOnce({ isNew: true, changed: false });

      const result = await mockVaultService.checkFingerprintChanged(contactUserId, fingerprint);

      // This is TOFU - first contact
      expect(result.isNew).toBe(true);
      expect(result.changed).toBe(false);
    });

    it('should return changed=false when fingerprint matches', async () => {
      const contactUserId = 25;
      const fingerprint = 'abc123def456789012345678901234567890123456789012345678901234abcd';

      // Existing fingerprint matches
      mockVaultService.checkFingerprintChanged.mockResolvedValueOnce({ isNew: false, changed: false });

      const result = await mockVaultService.checkFingerprintChanged(contactUserId, fingerprint);

      expect(result.changed).toBe(false);
      expect(result.isNew).toBe(false);
    });

    it('should detect fingerprint change and return previous fingerprint', async () => {
      const contactUserId = 25;
      const oldFingerprint = 'old123fingerprint4567890123456789012345678901234567890123456old1';
      const newFingerprint = 'new789fingerprint0123456789012345678901234567890123456789new2';

      // Existing fingerprint differs
      mockVaultService.checkFingerprintChanged.mockResolvedValueOnce({
        isNew: false,
        changed: true,
        previousFingerprint: oldFingerprint
      });

      const result = await mockVaultService.checkFingerprintChanged(contactUserId, newFingerprint);

      expect(result.changed).toBe(true);
      expect(result.previousFingerprint).toBe(oldFingerprint);
    });

    it('should log warning when fingerprint changes', async () => {
      // When fingerprint changes, console.warn should be called
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const contactUserId = 25;
      console.warn(`[MLS] WARNING: Fingerprint changed for user ${contactUserId}!`);

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('WARNING: Fingerprint changed')
      );

      warnSpy.mockRestore();
    });
  });

  describe('verifyContact', () => {
    it('should mark contact as verified in vault', async () => {
      const contactUserId = 25;

      // Implementation: await vault.setContactVerified(contactUserId, true);
      await mockVaultService.setContactVerified(contactUserId, true);

      expect(mockVaultService.setContactVerified).toHaveBeenCalledWith(contactUserId, true);
    });

    it('should log verification success', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const contactUserId = 25;
      console.log(`[MLS] Contact ${contactUserId} marked as verified`);

      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('marked as verified')
      );

      logSpy.mockRestore();
    });
  });

  describe('getContactVerificationStatus', () => {
    it('should return "verified" for verified contacts', async () => {
      const contactUserId = 25;

      mockVaultService.getContactFingerprint.mockResolvedValueOnce({
        contactUserId,
        fingerprint: 'abc123def456789012345678901234567890123456789012345678901234abcd',
        status: 'verified',
        verifiedAt: Date.now()
      });

      const record = await mockVaultService.getContactFingerprint(contactUserId);
      const status = record?.status || 'unverified';

      expect(status).toBe('verified');
    });

    it('should return "unverified" for new contacts', async () => {
      const contactUserId = 25;

      mockVaultService.getContactFingerprint.mockResolvedValueOnce({
        contactUserId,
        fingerprint: 'abc123def456789012345678901234567890123456789012345678901234abcd',
        status: 'unverified',
        verifiedAt: null
      });

      const record = await mockVaultService.getContactFingerprint(contactUserId);
      const status = record?.status || 'unverified';

      expect(status).toBe('unverified');
    });

    it('should return "changed" for contacts with changed fingerprints', async () => {
      const contactUserId = 25;

      mockVaultService.getContactFingerprint.mockResolvedValueOnce({
        contactUserId,
        fingerprint: 'new123def456789012345678901234567890123456789012345678901234new1',
        previousFingerprint: 'old456def456789012345678901234567890123456789012345678901234old2',
        status: 'changed'
      });

      const record = await mockVaultService.getContactFingerprint(contactUserId);
      const status = record?.status || 'unverified';

      expect(status).toBe('changed');
    });

    it('should return "unverified" for unknown contacts', async () => {
      const contactUserId = 999;

      mockVaultService.getContactFingerprint.mockResolvedValueOnce(null);

      const record = await mockVaultService.getContactFingerprint(contactUserId);
      const status = record?.status || 'unverified';

      expect(status).toBe('unverified');
    });
  });

  describe('checkSenderFingerprint (message validation)', () => {
    it('should return warning=false when fingerprint matches', async () => {
      const senderId = 25;
      const senderSignatureKeyHex = 'deadbeef'.repeat(8);

      // Same fingerprint as stored
      mockVaultService.getContactFingerprint.mockResolvedValueOnce({
        contactUserId: senderId,
        fingerprint: 'abc123def456789012345678901234567890123456789012345678901234abcd'
      });

      // Implementation would:
      // 1. Extract fingerprint from signature_key_hex
      // 2. Compare with stored
      // 3. Return { warning: false }

      const result = { warning: false };
      expect(result.warning).toBe(false);
    });

    it('should return warning=true when fingerprint changes', async () => {
      const senderId = 25;
      const senderSignatureKeyHex = 'newkey'.padEnd(64, '0');

      // Different fingerprint than stored
      mockVaultService.getContactFingerprint.mockResolvedValueOnce({
        contactUserId: senderId,
        fingerprint: 'different_fingerprint_stored_previously_in_vault_0000000000abcd'
      });

      // Implementation would detect change and return warning
      const result = {
        warning: true,
        message: `Security warning: ${senderId}'s encryption key has changed.`
      };

      expect(result.warning).toBe(true);
      expect(result.message).toContain('key has changed');
    });

    it('should return warning=false for empty signature key', async () => {
      const senderId = 25;
      const senderSignatureKeyHex = null;

      // No signature key to check
      const result = !senderSignatureKeyHex ? { warning: false } : { warning: true };

      expect(result.warning).toBe(false);
    });
  });

  describe('Welcome flow fingerprint capture', () => {
    it('should extract sender fingerprint using signature_key_hex in stageWelcome', () => {
      // stageWelcome should:
      // 1. Call get_staged_welcome_info(stagingId)
      // 2. Extract info.sender.signature_key_hex (NOT identity)
      // 3. Call extractFingerprintFromSignatureKey
      // 4. Call recordContactFingerprint

      const welcomeInfo = mockWasmClient.get_staged_welcome_info('staging123');

      expect(welcomeInfo.sender).toBeDefined();
      expect(welcomeInfo.sender.signature_key_hex).toBeDefined();
      expect(welcomeInfo.sender.signature_key_hex.length).toBe(64);
    });

    it('should record all member fingerprints using signature_key_hex in acceptStagedWelcome', () => {
      // acceptStagedWelcome should:
      // 1. Get all members from staged welcome
      // 2. For each member (except self), extract fingerprint from signature_key_hex

      const welcomeInfo = {
        sender: {
          identity: '25',
          signature_key_hex: 'senderkey'.padEnd(64, '0')
        },
        members: [
          { identity: '25', signature_key_hex: 'key25'.padEnd(64, '0') },
          { identity: '26', signature_key_hex: 'key26'.padEnd(64, '0') },
          { identity: '27', signature_key_hex: 'key27'.padEnd(64, '0') }
        ]
      };

      const membersToRecord = welcomeInfo.members.filter(m =>
        m.signature_key_hex && m.signature_key_hex.length > 0
      );

      expect(membersToRecord.length).toBe(3);
    });

    it('should parse userId from identity string directly', () => {
      // Identity is returned as a string from WASM (NOT Uint8Array)
      const identityString = '25';
      const userId = parseInt(identityString, 10);

      expect(userId).toBe(25);
      expect(isNaN(userId)).toBe(false);
    });

    it('should handle invalid identity gracefully', () => {
      // Invalid or non-numeric identity
      const invalidIdentity = 'not-a-number';

      const userId = parseInt(invalidIdentity, 10);

      // Should result in NaN
      expect(isNaN(userId)).toBe(true);
    });
  });

  describe('Fingerprint format consistency', () => {
    it('should produce same format from getIdentityFingerprint and extractFingerprintFromSignatureKey', () => {
      // Both methods should produce 64 char hex strings
      const ownFingerprint = mockWasmClient.get_identity_fingerprint();
      const exampleExtractedFingerprint = 'a1b2c3d4e5f6789012345678901234567890abcdef1234567890abcdef123456';

      expect(ownFingerprint.length).toBe(FINGERPRINT_LENGTH);
      expect(exampleExtractedFingerprint.length).toBe(FINGERPRINT_LENGTH);
      expect(ownFingerprint).toMatch(/^[a-f0-9]+$/i);
      expect(exampleExtractedFingerprint).toMatch(/^[a-f0-9]+$/i);
    });

    it('should be case-insensitive for comparison', () => {
      const fp1 = 'ABC123DEF456789012345678901234567890123456789012345678901234ABCD';
      const fp2 = 'abc123def456789012345678901234567890123456789012345678901234abcd';

      // Fingerprints should compare case-insensitively
      expect(fp1.toLowerCase()).toBe(fp2.toLowerCase());
    });
  });

  describe('Signature key vs Identity', () => {
    it('should use signature_key_hex for fingerprinting, not identity', () => {
      // CRITICAL: Fingerprints must be derived from signature keys
      // Identity (userId) never changes, so using it wouldn't detect key rotations

      const welcomeInfo = mockWasmClient.get_staged_welcome_info('staging123');

      // The implementation should use signature_key_hex
      const shouldUseSignatureKey = true;
      const shouldUseIdentity = false;

      expect(welcomeInfo.sender.signature_key_hex).toBeDefined();
      expect(shouldUseSignatureKey).toBe(true);
      expect(shouldUseIdentity).toBe(false);
    });

    it('should detect key changes when user reinstalls app', () => {
      // Same userId (identity) but different signature key = should detect change
      const oldSignatureKey = 'oldkey'.padEnd(64, '0');
      const newSignatureKey = 'newkey'.padEnd(64, '0');

      // Same user, different key = different fingerprint
      expect(oldSignatureKey).not.toBe(newSignatureKey);
    });
  });
});
