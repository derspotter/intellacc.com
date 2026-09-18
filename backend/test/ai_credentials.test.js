// Credential encryption: dedicated secret (fail closed), per-user AAD,
// tamper detection, and settings responses that never expose key material.
jest.mock('../src/db', () => require('./ai_test_helpers').createFakeDb());

const crypto = require('crypto');
const { TEST_SECRET } = require('./ai_test_helpers');
const db = require('../src/db');

const KEY = 'sk-live-abcdef1234567890XYZ';
const flipChar = (value, index) => {
  const char = value[index] === 'A' ? 'B' : 'A';
  return value.slice(0, index) + char + value.slice(index + 1);
};

describe('credentialCrypto', () => {
  const cryptoModule = require('../src/services/ai/credentialCrypto');
  beforeEach(() => { process.env.AI_CREDENTIAL_SECRET = TEST_SECRET; });

  test('is unavailable without a dedicated 32-byte base64 secret (no fallback)', () => {
    process.env.JWT_SECRET = 'a-jwt-secret-that-must-not-be-used-as-fallback';
    delete process.env.AI_CREDENTIAL_SECRET;
    expect(cryptoModule.isAvailable()).toBe(false);
    expect(() => cryptoModule.encryptCredential(KEY, 1)).toThrow(/not configured/);
    process.env.AI_CREDENTIAL_SECRET = crypto.randomBytes(16).toString('base64');
    expect(cryptoModule.isAvailable()).toBe(false);
    process.env.AI_CREDENTIAL_SECRET = 'not base64 at all!!';
    expect(cryptoModule.isAvailable()).toBe(false);
    process.env.AI_CREDENTIAL_SECRET = TEST_SECRET;
    expect(cryptoModule.isAvailable()).toBe(true);
  });

  test('round-trips for the owning user only', () => {
    const ciphertext = cryptoModule.encryptCredential(KEY, 7);
    expect(ciphertext).not.toContain(KEY);
    expect(ciphertext.startsWith('v1.')).toBe(true);
    expect(cryptoModule.decryptCredential(ciphertext, 7)).toBe(KEY);
    expect(() => cryptoModule.decryptCredential(ciphertext, 8)).toThrow();
    expect(() => cryptoModule.decryptCredential(ciphertext, 0)).toThrow();
  });

  test('fresh IV per encryption and tampering with any part fails', () => {
    const a = cryptoModule.encryptCredential(KEY, 7);
    const b = cryptoModule.encryptCredential(KEY, 7);
    expect(a).not.toBe(b);
    const [version, iv, tag, data] = a.split('.');
    expect(() => cryptoModule.decryptCredential([version, iv, tag, flipChar(data, 2)].join('.'), 7)).toThrow();
    expect(() => cryptoModule.decryptCredential([version, iv, flipChar(tag, 2), data].join('.'), 7)).toThrow();
    expect(() => cryptoModule.decryptCredential([version, flipChar(iv, 2), tag, data].join('.'), 7)).toThrow();
    expect(() => cryptoModule.decryptCredential(`v0.${iv}.${tag}.${data}`, 7)).toThrow();
    expect(() => cryptoModule.decryptCredential('garbage', 7)).toThrow();
  });

  test('a secret rotation makes old ciphertext unreadable rather than silently wrong', () => {
    const ciphertext = cryptoModule.encryptCredential(KEY, 7);
    process.env.AI_CREDENTIAL_SECRET = crypto.randomBytes(32).toString('base64');
    expect(() => cryptoModule.decryptCredential(ciphertext, 7)).toThrow();
  });
});

describe('aiSettingsService', () => {
  const settings = require('../src/services/ai/aiSettingsService');
  const ALICE = 1;
  const BOB = 2;
  beforeEach(() => {
    process.env.AI_CREDENTIAL_SECRET = TEST_SECRET;
    db.state.settings.clear();
  });

  test('unconfigured user sees defaults and availability', async () => {
    expect(await settings.getSettings(ALICE)).toEqual({
      configured: false, provider: 'openrouter', model: '', keyHint: '', publicReplies: false, available: true
    });
    delete process.env.AI_CREDENTIAL_SECRET;
    expect((await settings.getSettings(ALICE)).available).toBe(false);
    await expect(settings.saveSettings(ALICE, { provider: 'openai', model: 'm', apiKey: KEY, publicReplies: false }))
      .rejects.toMatchObject({ status: 503 });
  });

  test('saves ciphertext only and describes with a hint, never the key', async () => {
    const result = await settings.saveSettings(ALICE, { provider: 'openai', model: 'gpt-test', apiKey: KEY, publicReplies: true });
    expect(result).toEqual({ configured: true, provider: 'openai', model: 'gpt-test', keyHint: '…0XYZ', publicReplies: true, available: true });
    expect(JSON.stringify(result)).not.toContain(KEY);
    const row = db.state.settings.get(ALICE);
    expect(row.key_ciphertext).not.toContain(KEY);
    expect(row.key_ciphertext.startsWith('v1.')).toBe(true);
    expect(JSON.stringify(await settings.getSettings(ALICE))).not.toContain(row.key_ciphertext);
    expect(await settings.loadCredentials(ALICE)).toEqual({ provider: 'openai', model: 'gpt-test', apiKey: KEY, publicReplies: true });
  });

  test('omitted key is retained for the same provider but required when switching', async () => {
    await settings.saveSettings(ALICE, { provider: 'openai', model: 'gpt-test', apiKey: KEY, publicReplies: false });
    const before = db.state.settings.get(ALICE).key_ciphertext;
    const same = await settings.saveSettings(ALICE, { provider: 'openai', model: 'gpt-other', publicReplies: true });
    expect(same).toMatchObject({ configured: true, model: 'gpt-other', publicReplies: true, keyHint: '…0XYZ' });
    expect(db.state.settings.get(ALICE).key_ciphertext).toBe(before);
    await expect(settings.saveSettings(ALICE, { provider: 'anthropic', model: 'claude-x', apiKey: '', publicReplies: true }))
      .rejects.toMatchObject({ status: 400, message: /apiKey is required/ });
    expect(db.state.settings.get(ALICE).provider).toBe('openai');
  });

  test('input validation', async () => {
    const ok = { provider: 'openai', model: 'gpt-test', apiKey: KEY, publicReplies: false };
    await expect(settings.saveSettings(ALICE, { ...ok, provider: 'gemini' })).rejects.toMatchObject({ status: 400 });
    await expect(settings.saveSettings(ALICE, { ...ok, model: 'has space' })).rejects.toMatchObject({ status: 400 });
    await expect(settings.saveSettings(ALICE, { ...ok, model: '' })).rejects.toMatchObject({ status: 400 });
    await expect(settings.saveSettings(ALICE, { ...ok, publicReplies: 'yes' })).rejects.toMatchObject({ status: 400 });
    await expect(settings.saveSettings(ALICE, { ...ok, apiKey: 'short' })).rejects.toMatchObject({ status: 400 });
    await expect(settings.saveSettings(ALICE, { ...ok, apiKey: 'has white space in it' })).rejects.toMatchObject({ status: 400 });
    expect(db.state.settings.has(ALICE)).toBe(false);
  });

  test("a ciphertext copied from another user's row cannot be decrypted (per-user AAD)", async () => {
    await settings.saveSettings(ALICE, { provider: 'openai', model: 'gpt-test', apiKey: KEY, publicReplies: false });
    db.state.settings.set(BOB, { ...db.state.settings.get(ALICE), user_id: BOB });
    await expect(settings.loadCredentials(BOB)).rejects.toMatchObject({ code: 'not_configured' });
    expect(await settings.loadCredentials(ALICE)).toMatchObject({ apiKey: KEY });
  });

  test('delete removes the credential and inference reports not configured', async () => {
    await settings.saveSettings(ALICE, { provider: 'openai', model: 'gpt-test', apiKey: KEY, publicReplies: false });
    await settings.deleteSettings(ALICE);
    expect((await settings.getSettings(ALICE)).configured).toBe(false);
    expect(await settings.loadCredentials(ALICE)).toBeNull();
  });
});
