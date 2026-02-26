/**
 * Phone Verification Service
 * Handles SMS verification and phone hash uniqueness
 */
const crypto = require('crypto');
const axios = require('axios');
const { execFile } = require('child_process');
const { promisify } = require('util');
const db = require('../db');

const PHONE_HASH_SALT = process.env.PHONE_HASH_SALT || 'dev-phone-hash-salt';
const PHONE_CODE_HASH_SALT = process.env.PHONE_CODE_HASH_SALT || 'dev-phone-code-hash-salt';
const DEV_PHONE_CODE = process.env.DEV_PHONE_CODE || '000000';
const getPhoneVerificationEnabledEnv = () => process.env.PHONE_VERIFICATION_ENABLED;
const execFileAsync = promisify(execFile);

let twilioClient = null;
let twilioClientKey = null;

const parseBool = (value, defaultValue = false) => {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return defaultValue;
  return normalized === 'true' || normalized === '1' || normalized === 'yes';
};

const getTwilioSid = () => process.env.TWILIO_SID;
const getTwilioAuthToken = () => process.env.TWILIO_AUTH_TOKEN;
const getTwilioVerifySid = () => process.env.TWILIO_VERIFY_SID;
const getSmsGatewayUrl = () => process.env.SMS_GATEWAY_URL;
const getSmsGatewayUsername = () => process.env.SMS_GATEWAY_USERNAME;
const getSmsGatewayPassword = () => process.env.SMS_GATEWAY_PASSWORD;
const getOpenClawUrl = () => process.env.OPENCLAW_URL;
const getOpenClawToken = () => process.env.OPENCLAW_TOKEN;
const getOpenClawCliBin = () => process.env.OPENCLAW_CLI_BIN || 'openclaw';
const getOpenClawCliArgs = () => String(process.env.OPENCLAW_CLI_ARGS || '').trim();

const toInt = (value, fallback) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const getCodeTtlMinutes = () => toInt(process.env.PHONE_CODE_TTL_MINUTES, 10);
const getCodeMaxAttempts = () => toInt(process.env.PHONE_CODE_MAX_ATTEMPTS, 5);
const getSmsGatewayTimeoutMs = () => toInt(process.env.SMS_GATEWAY_TIMEOUT_MS, 8000);
const getOpenClawTimeoutMs = () => toInt(process.env.OPENCLAW_TIMEOUT_MS, 15000);

const useTwilio = () => !!(getTwilioSid() && getTwilioAuthToken() && getTwilioVerifySid());
const useSmsGateway = () => !!(getSmsGatewayUrl() && getSmsGatewayUsername() && getSmsGatewayPassword());
const useOpenClawFallback = () => !!(getOpenClawUrl() && getOpenClawToken());
const isProduction = () => process.env.NODE_ENV === 'production';
const isEnabled = () => {
  const explicit = parseBool(getPhoneVerificationEnabledEnv(), true);
  return explicit;
};

const assertProviderAvailable = () => {
  if (!isEnabled()) {
    throw new Error('Phone verification is disabled by configuration.');
  }

  if (isProduction() && !useTwilio() && !useSmsGateway()) {
    throw new Error('Twilio or SMS gateway verification is not configured in production');
  }
};

const getProviderStatus = () => {
  const enabled = isEnabled();
  const twilioConfigured = useTwilio();
  const smsGatewayConfigured = useSmsGateway();
  const configured = twilioConfigured || smsGatewayConfigured;
  const available = enabled && (!isProduction() || configured);
  const requiresConfig = process.env.REQUIRE_TWILIO_VERIFICATION === 'true';
  const provider = twilioConfigured ? 'twilio' : (smsGatewayConfigured ? 'smsgate' : 'dev');

  return {
    provider,
    configured,
    required: requiresConfig,
    enabled,
    available,
    channels: {
      sms: twilioConfigured || smsGatewayConfigured,
      whatsapp_fallback: !twilioConfigured && smsGatewayConfigured && useOpenClawFallback()
    },
    reason: available
      ? null
      : (!enabled
        ? 'Phone verification is disabled by configuration.'
        : 'Twilio or SMS gateway verification credentials are not configured.')
  };
};

const getTwilioClient = () => {
  if (!useTwilio()) {
    throw new Error('Twilio Verify is not configured');
  }

  const sid = getTwilioSid();
  const token = getTwilioAuthToken();
  const key = `${sid}:${token}`;

  if (!twilioClient || twilioClientKey !== key) {
    const twilio = require('twilio');
    twilioClient = twilio(sid, token);
    twilioClientKey = key;
  }

  return twilioClient;
};

const normalizePhone = (phoneNumber) => {
  if (!phoneNumber) return '';
  return phoneNumber.replace(/\D/g, '');
};

const normalizePhoneE164 = (phoneNumber) => {
  const digits = normalizePhone(phoneNumber);
  if (digits.length < 8 || digits.length > 15) {
    throw new Error('Invalid phone number');
  }
  return `+${digits}`;
};

const hashPhone = (phoneNumber) => {
  const normalized = normalizePhone(phoneNumber);
  if (!normalized) {
    throw new Error('Invalid phone number');
  }
  return crypto.createHash('sha256').update(`${normalized}:${PHONE_HASH_SALT}`).digest('hex');
};

const hashVerificationCode = (phoneHash, code) => (
  crypto
    .createHash('sha256')
    .update(`${phoneHash}:${code}:${PHONE_CODE_HASH_SALT}`)
    .digest('hex')
);

const timingSafeEqualHex = (leftHex, rightHex) => {
  if (!leftHex || !rightHex || leftHex.length !== rightHex.length) {
    return false;
  }
  return crypto.timingSafeEqual(Buffer.from(leftHex, 'hex'), Buffer.from(rightHex, 'hex'));
};

const buildVerificationMessage = (code) => `Intellacc verification code: ${code}`;
const generateOtpCode = () => crypto.randomInt(0, 1_000_000).toString().padStart(6, '0');

const resolveSmsGatewayMessageUrl = () => {
  const base = String(getSmsGatewayUrl() || '').trim();
  if (!base) return '';
  const withoutTrailingSlash = base.replace(/\/+$/, '');
  return withoutTrailingSlash.endsWith('/message')
    ? withoutTrailingSlash
    : `${withoutTrailingSlash}/message`;
};

const sendViaSmsGateway = async (phoneNumber, message) => {
  const endpoint = resolveSmsGatewayMessageUrl();
  if (!endpoint || !useSmsGateway()) {
    throw new Error('SMS gateway is not configured');
  }

  await axios.post(endpoint, {
    textMessage: { text: message },
    phoneNumbers: [phoneNumber]
  }, {
    auth: {
      username: getSmsGatewayUsername(),
      password: getSmsGatewayPassword()
    },
    headers: { 'Content-Type': 'application/json' },
    timeout: getSmsGatewayTimeoutMs()
  });

  return { provider: 'smsgate', channel: 'sms' };
};

const sendViaOpenClaw = async (phoneNumber, message) => {
  if (!useOpenClawFallback()) {
    throw new Error('OpenClaw WhatsApp fallback is not configured');
  }

  const cliArgsPrefix = getOpenClawCliArgs()
    ? getOpenClawCliArgs().split(/\s+/).filter(Boolean)
    : [];
  const args = [
    ...cliArgsPrefix,
    'message',
    'send',
    '--url', getOpenClawUrl(),
    '--token', getOpenClawToken(),
    '--target', phoneNumber,
    '--message', message
  ];
  await execFileAsync(getOpenClawCliBin(), args, {
    timeout: getOpenClawTimeoutMs(),
    maxBuffer: 1024 * 1024
  });

  return { provider: 'openclaw-whatsapp', channel: 'whatsapp' };
};

const deliverVerificationCode = async (phoneNumber, code) => {
  const message = buildVerificationMessage(code);

  try {
    return await sendViaSmsGateway(phoneNumber, message);
  } catch (smsError) {
    if (!useOpenClawFallback()) {
      throw new Error(`SMS delivery failed: ${smsError.message}`);
    }

    try {
      const fallbackResult = await sendViaOpenClaw(phoneNumber, message);
      return { ...fallbackResult, fallback_from: 'sms' };
    } catch (whatsAppError) {
      throw new Error(`SMS delivery failed (${smsError.message}); WhatsApp fallback failed (${whatsAppError.message})`);
    }
  }
};

const createLocalVerificationChallenge = async (userId, phoneHash, code, provider, channel) => {
  const codeHash = hashVerificationCode(phoneHash, code);
  const ttlMinutes = getCodeTtlMinutes();
  const maxAttempts = getCodeMaxAttempts();

  await db.query(`
    UPDATE phone_verification_challenges
    SET consumed_at = NOW(), updated_at = NOW()
    WHERE user_id = $1 AND phone_hash = $2 AND consumed_at IS NULL
  `, [userId, phoneHash]);

  await db.query(`
    INSERT INTO phone_verification_challenges (
      user_id, phone_hash, provider, channel, code_hash, max_attempts, expires_at
    )
    VALUES ($1, $2, $3, $4, $5, $6, NOW() + ($7 || ' minutes')::interval)
  `, [userId, phoneHash, provider, channel, codeHash, maxAttempts, String(ttlMinutes)]);
};

const verifyLocalChallenge = async (userId, phoneHash, code) => {
  const result = await db.query(`
    SELECT id, provider, code_hash, attempts, max_attempts, expires_at
    FROM phone_verification_challenges
    WHERE user_id = $1 AND phone_hash = $2 AND consumed_at IS NULL
    ORDER BY created_at DESC
    LIMIT 1
  `, [userId, phoneHash]);

  if (result.rows.length === 0) {
    throw new Error('Verification code expired. Please request a new code.');
  }

  const challenge = result.rows[0];
  const now = Date.now();
  const expiresAt = challenge.expires_at ? new Date(challenge.expires_at).getTime() : 0;
  if (!expiresAt || expiresAt <= now) {
    await db.query(`
      UPDATE phone_verification_challenges
      SET consumed_at = NOW(), updated_at = NOW()
      WHERE id = $1
    `, [challenge.id]);
    throw new Error('Verification code expired. Please request a new code.');
  }

  if (challenge.attempts >= challenge.max_attempts) {
    await db.query(`
      UPDATE phone_verification_challenges
      SET consumed_at = NOW(), updated_at = NOW()
      WHERE id = $1
    `, [challenge.id]);
    throw new Error('Too many verification attempts. Please request a new code.');
  }

  const inputHash = hashVerificationCode(phoneHash, String(code || '').trim());
  const isMatch = timingSafeEqualHex(challenge.code_hash, inputHash);
  if (!isMatch) {
    await db.query(`
      UPDATE phone_verification_challenges
      SET attempts = attempts + 1,
          consumed_at = CASE WHEN attempts + 1 >= max_attempts THEN NOW() ELSE consumed_at END,
          updated_at = NOW()
      WHERE id = $1
    `, [challenge.id]);
    throw new Error('Invalid verification code');
  }

  await db.query(`
    UPDATE phone_verification_challenges
    SET consumed_at = NOW(), updated_at = NOW()
    WHERE id = $1
  `, [challenge.id]);

  return challenge.provider || 'dev';
};

const ensureEmailVerified = async (userId) => {
  const result = await db.query('SELECT verification_tier FROM users WHERE id = $1', [userId]);
  if (result.rows.length === 0) {
    throw new Error('User not found');
  }
  if ((result.rows[0].verification_tier || 0) < 1) {
    throw new Error('Email verification required first');
  }
};

const ensurePhoneAvailable = async (userId, phoneHash) => {
  const existing = await db.query('SELECT user_id FROM phone_hashes WHERE phone_hash = $1', [phoneHash]);
  if (existing.rows.length > 0 && existing.rows[0].user_id !== userId) {
    throw new Error('Phone number already associated with another account');
  }
};

exports.startPhoneVerification = async (userId, phoneNumber) => {
  assertProviderAvailable();
  await ensureEmailVerified(userId);

  const normalizedPhone = normalizePhoneE164(phoneNumber);
  const phoneHash = hashPhone(phoneNumber);
  await ensurePhoneAvailable(userId, phoneHash);

  let provider = 'dev';
  let providerId = null;
  let devCode = null;
  let channel = 'sms';
  let fallbackFrom = null;

  if (useTwilio()) {
    const client = getTwilioClient();
    const verification = await client.verify.v2
      .services(getTwilioVerifySid())
      .verifications
      .create({ to: normalizedPhone, channel: 'sms' });

    provider = 'twilio';
    providerId = verification.sid;
  } else if (useSmsGateway()) {
    const code = generateOtpCode();
    const delivery = await deliverVerificationCode(normalizedPhone, code);
    provider = delivery.provider;
    channel = delivery.channel;
    fallbackFrom = delivery.fallback_from || null;
    await createLocalVerificationChallenge(userId, phoneHash, code, provider, channel);
  } else {
    if (isProduction()) {
      throw new Error('Twilio or SMS gateway verification is not configured in production');
    }
    devCode = DEV_PHONE_CODE;
    await createLocalVerificationChallenge(userId, phoneHash, devCode, 'dev', 'sms');
  }

  await db.query(`
    INSERT INTO user_verifications (user_id, tier, verification_type, provider, status, provider_id)
    VALUES ($1, 2, 'phone', $2, 'pending', $3)
    ON CONFLICT (user_id, tier) DO UPDATE SET
      status = 'pending',
      provider = $2,
      provider_id = $3,
      updated_at = NOW()
  `, [userId, provider, providerId]);

  return { success: true, provider, channel, fallbackFrom, devCode };
};

exports.confirmPhoneVerification = async (userId, phoneNumber, code) => {
  assertProviderAvailable();
  await ensureEmailVerified(userId);

  const normalizedPhone = normalizePhoneE164(phoneNumber);
  const phoneHash = hashPhone(phoneNumber);
  await ensurePhoneAvailable(userId, phoneHash);
  let verifiedProvider = 'dev';

  if (useTwilio()) {
    const client = getTwilioClient();
    const verification = await client.verify.v2
      .services(getTwilioVerifySid())
      .verificationChecks
      .create({ to: normalizedPhone, code });

    if (verification.status !== 'approved') {
      throw new Error('Invalid verification code');
    }
    verifiedProvider = 'twilio';
  } else {
    verifiedProvider = await verifyLocalChallenge(userId, phoneHash, code);
  }

  await db.query(`
    INSERT INTO phone_hashes (phone_hash, user_id)
    VALUES ($1, $2)
    ON CONFLICT (phone_hash) DO NOTHING
  `, [phoneHash, userId]);

  await db.query(`
    INSERT INTO user_verifications (user_id, tier, verification_type, provider, status, verified_at)
    VALUES ($1, 2, 'phone', $2, 'verified', NOW())
    ON CONFLICT (user_id, tier) DO UPDATE SET
      status = 'verified',
      provider = $2,
      verified_at = NOW(),
      updated_at = NOW()
  `, [userId, verifiedProvider]);

  await db.query(`
    UPDATE users SET verification_tier = GREATEST(verification_tier, 2)
    WHERE id = $1
  `, [userId]);

  return { success: true };
};

exports.normalizePhone = normalizePhone;
exports.getProviderStatus = getProviderStatus;
exports.isEnabled = isEnabled;
