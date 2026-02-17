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

const toHtml = (text) => {
  const safeText = String(text || '').replace(/[&<>"]|'/g, (match) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[match]);

  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; }
        .container { max-width: 640px; margin: 0 auto; padding: 20px; }
        .card { background: #f8f9fa; border: 1px solid #ddd; border-radius: 8px; padding: 20px; }
        .button {
          display: inline-block;
          background: #2563eb;
          color: #fff;
          text-decoration: none;
          padding: 10px 16px;
          border-radius: 4px;
          font-weight: 600;
          margin: 10px 0;
        }
        .muted {
          color: #6b7280;
          font-size: 12px;
          word-break: break-all;
          margin-top: 8px;
        }
      </style>
    </head>
    <body>
      <div class="container">
        <h2>Intellacc Registration Approval</h2>
        <div class="card">
          <p>${safeText}</p>
        </div>
      </div>
    </body>
    </html>
  `;
};

const formatAdminApprovalMessage = ({ approverEmail, username, email, token, userId }) => {
  const approvalUrl = `${FRONTEND_URL}${APPROVAL_PATH}?token=${encodeURIComponent(token)}`;
  const details = `New user account request: ${username || '(no username)'} (${email || 'no email'}), ID: ${userId}.`;
  const subject = `Intellacc: New user pending approval: ${username}`;
  const text = `
You have a new user registration request on Intellacc.

${details}

Approve user: ${approvalUrl}

This link expires in ${Math.max(1, REGISTRATION_APPROVAL_TTL_HOURS)} hour(s).
  `.trim();

  const html = toHtml(`
    <p>You have a new user registration request on Intellacc.</p>
    <p>${details}</p>
    <p><a class="button" href="${approvalUrl}">Approve this user</a></p>
    <p class="muted">If the button does not work, open this link: ${approvalUrl}</p>
    <p class="muted">This link expires in ${Math.max(1, REGISTRATION_APPROVAL_TTL_HOURS)} hour(s).</p>
  `);

  return { subject, text, html, approverEmail };
};

const createApprovalRequest = async (userId, user) => {
  const approverEmail = getRegistrationApproverEmail();
  const token = buildApprovalToken(userId, approverEmail);
  const tokenHash = hashToken(token);
  const expiresAt = getExpiryDate();

  await db.query(`
    DELETE FROM registration_approval_tokens
    WHERE user_id = $1
      AND status = 'pending'
  `, [userId]);

  await db.query(`
    INSERT INTO registration_approval_tokens (user_id, token_hash, approver_email, status, expires_at)
    VALUES ($1, $2, $3, 'pending', $4)
  `, [userId, tokenHash, approverEmail, expiresAt]);

  const message = formatAdminApprovalMessage({
    approverEmail,
    username: user?.username,
    email: user?.email,
    token,
    userId
  });

  await emailVerificationService.sendEmail({
    to: approverEmail,
    subject: message.subject,
    html: message.html,
    text: message.text
  });

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
