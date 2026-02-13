// backend/src/services/passwordResetService.js

const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const nodemailer = require('nodemailer');
const db = require('../db');

const PASSWORD_RESET_SECRET = process.env.PASSWORD_RESET_SECRET || 'dev-password-reset-secret-change-in-production';
const PASSWORD_RESET_EXPIRY = process.env.PASSWORD_RESET_EXPIRY || '1h';
const PASSWORD_RESET_DELAY_HOURS = parseFloat(process.env.PASSWORD_RESET_DELAY_HOURS || '168');
const PASSWORD_RESET_POLL_INTERVAL_MS = parseInt(process.env.PASSWORD_RESET_POLL_INTERVAL_MS || '60000', 10) || 60000;
const PASSWORD_RESET_COOLDOWN_SECONDS = parseInt(process.env.PASSWORD_RESET_COOLDOWN_SECONDS || '600', 10);
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';
const SMTP_TLS_REJECT_UNAUTHORIZED = process.env.SMTP_TLS_REJECT_UNAUTHORIZED;
const SMTP_IGNORE_TLS = process.env.SMTP_IGNORE_TLS;

let transporter;
let resetWorkerStarted = false;
let io = null;

const disconnectUserSockets = (userId) => {
  if (!io || !userId) return;
  for (const socket of io.sockets.sockets.values()) {
    if (socket.userId === userId) {
      socket.disconnect(true);
    }
  }
};

const initTransporter = () => {
  if (transporter) return transporter;

  if (process.env.SMTP_HOST) {
    const transportOptions = {
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT || '587'),
      secure: process.env.SMTP_SECURE === 'true'
    };

    const smtpUser = process.env.SMTP_USER;
    const smtpPass = process.env.SMTP_PASS;
    if (smtpUser || smtpPass) {
      transportOptions.auth = { user: smtpUser, pass: smtpPass };
    }

    const rejectUnauthorized = SMTP_TLS_REJECT_UNAUTHORIZED === undefined
      ? true
      : SMTP_TLS_REJECT_UNAUTHORIZED !== 'false';

    transportOptions.tls = {
      ...transportOptions.tls,
      rejectUnauthorized
    };

    if (SMTP_IGNORE_TLS === 'true' || SMTP_IGNORE_TLS === '1') {
      transportOptions.ignoreTLS = true;
    }

    transporter = nodemailer.createTransport(transportOptions);
  } else {
    console.log('[PasswordReset] No SMTP config, using console transport');
    transporter = {
      sendMail: async (options) => {
        console.log('[PasswordReset] Would send email:');
        console.log('  To:', options.to);
        console.log('  Subject:', options.subject);
        console.log('  URL:', options.html?.match(/href="([^"]+)"/)?.[1] || 'N/A');
        return { messageId: 'console-' + Date.now() };
      }
    };
  }

  return transporter;
};

const generateResetToken = (userId, email) => {
  return jwt.sign(
    { userId, email, purpose: 'password_reset' },
    PASSWORD_RESET_SECRET,
    { expiresIn: PASSWORD_RESET_EXPIRY }
  );
};

const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

const getTokenExpiry = (token) => {
  const decoded = jwt.decode(token);
  if (decoded?.exp) {
    return new Date(decoded.exp * 1000);
  }
  return new Date(Date.now() + 60 * 60 * 1000);
};

const markTokenUsed = async (tokenId, client = null) => {
  const executor = client || db;
  await executor.query(
    'UPDATE password_reset_tokens SET used_at = NOW() WHERE id = $1 AND used_at IS NULL',
    [tokenId]
  );
};

exports.sendPasswordResetEmail = async (userId, email) => {
  const transport = initTransporter();
  const effectiveCooldownSeconds = Number.isFinite(PASSWORD_RESET_COOLDOWN_SECONDS) ? PASSWORD_RESET_COOLDOWN_SECONDS : 90;

  const existing = await db.query(
    `SELECT id, created_at, token_hash
     FROM password_reset_tokens
     WHERE user_id = $1
       AND used_at IS NULL
       AND expires_at > NOW()
     ORDER BY created_at DESC
     LIMIT 1`,
    [userId]
  );

  if (existing.rows.length > 0) {
    const lastSentAt = new Date(existing.rows[0].created_at).getTime();
    const now = Date.now();
    const cooldownMs = Math.max(0, effectiveCooldownSeconds) * 1000;

    if (cooldownMs > 0 && now - lastSentAt < cooldownMs) {
      console.log(
        `[PasswordReset] Skipping duplicate reset email for user ${userId} to ${email} within ${effectiveCooldownSeconds}s`
      );
      return { success: true, skipped: true };
    }
  }

  const token = generateResetToken(userId, email);
  const tokenHash = hashToken(token);
  const expiresAt = getTokenExpiry(token);

  await db.query(
    'DELETE FROM password_reset_tokens WHERE user_id = $1 AND used_at IS NULL',
    [userId]
  );

  await db.query(
    'INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)',
    [userId, tokenHash, expiresAt]
  );

  const resetUrl = `${FRONTEND_URL}/#reset-password?token=${token}`;

  const result = await transport.sendMail({
    from: `"Intellacc" <${process.env.SMTP_FROM || 'noreply@intellacc.com'}>`,
    to: email,
    subject: 'Reset your Intellacc password',
    html: `
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .button { display: inline-block; background: #0a66c2; color: white; padding: 12px 24px; text-decoration: none; border-radius: 4px; font-weight: bold; }
          .warning { background: #fff3cd; color: #664d03; padding: 12px; border-radius: 4px; border: 1px solid #ffecb5; }
          .footer { margin-top: 30px; font-size: 12px; color: #666; text-align: center; }
        </style>
      </head>
      <body>
        <div class="container">
          <h2>Reset your Intellacc password</h2>
          <p>Click the button below to reset your password.</p>
          <div class="warning">
            <strong>Important:</strong> Resetting your password will remove access to encrypted messages and MLS group memberships.
            You will need to be re-invited to encrypted conversations.
          </div>
          <p style="text-align: center; margin: 30px 0;">
            <a href="${resetUrl}" class="button">Reset Password</a>
          </p>
          <p>Or copy and paste this link into your browser:</p>
          <p style="word-break: break-all; background: #f5f5f5; padding: 10px; border-radius: 4px; font-size: 12px;">${resetUrl}</p>
          <p>This link expires soon. If you did not request a reset, you can ignore this email.</p>
          <div class="footer">
            <p>&copy; ${new Date().getFullYear()} Intellacc</p>
          </div>
        </div>
      </body>
      </html>
    `,
    text: `
Reset your Intellacc password:
${resetUrl}

Important: Resetting your password will remove access to encrypted messages and MLS group memberships.
You will need to be re-invited to encrypted conversations.

If you did not request this, you can ignore this email.
    `.trim()
  });

  console.log(`[PasswordReset] Sent reset email to ${email}, messageId: ${result.messageId}`);
  return { success: true, messageId: result.messageId };
};

exports.verifyResetToken = async (token) => {
  try {
    const decoded = jwt.verify(token, PASSWORD_RESET_SECRET);
    if (decoded.purpose !== 'password_reset') {
      return { success: false, error: 'Invalid token purpose' };
    }

    const tokenHash = hashToken(token);
    const tokenResult = await db.query(
      'SELECT id, used_at, expires_at FROM password_reset_tokens WHERE user_id = $1 AND token_hash = $2',
      [decoded.userId, tokenHash]
    );

    if (tokenResult.rows.length === 0) {
      return { success: false, error: 'Token not found' };
    }

    const tokenRecord = tokenResult.rows[0];

    if (tokenRecord.used_at) {
      return { success: false, error: 'Token already used' };
    }

    if (new Date(tokenRecord.expires_at) < new Date()) {
      return { success: false, error: 'Token expired' };
    }

    return { success: true, userId: decoded.userId, tokenId: tokenRecord.id };
  } catch (err) {
    return { success: false, error: 'Invalid or expired token' };
  }
};

exports.createResetRequest = async ({ userId, tokenId, passwordHash, executeAfter }) => {
  const existing = await db.query(
    "SELECT id, execute_after FROM password_reset_requests WHERE user_id = $1 AND status = 'pending'",
    [userId]
  );

  await markTokenUsed(tokenId);

  if (existing.rows.length > 0) {
    return {
      status: 'pending',
      requestId: existing.rows[0].id,
      executeAfter: existing.rows[0].execute_after,
      alreadyPending: true
    };
  }

  const result = await db.query(
    `INSERT INTO password_reset_requests
     (user_id, execute_after, new_password_hash, token_id, created_at, updated_at)
     VALUES ($1, $2, $3, $4, NOW(), NOW())
     RETURNING id, execute_after`,
    [userId, executeAfter, passwordHash, tokenId]
  );

  return {
    status: 'pending',
    requestId: result.rows[0].id,
    executeAfter: result.rows[0].execute_after
  };
};

exports.cancelPendingReset = async (userId) => {
  const result = await db.query(
    "UPDATE password_reset_requests SET status = 'cancelled', updated_at = NOW() WHERE user_id = $1 AND status = 'pending'",
    [userId]
  );

  return result.rowCount > 0;
};

exports.executePasswordReset = async ({ userId, passwordHash, tokenId = null, requestId = null, client = null }) => {
  const pool = db.getPool();
  const executor = client || await pool.connect();
  const shouldManageTx = !client;

  try {
    if (shouldManageTx) {
      await executor.query('BEGIN');
    }

    await executor.query(
      'UPDATE users SET password_hash = $1, password_changed_at = NOW(), updated_at = NOW() WHERE id = $2',
      [passwordHash, userId]
    );

    await executor.query('DELETE FROM user_master_keys WHERE user_id = $1', [userId]);
    await executor.query('SELECT clear_user_mls_data($1)', [userId]);

    if (tokenId) {
      await markTokenUsed(tokenId, executor);
    }

    if (requestId) {
      await executor.query(
        "UPDATE password_reset_requests SET status = 'completed', updated_at = NOW() WHERE id = $1 AND status = 'pending'",
        [requestId]
      );
      await executor.query(
        "UPDATE password_reset_requests SET status = 'cancelled', updated_at = NOW() WHERE user_id = $1 AND status = 'pending' AND id <> $2",
        [userId, requestId]
      );
    } else {
      await executor.query(
        "UPDATE password_reset_requests SET status = 'cancelled', updated_at = NOW() WHERE user_id = $1 AND status = 'pending'",
        [userId]
      );
    }

    if (shouldManageTx) {
      await executor.query('COMMIT');
    }
  } catch (err) {
    if (shouldManageTx) {
      await executor.query('ROLLBACK');
    }
    throw err;
  } finally {
    if (shouldManageTx) {
      executor.release();
    }
  }
};

exports.processPendingResets = async (limit = 10) => {
  const pool = db.getPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const result = await client.query(
      `SELECT id, user_id, new_password_hash
       FROM password_reset_requests
       WHERE status = 'pending' AND execute_after <= NOW()
       ORDER BY execute_after ASC
       FOR UPDATE SKIP LOCKED
       LIMIT $1`,
      [limit]
    );

    for (const row of result.rows) {
      await exports.executePasswordReset({
        userId: row.user_id,
        passwordHash: row.new_password_hash,
        requestId: row.id,
        client
      });
      disconnectUserSockets(row.user_id);
    }

    await client.query('COMMIT');
    return result.rows.length;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
};

exports.setSocketIo = (socketIo) => {
  io = socketIo;
};

exports.disconnectUserSockets = disconnectUserSockets;

exports.startResetWorker = () => {
  if (resetWorkerStarted) return;
  resetWorkerStarted = true;

  const interval = setInterval(async () => {
    try {
      const processed = await exports.processPendingResets(20);
      if (processed > 0) {
        console.log(`[PasswordReset] Processed ${processed} pending reset(s)`);
      }
    } catch (err) {
      console.error('[PasswordReset] Failed to process pending resets:', err);
    }
  }, PASSWORD_RESET_POLL_INTERVAL_MS);
  interval.unref();
};

exports.hashPassword = async (password) => bcrypt.hash(password, 10);
exports.getResetDelayMs = () => {
  const delayHours = Number.isFinite(PASSWORD_RESET_DELAY_HOURS) ? PASSWORD_RESET_DELAY_HOURS : 168;
  return Math.max(0, delayHours * 60 * 60 * 1000);
};
