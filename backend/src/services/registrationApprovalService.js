const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const db = require('../db');
const emailVerificationService = require('./emailVerificationService');
const {
  isRegistrationApprovalRequired,
  getRegistrationApproverEmail
} = require('../utils/registration');

const REGISTRATION_APPROVAL_TTL_HOURS = Number(process.env.REGISTRATION_APPROVAL_TTL_HOURS || 24);
const REGISTRATION_APPROVAL_SECRET =
  process.env.REGISTRATION_APPROVAL_SECRET ||
  process.env.JWT_SECRET ||
  process.env.EMAIL_TOKEN_SECRET ||
  'dev-registration-approval-secret';
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';
const APPROVAL_PATH = '/api/admin/users/approve';
const REGISTRATION_APPROVAL_RESEND_COOLDOWN_MINUTES = Number(process.env.REGISTRATION_APPROVAL_RESEND_COOLDOWN_MINUTES || 10);

const getExpiryDate = () => {
  const ttlMs = Math.max(1, REGISTRATION_APPROVAL_TTL_HOURS) * 60 * 60 * 1000;
  return new Date(Date.now() + ttlMs);
};

const hashToken = (token) => {
  return crypto.createHash('sha256').update(token).digest('hex');
};

const buildApprovalToken = (userId, approverEmail) => {
  return jwt.sign(
    {
      type: 'registration_approval',
      userId,
      approverEmail
    },
    REGISTRATION_APPROVAL_SECRET,
    { expiresIn: `${Math.max(1, REGISTRATION_APPROVAL_TTL_HOURS)}h` }
  );
};

const escapeHtml = (value) => {
  return String(value || '').replace(/[&<>"]|'/g, (match) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[match]);
};

const toHtml = ({ username, email, userId, approvalUrl, ttlHours }) => {
  const safeUsername = escapeHtml(username || '(no username)');
  const safeEmail = escapeHtml(email || 'no email');
  const safeApprovalUrl = escapeHtml(approvalUrl);

  return `<!doctype html>
<html>
<body style="margin:0; padding:0; background:#f8fafc; font-family:-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color:#111827;">
  <div style="max-width: 640px; margin: 0 auto; padding: 24px;">
    <h2 style="margin:0 0 12px 0;">Intellacc Registration Approval</h2>
    <p style="margin:0 0 12px 0; color:#1f2937;">A new user account is waiting for approval.</p>
    <div style="background:#ffffff; border:1px solid #e5e7eb; border-radius:8px; padding:16px;">
      <div style="margin-bottom: 12px;">User: <strong>${safeUsername}</strong></div>
      <div style="margin-bottom: 12px;">Email: <strong>${safeEmail}</strong></div>
      <div style="margin-bottom: 12px;">User ID: <strong>${Number(userId)}</strong></div>
    </div>
    <p style="margin:16px 0;">
      <a href="${safeApprovalUrl}" style="display:inline-block;background:#2563eb;color:#fff;text-decoration:none;padding:12px 18px;border-radius:6px;font-weight:600;">Approve this user</a>
    </p>
    <div style="color:#6b7280; font-size:13px; line-height:1.5;">
      <p style="margin:0 0 10px 0;">If the button does not work, open this link:</p>
      <p style="margin:0 0 8px 0; word-break:break-all;">${safeApprovalUrl}</p>
      <p style="margin:0 0 0 0;">This link expires in ${ttlHours} hour(s).</p>
    </div>
  </div>
</body>
</html>`;
};

const toText = ({ username, email, userId, approvalUrl, ttlHours }) => {
  return [
    'Intellacc Registration Approval',
    '',
    'A new user account is waiting for approval.',
    `User: ${username || '(no username)'}`,
    `Email: ${email || 'no email'}`,
    `User ID: ${userId}`,
    '',
    'Approve this user:',
    approvalUrl,
    '',
    `This link expires in ${ttlHours} hour(s).`
  ].join('\n');
};

const formatAdminApprovalMessage = ({ approverEmail, username, email, token, userId }) => {
  const approvalUrl = `${FRONTEND_URL}${APPROVAL_PATH}?token=${encodeURIComponent(token)}`;
  const ttlHours = Math.max(1, REGISTRATION_APPROVAL_TTL_HOURS);
  const subject = `Intellacc: New user pending approval: ${username}`;

  const text = toText({
    username,
    email,
    userId,
    approvalUrl,
    ttlHours
  });

  const html = toHtml({
    username,
    email,
    userId,
    approvalUrl,
    ttlHours
  });

  return { subject, text, html, approverEmail };
};

const createApprovalRequest = async (userId, user) => {
  const approverEmail = getRegistrationApproverEmail();
  let token = null;
  let expiresAt = null;
  let shouldSendNotification = true;
  const cooldownMs = Math.max(0, REGISTRATION_APPROVAL_RESEND_COOLDOWN_MINUTES) * 60 * 1000;

  try {
    const pending = await db.query(`
      SELECT id, token, token_hash, approver_email, created_at, expires_at
      FROM registration_approval_tokens
      WHERE user_id = $1
        AND status = 'pending'
      ORDER BY created_at DESC
      LIMIT 1
    `, [userId]);

    if (pending.rows.length > 0) {
      const existing = pending.rows[0];
      const createdAt = new Date(existing.created_at);
      const isRecent = Number.isFinite(createdAt.getTime()) &&
        Date.now() - createdAt.getTime() <= cooldownMs;
      const isValidToken = existing.token && (!existing.expires_at || new Date(existing.expires_at) > new Date());

      expiresAt = existing.expires_at;

      if (isRecent && isValidToken) {
        token = existing.token;
        shouldSendNotification = false;
      } else {
        token = buildApprovalToken(userId, existing.approver_email || approverEmail);
        const newExpiresAt = getExpiryDate();
        expiresAt = newExpiresAt;

        if (existing.expires_at && new Date(existing.expires_at) > new Date()) {
          await db.query(`
            UPDATE registration_approval_tokens
            SET token = $1,
                token_hash = $2,
                approver_email = COALESCE(NULLIF($3, ''), approver_email),
                expires_at = $4
            WHERE id = $5
          `, [token, hashToken(token), existing.approver_email || approverEmail, newExpiresAt, existing.id]);
        } else {
          await db.query(`DELETE FROM registration_approval_tokens WHERE user_id = $1 AND status = 'pending'`, [userId]);
        }
      }
    }
  } catch (err) {
    if (err.code !== '42703') {
      throw err;
    }
  }

  if (!token) {
    token = buildApprovalToken(userId, approverEmail);
    expiresAt = getExpiryDate();
    const tokenHash = hashToken(token);

    await db.query(`
      DELETE FROM registration_approval_tokens
      WHERE user_id = $1
        AND status = 'pending'
    `, [userId]);

    try {
      await db.query(`
        INSERT INTO registration_approval_tokens (user_id, token_hash, approver_email, status, expires_at, token)
        VALUES ($1, $2, $3, 'pending', $4, $5)
      `, [userId, tokenHash, approverEmail, expiresAt, token]);
    } catch (err) {
      if (err.code === '42703') {
        await db.query(`
          INSERT INTO registration_approval_tokens (user_id, token_hash, approver_email, status, expires_at)
          VALUES ($1, $2, $3, 'pending', $4)
        `, [userId, tokenHash, approverEmail, expiresAt]);
      } else {
        throw err;
      }
    }
  }

  const message = formatAdminApprovalMessage({
    approverEmail,
    username: user?.username,
    email: user?.email,
    token,
    userId
  });

  if (shouldSendNotification) {
    await emailVerificationService.sendEmail({
      to: approverEmail,
      subject: message.subject,
      html: message.html,
      text: message.text
    });
  }

  return { token, messageId: null, expiresAt, approverEmail };
};

const verifyApprovalToken = async (token) => {
  const payload = jwt.verify(token, REGISTRATION_APPROVAL_SECRET);

  if (payload?.type !== 'registration_approval' || !payload?.userId) {
    throw new Error('Invalid approval token');
  }

  const expectedApproverEmail = getRegistrationApproverEmail();
  const approverEmail = payload.approverEmail || expectedApproverEmail;
  if (
    expectedApproverEmail &&
    approverEmail &&
    approverEmail.toLowerCase() !== expectedApproverEmail.toLowerCase()
  ) {
    throw new Error('Invalid approver email in token');
  }

  const tokenHash = hashToken(token);
  const approvalResult = await db.query(`
    SELECT id, user_id, status, expires_at
    FROM registration_approval_tokens
    WHERE token_hash = $1
  `, [tokenHash]);

  if (approvalResult.rows.length === 0) {
    return {
      success: false,
      code: 'TOKEN_NOT_FOUND',
      message: 'Approval token not found'
    };
  }

  const approvalRow = approvalResult.rows[0];

  if (approvalRow.status !== 'pending') {
    if (approvalRow.status === 'approved') {
      return {
        success: true,
        userId: approvalRow.user_id,
        alreadyApproved: true
      };
    }

    return {
      success: false,
      code: 'TOKEN_ALREADY_USED',
      message: 'This approval link has already been used'
    };
  }

  if (new Date(approvalRow.expires_at) < new Date()) {
    await db.query(`
      UPDATE registration_approval_tokens
      SET status = 'expired', used_at = NOW()
      WHERE id = $1
    `, [approvalRow.id]);

    return {
      success: false,
      code: 'TOKEN_EXPIRED',
      message: 'This approval link has expired'
    };
  }

  await db.query(`
    UPDATE registration_approval_tokens
    SET status = 'approved', used_at = NOW()
    WHERE id = $1
  `, [approvalRow.id]);

  try {
    await db.query(`
      UPDATE users
      SET is_approved = true,
          approved_at = NOW()
      WHERE id = $1
    `, [approvalRow.user_id]);
  } catch (err) {
    if (err.code !== '42703') {
      throw err;
    }
  }

  return {
    success: true,
    userId: approvalRow.user_id
  };
};

const approveByToken = async (token) => {
  if (!isRegistrationApprovalRequired()) {
    return {
      success: false,
      status: 409,
      code: 'NOT_REQUIRED',
      message: 'Registration approval is not required'
    };
  }

  if (!token) {
    return {
      success: false,
      status: 400,
      code: 'TOKEN_REQUIRED',
      message: 'Approval token is required'
    };
  }

  try {
    const result = await verifyApprovalToken(token);

    if (!result.success) {
      return {
        success: false,
        status: 400,
        code: result.code,
        message: result.message
      };
    }

    if (result.alreadyApproved) {
      return {
        success: true,
        status: 200,
        userId: result.userId,
        alreadyApproved: true,
        message: 'This approval request has already been used.'
      };
    }

    return {
      success: true,
      status: 200,
      userId: result.userId
    };
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return {
        success: false,
        status: 400,
        code: 'TOKEN_EXPIRED',
        message: 'Approval token has expired'
      };
    }

    if (err.name === 'JsonWebTokenError') {
      return {
        success: false,
        status: 400,
        code: 'INVALID_TOKEN',
        message: 'Invalid approval token'
      };
    }

    return {
      success: false,
      status: 400,
      code: 'APPROVAL_FAILED',
      message: err.message || 'Failed to process approval'
    };
  }
};

exports.createApprovalRequest = createApprovalRequest;
exports.approveByToken = approveByToken;
exports.isRegistrationApprovalRequired = isRegistrationApprovalRequired;
