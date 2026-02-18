/**
 * Phone Verification Service
 * Handles SMS verification and phone hash uniqueness
 */
const crypto = require('crypto');
const db = require('../db');

const PHONE_HASH_SALT = process.env.PHONE_HASH_SALT || 'dev-phone-hash-salt';
const DEV_PHONE_CODE = process.env.DEV_PHONE_CODE || '000000';
const TWILIO_SID = process.env.TWILIO_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_VERIFY_SID = process.env.TWILIO_VERIFY_SID;
const getPhoneVerificationEnabledEnv = () => process.env.PHONE_VERIFICATION_ENABLED;

let twilioClient = null;

const parseBool = (value, defaultValue = false) => {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return defaultValue;
  return normalized === 'true' || normalized === '1' || normalized === 'yes';
};

const useTwilio = () => !!(TWILIO_SID && TWILIO_AUTH_TOKEN && TWILIO_VERIFY_SID);
const isProduction = () => process.env.NODE_ENV === 'production';
const isEnabled = () => {
  const explicit = parseBool(getPhoneVerificationEnabledEnv(), true);
  return explicit;
};

const assertProviderAvailable = () => {
  if (!isEnabled()) {
    throw new Error('Phone verification is disabled by configuration.');
  }

  if (isProduction() && !useTwilio()) {
    throw new Error('Twilio verification is not configured in production');
  }
};

const getProviderStatus = () => {
  const enabled = isEnabled();
  const configured = useTwilio();
  const available = enabled && (!isProduction() || configured);
  const requiresConfig = process.env.REQUIRE_TWILIO_VERIFICATION === 'true';

  return {
    provider: configured ? 'twilio' : 'dev',
    configured,
    required: requiresConfig,
    enabled,
    available,
    reason: available
      ? null
      : (!enabled
        ? 'Phone verification is disabled by configuration.'
        : 'Twilio verification credentials are not configured.')
  };
};

const getTwilioClient = () => {
  if (!useTwilio()) {
    throw new Error('Twilio Verify is not configured');
  }

  if (!twilioClient) {
    const twilio = require('twilio');
    twilioClient = twilio(TWILIO_SID, TWILIO_AUTH_TOKEN);
  }

  return twilioClient;
};

const normalizePhone = (phoneNumber) => {
  if (!phoneNumber) return '';
  return phoneNumber.replace(/\D/g, '');
};

const hashPhone = (phoneNumber) => {
  const normalized = normalizePhone(phoneNumber);
  if (!normalized) {
    throw new Error('Invalid phone number');
  }
  return crypto.createHash('sha256').update(`${normalized}:${PHONE_HASH_SALT}`).digest('hex');
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

  const phoneHash = hashPhone(phoneNumber);
  await ensurePhoneAvailable(userId, phoneHash);

  let provider = 'dev';
  let providerId = null;
  let devCode = null;

  if (useTwilio()) {
    const client = getTwilioClient();
    const verification = await client.verify.v2
      .services(TWILIO_VERIFY_SID)
      .verifications
      .create({ to: phoneNumber, channel: 'sms' });

    provider = 'twilio';
    providerId = verification.sid;
  } else if (process.env.NODE_ENV !== 'production') {
    devCode = DEV_PHONE_CODE;
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

  return { success: true, provider, devCode };
};

exports.confirmPhoneVerification = async (userId, phoneNumber, code) => {
  assertProviderAvailable();
  await ensureEmailVerified(userId);

  const phoneHash = hashPhone(phoneNumber);
  await ensurePhoneAvailable(userId, phoneHash);

  if (useTwilio()) {
    const client = getTwilioClient();
    const verification = await client.verify.v2
      .services(TWILIO_VERIFY_SID)
      .verificationChecks
      .create({ to: phoneNumber, code });

    if (verification.status !== 'approved') {
      throw new Error('Invalid verification code');
    }
  } else {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('Twilio Verify is not configured');
    }
    if (code !== DEV_PHONE_CODE) {
      throw new Error('Invalid verification code');
    }
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
      verified_at = NOW(),
      updated_at = NOW()
  `, [userId, useTwilio() ? 'twilio' : 'dev']);

  await db.query(`
    UPDATE users SET verification_tier = GREATEST(verification_tier, 2)
    WHERE id = $1
  `, [userId]);

  return { success: true };
};

exports.normalizePhone = normalizePhone;
exports.getProviderStatus = getProviderStatus;
exports.isEnabled = isEnabled;
