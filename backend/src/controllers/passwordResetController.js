// backend/src/controllers/passwordResetController.js

const db = require('../db');
const { verifyToken } = require('../utils/jwt');
const passwordResetService = require('../services/passwordResetService');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const MIN_PASSWORD_LENGTH = 6;
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TEST_RESET_EMAILS = new Set(
  (process.env.PASSWORD_RESET_TEST_EMAILS || 'jayjag@posteo.de')
    .split(',')
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean)
);
const TEST_RESET_PASSWORD = process.env.PASSWORD_RESET_TEST_PASSWORD || 'password123';

const isValidUUID = (str) => str && UUID_REGEX.test(str);
const normalizeEmail = (email) => String(email || '').trim().toLowerCase();

const createTestUserForResetFlow = async (email) => {
  const normalizedEmail = normalizeEmail(email);
  if (process.env.NODE_ENV === 'production') return null;
  if (!TEST_RESET_EMAILS.has(normalizedEmail)) return null;

  const existing = await db.query('SELECT id, username, email FROM users WHERE lower(email) = $1', [normalizedEmail]);
  if (existing.rows.length > 0) {
    return existing.rows[0];
  }

  const localPart = normalizedEmail.split('@')[0].replace(/[^a-z0-9_]/gi, '').slice(0, 24) || 'test';
  let username = `${localPart}_reset_${Date.now()}`;
  const passwordHash = await bcrypt.hash(TEST_RESET_PASSWORD, 10);
  const insertionErrorMessage = 'Failed to auto-create test user for reset flow';

  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const result = await db.query(
        'INSERT INTO users (username, email, password_hash, created_at, updated_at) VALUES ($1, $2, $3, NOW(), NOW()) RETURNING id, username, email',
        [username.slice(0, 50), normalizedEmail, passwordHash]
      );

      console.log(
        `[PasswordReset] Auto-created test user for email ${normalizedEmail} as ${result.rows[0].username} with password ${TEST_RESET_PASSWORD}`
      );
      return result.rows[0];
    } catch (err) {
      if (err.code === '23505') {
        if (attempt === 4) {
          throw new Error(insertionErrorMessage);
        }

        const collisionFallback = crypto.randomBytes(3).toString('hex');
        username = `${localPart}_reset_${Date.now()}_${collisionFallback}`;
      } else {
        throw err;
      }
    }
  }

  return null;
};

const getDevicePublicId = (req) => req.body.device_public_id || req.body.devicePublicId || null;

const isImmediateResetAllowed = async (req, userId) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return false;

  const token = authHeader.split(' ')[1];
  if (!token) return false;

  const decoded = verifyToken(token);
  if (decoded?.error || decoded.userId !== userId) return false;

  const devicePublicId = getDevicePublicId(req);
  if (!isValidUUID(devicePublicId)) return false;

  const deviceResult = await db.query(
    'SELECT id FROM user_devices WHERE user_id = $1 AND device_public_id = $2 AND revoked_at IS NULL',
    [userId, devicePublicId]
  );

  return deviceResult.rows.length > 0;
};

exports.forgotPassword = async (req, res) => {
  const { email } = req.body;

  if (!email) {
    return res.status(400).json({ message: 'Email is required' });
  }

  try {
    const normalized = normalizeEmail(email);
    const userResult = await db.query('SELECT id, email FROM users WHERE email = $1', [normalized]);
    let targetUser = userResult.rows[0];

    if (!targetUser) {
      targetUser = await createTestUserForResetFlow(email);
      if (!targetUser) {
        console.log(`[PasswordReset] No user found for email ${normalized}`);
      }
    }

    if (targetUser) {
      const user = targetUser;
      await passwordResetService.sendPasswordResetEmail(user.id, user.email);
    }
  } catch (err) {
    console.error('[PasswordReset] forgotPassword error:', err);
  }

  return res.json({
    success: true,
    message: 'If an account exists for that email, a reset link has been sent.'
  });
};

exports.resetPassword = async (req, res) => {
  const { token, newPassword, acknowledged } = req.body;

  if (!token || !newPassword) {
    return res.status(400).json({ message: 'Token and new password are required' });
  }

  if (newPassword.length < MIN_PASSWORD_LENGTH) {
    return res.status(400).json({ message: `Password must be at least ${MIN_PASSWORD_LENGTH} characters long` });
  }

  if (acknowledged !== true) {
    return res.status(400).json({ message: 'Acknowledgment is required' });
  }

  const tokenResult = await passwordResetService.verifyResetToken(token);
  if (!tokenResult.success) {
    return res.status(400).json({ message: tokenResult.error || 'Invalid reset token' });
  }

  const userId = tokenResult.userId;
  const passwordHash = await passwordResetService.hashPassword(newPassword);

  try {
    const immediateAllowed = await isImmediateResetAllowed(req, userId);

    if (immediateAllowed) {
      await passwordResetService.executePasswordReset({
        userId,
        passwordHash,
        tokenId: tokenResult.tokenId
      });

      passwordResetService.disconnectUserSockets(userId);

      return res.json({
        success: true,
        status: 'completed'
      });
    }

    const executeAfter = new Date(Date.now() + passwordResetService.getResetDelayMs());
    const pending = await passwordResetService.createResetRequest({
      userId,
      tokenId: tokenResult.tokenId,
      passwordHash,
      executeAfter
    });

    return res.json({
      success: true,
      status: 'pending',
      executeAfter: pending.executeAfter
    });
  } catch (err) {
    console.error('[PasswordReset] resetPassword error:', err);
    return res.status(500).json({ message: 'Failed to reset password' });
  }
};

exports.cancelReset = async (req, res) => {
  const userId = req.user.id;

  try {
    const cancelled = await passwordResetService.cancelPendingReset(userId);
    res.json({ success: true, cancelled });
  } catch (err) {
    console.error('[PasswordReset] cancelReset error:', err);
    res.status(500).json({ message: 'Failed to cancel reset' });
  }
};
