/**
 * WhatsApp OTP channel (spec: docs/superpowers/specs/2026-07-14-whatsapp-otp-channel-design.md,
 * unparked 2026-09-02 with host-bridge transport).
 *
 * The service must expose a user-selectable channel ('sms' default, 'whatsapp'
 * via the host wacli bridge) with NO cross-channel fallback, and report
 * channel availability as { sms, whatsapp } in the provider status.
 */

jest.mock('axios');
const axios = require('axios');
const db = require('../src/db');

jest.setTimeout(30000);

const BRIDGE_URL = 'http://172.19.0.1:8790';
const BRIDGE_TOKEN = 'test-bridge-token';

describe('phone verification channels', () => {
  let phoneVerificationService;
  const cleanup = { userIds: [] };
  let userSeq = 0;

  const createVerifiedUser = async () => {
    userSeq += 1;
    const unique = `${Date.now()}_${userSeq}_${Math.floor(Math.random() * 10000)}`;
    const result = await db.query(`
      INSERT INTO users (username, email, password_hash, verification_tier)
      VALUES ($1, $2, 'x', 1)
      RETURNING id
    `, [`waotp_${unique}`, `waotp_${unique}@example.com`]);
    const id = result.rows[0].id;
    cleanup.userIds.push(id);
    return id;
  };

  const freshPhone = () => {
    userSeq += 1;
    // 13 digits total — inside the 8..15 E.164 window
    return `+49151${String(Date.now()).slice(-6)}${String(100 + userSeq).slice(-2)}`;
  };

  let savedNodeEnv;
  let savedSocket;

  beforeAll(() => {
    savedNodeEnv = process.env.NODE_ENV;
    savedSocket = process.env.WACLI_BRIDGE_SOCKET;
    process.env.NODE_ENV = 'test'; // container jest inherits production; dev-code path needs non-prod
    delete process.env.WACLI_BRIDGE_SOCKET; // container env sets it; these tests drive URL mode
    process.env.WACLI_BRIDGE_URL = BRIDGE_URL;
    process.env.WACLI_BRIDGE_TOKEN = BRIDGE_TOKEN;
    process.env.WACLI_BRIDGE_FORCE = '1'; // lift the jest guard for these tests
    phoneVerificationService = require('../src/services/phoneVerificationService');
  });

  afterAll(async () => {
    process.env.NODE_ENV = savedNodeEnv;
    if (savedSocket !== undefined) process.env.WACLI_BRIDGE_SOCKET = savedSocket;
    delete process.env.WACLI_BRIDGE_URL;
    delete process.env.WACLI_BRIDGE_TOKEN;
    delete process.env.WACLI_BRIDGE_FORCE;
    if (cleanup.userIds.length > 0) {
      await db.query('DELETE FROM phone_verification_challenges WHERE user_id = ANY($1::int[])', [cleanup.userIds]);
      await db.query('DELETE FROM user_verifications WHERE user_id = ANY($1::int[])', [cleanup.userIds]);
      await db.query('DELETE FROM users WHERE id = ANY($1::int[])', [cleanup.userIds]);
    }
  });

  beforeEach(() => {
    axios.post.mockReset();
    axios.get.mockReset();
  });

  test('provider status reports channels as { sms, whatsapp } with no whatsapp_fallback key', async () => {
    axios.get.mockResolvedValue({ data: { ok: true } }); // bridge /health
    const status = await phoneVerificationService.getProviderStatus();
    expect(typeof status.channels.sms).toBe('boolean');
    expect(typeof status.channels.whatsapp).toBe('boolean');
    expect(status.channels).not.toHaveProperty('whatsapp_fallback');
  });

  test('whatsapp channel is reported available when the bridge is configured and healthy', async () => {
    axios.get.mockResolvedValue({ data: { ok: true } });
    const status = await phoneVerificationService.getProviderStatus();
    expect(status.channels.whatsapp).toBe(true);
  });

  test('unknown channel is rejected', async () => {
    const userId = await createVerifiedUser();
    await expect(
      phoneVerificationService.startPhoneVerification(userId, freshPhone(), 'carrier-pigeon')
    ).rejects.toThrow(/channel/i);
  });

  test('missing channel defaults to sms (dev path under jest)', async () => {
    const userId = await createVerifiedUser();
    const result = await phoneVerificationService.startPhoneVerification(userId, freshPhone());
    expect(result.channel).toBe('sms');
    expect(result.devCode).toBeTruthy();
  });

  test('whatsapp send goes through the bridge and records a whatsapp challenge', async () => {
    axios.post.mockResolvedValue({ data: { ok: true } });
    const userId = await createVerifiedUser();
    const phone = freshPhone();

    const result = await phoneVerificationService.startPhoneVerification(userId, phone, 'whatsapp');
    expect(result.channel).toBe('whatsapp');
    expect(result.provider).toBe('wacli-whatsapp');

    // bridge call shape: POST {url}/send, bearer auth, digits without '+',
    // OTP-template message (the bridge enforces this template server-side too)
    expect(axios.post).toHaveBeenCalledTimes(1);
    const [url, body, opts] = axios.post.mock.calls[0];
    expect(url).toBe(`${BRIDGE_URL}/send`);
    expect(body.to).toBe(phone.replace('+', ''));
    expect(body.message).toMatch(/^Intellacc verification code: \d{6}$/);
    expect(opts.headers.Authorization).toBe(`Bearer ${BRIDGE_TOKEN}`);

    const challenge = await db.query(`
      SELECT provider, channel FROM phone_verification_challenges
      WHERE user_id = $1 AND consumed_at IS NULL
      ORDER BY created_at DESC LIMIT 1
    `, [userId]);
    expect(challenge.rows[0]).toEqual({ provider: 'wacli-whatsapp', channel: 'whatsapp' });
  });

  test('whatsapp code verifies through the local challenge machinery', async () => {
    axios.post.mockResolvedValue({ data: { ok: true } });
    const userId = await createVerifiedUser();
    const phone = freshPhone();

    await phoneVerificationService.startPhoneVerification(userId, phone, 'whatsapp');
    const sentMessage = axios.post.mock.calls[0][1].message;
    const code = sentMessage.match(/(\d{6})$/)[1];

    const result = await phoneVerificationService.confirmPhoneVerification(userId, phone, code);
    expect(result.success).toBe(true);

    const tier = await db.query('SELECT verification_tier FROM users WHERE id = $1', [userId]);
    expect(tier.rows[0].verification_tier).toBeGreaterThanOrEqual(2);
  });

  test('bridge failure surfaces a WhatsApp error and never falls back to SMS', async () => {
    axios.post.mockRejectedValue(new Error('connect ECONNREFUSED'));
    const userId = await createVerifiedUser();

    await expect(
      phoneVerificationService.startPhoneVerification(userId, freshPhone(), 'whatsapp')
    ).rejects.toThrow(/whatsapp/i);

    // exactly one transport attempt: the bridge; no SMS gateway call
    expect(axios.post).toHaveBeenCalledTimes(1);
    expect(axios.post.mock.calls[0][0]).toBe(`${BRIDGE_URL}/send`);
  });

  test('socket transport: send goes through the mounted unix socket', async () => {
    axios.post.mockResolvedValue({ data: { ok: true } });
    process.env.WACLI_BRIDGE_SOCKET = '/var/run/wacli-bridge/bridge.sock';
    try {
      const userId = await createVerifiedUser();
      await phoneVerificationService.startPhoneVerification(userId, freshPhone(), 'whatsapp');
      const [url, , opts] = axios.post.mock.calls[0];
      expect(url).toBe('http://localhost/send');
      expect(opts.socketPath).toBe('/var/run/wacli-bridge/bridge.sock');
    } finally {
      delete process.env.WACLI_BRIDGE_SOCKET;
    }
  });

  test('whatsapp requested while bridge unconfigured is a clear error, not a silent SMS downgrade', async () => {
    const savedUrl = process.env.WACLI_BRIDGE_URL;
    delete process.env.WACLI_BRIDGE_URL;
    try {
      const userId = await createVerifiedUser();
      await expect(
        phoneVerificationService.startPhoneVerification(userId, freshPhone(), 'whatsapp')
      ).rejects.toThrow(/whatsapp.*(unavailable|not configured)/i);
      expect(axios.post).not.toHaveBeenCalled();
    } finally {
      process.env.WACLI_BRIDGE_URL = savedUrl;
    }
  });
});
