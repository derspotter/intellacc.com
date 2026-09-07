const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const db = require('../db');
const emailVerificationService = require('./emailVerificationService');
const ipIntelService = require('./ipIntelService');
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
const REJECT_PATH = '/api/admin/users/reject';
const SAME_NETWORK_WINDOW = '24 hours';
const rawResendCooldown = Number(process.env.REGISTRATION_APPROVAL_RESEND_COOLDOWN_MINUTES);
const REGISTRATION_APPROVAL_RESEND_COOLDOWN_MINUTES = Number.isFinite(rawResendCooldown) ? rawResendCooldown : 10;

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

// Human-readable lines describing where the signup came from. Only facts we
// actually have; flags appear only when set so a clean signup reads clean.
const describeSignupContext = (context) => {
  if (!context || !context.ip) return [];
  const intel = context.intel || { available: false };
  const lines = [`IP: ${context.ip}`];

  if (!intel.available) {
    lines.push('Network: lookup data not loaded yet');
  } else if (intel.asn) {
    const country = intel.country ? ` (${intel.country})` : '';
    lines.push(`Network: AS${intel.asn} ${intel.name || ''}${country}`.replace(/\s+\(/, ' ('));
  } else {
    lines.push('Network: unknown (address not in lookup data)');
  }

  const flags = [];
  if (intel.networkType === 'hosting') flags.push('hosting/cloud network');
  if (intel.torExit) flags.push('Tor exit');
  if (flags.length) lines.push(`Flags: ${flags.join(', ')}`);

  if (Number.isFinite(context.sameNetworkCount)) {
    const n = context.sameNetworkCount;
    lines.push(`${n} other signup${n === 1 ? '' : 's'} from this network in the last 24h`);
  }

  lines.push(`Browser: ${context.userAgent || '(no user agent)'}`);
  return lines;
};

const toHtml = ({ username, email, userId, approvalUrl, rejectUrl, ttlHours, contextLines }) => {
  const safeUsername = escapeHtml(username || '(no username)');
  const safeEmail = escapeHtml(email || 'no email');
  const safeApprovalUrl = escapeHtml(approvalUrl);
  const safeRejectUrl = escapeHtml(rejectUrl);
  const contextHtml = contextLines.length
    ? `<div style="background:#ffffff; border:1px solid #e5e7eb; border-radius:8px; padding:16px; margin-top:12px;">
      <div style="margin-bottom:8px; color:#6b7280; font-size:13px;">Signup context (deleted from our server once you decide)</div>
      ${contextLines.map((line) => `<div style="margin-bottom:6px; font-family:ui-monospace, SFMono-Regular, Menlo, monospace; font-size:13px;">${escapeHtml(line)}</div>`).join('\n      ')}
    </div>`
    : '';

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
    ${contextHtml}
    <p style="margin:16px 0;">
      <a href="${safeApprovalUrl}" style="display:inline-block;background:#2563eb;color:#fff;text-decoration:none;padding:12px 18px;border-radius:6px;font-weight:600;">Approve this user</a>
      &nbsp;
      <a href="${safeRejectUrl}" style="display:inline-block;background:#f3f4f6;color:#b91c1c;text-decoration:none;padding:12px 18px;border-radius:6px;font-weight:600;border:1px solid #e5e7eb;">Reject and delete</a>
    </p>
    <div style="color:#6b7280; font-size:13px; line-height:1.5;">
      <p style="margin:0 0 10px 0;">If the buttons do not work, open one of these links:</p>
      <p style="margin:0 0 8px 0; word-break:break-all;">Approve: ${safeApprovalUrl}</p>
      <p style="margin:0 0 8px 0; word-break:break-all;">Reject: ${safeRejectUrl}</p>
      <p style="margin:0 0 0 0;">These links expire in ${ttlHours} hour(s). Reject asks for confirmation before deleting.</p>
    </div>
  </div>
</body>
</html>`;
};

const toText = ({ username, email, userId, approvalUrl, rejectUrl, ttlHours, contextLines }) => {
  const contextBlock = contextLines.length
    ? ['', 'Signup context (deleted from our server once you decide):', ...contextLines]
    : [];
  return [
    'Intellacc Registration Approval',
    '',
    'A new user account is waiting for approval.',
    `User: ${username || '(no username)'}`,
    `Email: ${email || 'no email'}`,
    `User ID: ${userId}`,
    ...contextBlock,
    '',
    'Approve this user:',
    approvalUrl,
    '',
    'Reject and delete this account (asks for confirmation):',
    rejectUrl,
    '',
    `These links expire in ${ttlHours} hour(s).`
  ].join('\n');
};

const formatAdminApprovalMessage = ({ approverEmail, username, email, token, userId, context }) => {
  const approvalUrl = `${FRONTEND_URL}${APPROVAL_PATH}?token=${encodeURIComponent(token)}`;
  const rejectUrl = `${FRONTEND_URL}${REJECT_PATH}?token=${encodeURIComponent(token)}`;
  const ttlHours = Math.max(1, REGISTRATION_APPROVAL_TTL_HOURS);
  const subject = `Intellacc: New user pending approval: ${username}`;
  const contextLines = describeSignupContext(context);

  const text = toText({
    username,
    email,
    userId,
    approvalUrl,
    rejectUrl,
    ttlHours,
    contextLines
  });

  const html = toHtml({
    username,
    email,
    userId,
    approvalUrl,
    rejectUrl,
    ttlHours,
    contextLines
  });

  return { subject, text, html, approverEmail };
};

const SIGNUP_CONTEXT_COLUMNS = ['signup_ip', 'signup_user_agent', 'signup_asn'];
const CLEAR_SIGNUP_CONTEXT_SQL = SIGNUP_CONTEXT_COLUMNS.map((column) => `${column} = NULL`).join(', ');

// Drops the signup context from a token row the moment it is no longer
// pending. Tolerates a pre-migration schema (42703) like the rest of this file.
const clearSignupContext = async (rowId) => {
  try {
    await db.query(`UPDATE registration_approval_tokens SET ${CLEAR_SIGNUP_CONTEXT_SQL} WHERE id = $1`, [rowId]);
  } catch (err) {
    if (err.code !== '42703') throw err;
  }
};

// Safety net for rows that expire without anyone clicking: run daily.
const scrubStaleSignupContext = async () => {
  try {
    const result = await db.query(`
      UPDATE registration_approval_tokens
      SET ${CLEAR_SIGNUP_CONTEXT_SQL}
      WHERE (signup_ip IS NOT NULL OR signup_user_agent IS NOT NULL OR signup_asn IS NOT NULL)
        AND (status <> 'pending' OR expires_at < NOW())
    `);
    return result.rowCount;
  } catch (err) {
    if (err.code === '42703') return 0;
    throw err;
  }
};

// A misconfigured proxy may forward "ip:port" or "[v6]:port"; keep the address.
const stripPort = (value) => {
  const bracketed = value.match(/^\[([0-9a-fA-F:.]+)\](?::\d+)?$/);
  if (bracketed) return bracketed[1];
  const v4WithPort = value.match(/^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/);
  if (v4WithPort) return v4WithPort[1];
  return value;
};

const normaliseSignupContext = (context) => {
  const ip = typeof context?.ip === 'string' ? stripPort(context.ip.trim()) : '';
  const userAgent = typeof context?.userAgent === 'string' ? context.userAgent.trim().slice(0, 512) : '';
  if (!ip) return null;
  return { ip, userAgent: userAgent || null, intel: ipIntelService.lookup(ip) };
};

// Persists ip/ua/asn on the pending row and returns the context enriched with
// the same-network count. A resend without context leaves stored values alone.
const storeSignupContext = async (userId, context) => {
  if (!context) return null;
  try {
    await db.query(`
      UPDATE registration_approval_tokens
      SET signup_ip = $2::inet, signup_user_agent = $3, signup_asn = $4
      WHERE user_id = $1 AND status = 'pending'
    `, [userId, context.ip, context.userAgent, context.intel.asn]);

    let sameNetworkCount = null;
    if (context.intel.asn) {
      const countResult = await db.query(`
        SELECT COUNT(DISTINCT user_id)::int AS n
        FROM registration_approval_tokens
        WHERE signup_asn = $2
          AND user_id <> $1
          AND created_at > NOW() - $3::interval
      `, [userId, context.intel.asn, SAME_NETWORK_WINDOW]);
      sameNetworkCount = countResult.rows[0]?.n ?? 0;
    }
    return { ...context, sameNetworkCount };
  } catch (err) {
    if (err.code === '42703' || err.code === '22P02') {
      console.warn('[RegistrationApproval] Could not store signup context:', err.message);
      return { ...context, sameNetworkCount: null };
    }
    throw err;
  }
};

const createApprovalRequest = async (userId, user, signupContext = null) => {
  const approverEmail = getRegistrationApproverEmail();
  let token = null;
  let tokenHash = null;
  let expiresAt = null;
  let shouldSendNotification = true;
  let hasLastNotifiedColumn = true;
  const cooldownMs = Math.max(0, REGISTRATION_APPROVAL_RESEND_COOLDOWN_MINUTES) * 60 * 1000;
  const now = new Date();

  try {
    try {
      const pending = await db.query(`
        SELECT id, token, token_hash, approver_email, created_at, expires_at, last_notified_at
        FROM registration_approval_tokens
        WHERE user_id = $1
          AND status = 'pending'
        ORDER BY created_at DESC
        LIMIT 1
      `, [userId]);
      hasLastNotifiedColumn = true;
      if (pending.rows.length > 0) {
        const existing = pending.rows[0];
        const isRecentNotification = existing.last_notified_at &&
          Number.isFinite(new Date(existing.last_notified_at).getTime()) &&
          (now.getTime() - new Date(existing.last_notified_at).getTime() <= cooldownMs);

        expiresAt = existing.expires_at;

        if (existing.token && isRecentNotification) {
          token = existing.token;
          shouldSendNotification = false;
        } else {
          token = buildApprovalToken(userId, existing.approver_email || approverEmail);
          tokenHash = hashToken(token);
          const newExpiresAt = getExpiryDate();
          expiresAt = newExpiresAt;

          if (existing.expires_at && new Date(existing.expires_at) > now) {
            await db.query(`
              UPDATE registration_approval_tokens
              SET token = $1,
                  token_hash = $2,
                  approver_email = COALESCE(NULLIF($3, ''), approver_email),
                  expires_at = $4
              WHERE id = $5
            `, [token, tokenHash, existing.approver_email || approverEmail, newExpiresAt, existing.id]);
          } else {
            await db.query(`DELETE FROM registration_approval_tokens WHERE user_id = $1 AND status = 'pending'`, [userId]);
          }
        }
      }
    } catch (err) {
      if (err.code === '42703') {
        hasLastNotifiedColumn = false;
        const legacyPending = await db.query(`
          SELECT id, token, token_hash, approver_email, created_at, expires_at
          FROM registration_approval_tokens
          WHERE user_id = $1
            AND status = 'pending'
          ORDER BY created_at DESC
          LIMIT 1
        `, [userId]);

        if (legacyPending.rows.length > 0) {
          const existing = legacyPending.rows[0];
          const isRecent = Number.isFinite(new Date(existing.created_at).getTime()) &&
            now.getTime() - new Date(existing.created_at).getTime() <= cooldownMs;
          const hasValidToken = existing.token && (!existing.expires_at || new Date(existing.expires_at) > now);

          expiresAt = existing.expires_at;

          if (isRecent && hasValidToken) {
            token = existing.token;
            shouldSendNotification = false;
          } else {
            token = buildApprovalToken(userId, existing.approver_email || approverEmail);
            tokenHash = hashToken(token);
            const newExpiresAt = getExpiryDate();
            expiresAt = newExpiresAt;

            if (existing.expires_at && new Date(existing.expires_at) > now) {
              await db.query(`
                UPDATE registration_approval_tokens
                SET token = $1,
                    token_hash = $2,
                    approver_email = COALESCE(NULLIF($3, ''), approver_email),
                    expires_at = $4
                WHERE id = $5
              `, [token, tokenHash, existing.approver_email || approverEmail, newExpiresAt, existing.id]);
            } else {
              await db.query(`DELETE FROM registration_approval_tokens WHERE user_id = $1 AND status = 'pending'`, [userId]);
            }
          }
        }
      } else {
        throw err;
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
    tokenHash = hashToken(token);

    await db.query(`
      DELETE FROM registration_approval_tokens
      WHERE user_id = $1
        AND status = 'pending'
    `, [userId]);

    try {
      const insertColumns = hasLastNotifiedColumn
        ? '(user_id, token_hash, approver_email, status, expires_at, token, last_notified_at)'
        : '(user_id, token_hash, approver_email, status, expires_at, token)';
      const insertValues = hasLastNotifiedColumn
        ? '($1, $2, $3, \'pending\', $4, $5, NOW())'
        : '($1, $2, $3, \'pending\', $4, $5)';
      const insertSql = `
        INSERT INTO registration_approval_tokens (user_id, token_hash, approver_email, status, expires_at, token)
        VALUES ($1, $2, $3, 'pending', $4, $5)
      `;
      await db.query(
        hasLastNotifiedColumn
          ? `
            INSERT INTO registration_approval_tokens ${insertColumns}
            VALUES ${insertValues}
          `
          : insertSql,
        [userId, tokenHash, approverEmail, expiresAt, token]
      );
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

  const context = await storeSignupContext(userId, normaliseSignupContext(signupContext));

  const message = formatAdminApprovalMessage({
    approverEmail,
    username: user?.username,
    email: user?.email,
    token,
    userId,
    context
  });

  if (shouldSendNotification) {
    await emailVerificationService.sendEmail({
      to: approverEmail,
      subject: message.subject,
      html: message.html,
      text: message.text
    });
    if (hasLastNotifiedColumn) {
      try {
        await db.query(`
          UPDATE registration_approval_tokens
          SET last_notified_at = NOW()
          WHERE user_id = $1
            AND status = 'pending'
            AND token_hash = $2
        `, [userId, tokenHash]);
      } catch (err) {
        if (err.code !== '42703') {
          console.warn('[RegistrationApproval] Failed to update last_notified_at:', err.message);
        }
      }
    }
  }

  return { token, messageId: null, expiresAt, approverEmail };
};

const resolveFallbackApprovalState = async (userId) => {
  const latestForUserResult = await db.query(`
    SELECT id, user_id, status, expires_at
    FROM registration_approval_tokens
    WHERE user_id = $1
    ORDER BY created_at DESC
    LIMIT 1
  `, [userId]);

  return latestForUserResult.rows[0] || null;
};

// Shared by approve and reject: validates the JWT, finds the token row and
// classifies it. Marks (and scrubs) an expired pending row as a side effect.
//   -> { kind: 'pending', row }
//   -> { kind: 'approved', userId }
//   -> { kind: 'error', code, message }
const locateApprovalRow = async (token) => {
  const sanitizedToken = String(token).replace(/\s+/g, '');
  const payload = jwt.verify(sanitizedToken, REGISTRATION_APPROVAL_SECRET);

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

  const tokenHash = hashToken(sanitizedToken);
  const approvalResult = await db.query(`
    SELECT id, user_id, status, expires_at
    FROM registration_approval_tokens
    WHERE token_hash = $1
  `, [tokenHash]);

  if (approvalResult.rows.length === 0) {
    const latestForUser = await resolveFallbackApprovalState(payload.userId);
    if (!latestForUser) {
      return { kind: 'error', code: 'TOKEN_NOT_FOUND', message: 'Approval token not found' };
    }
    if (latestForUser.status === 'approved') {
      return { kind: 'approved', userId: latestForUser.user_id };
    }
    if (latestForUser.status === 'pending') {
      return {
        kind: 'error',
        code: 'TOKEN_REPLACED',
        message: 'A newer approval link has been issued. Please use the most recent email.'
      };
    }
    return { kind: 'error', code: 'TOKEN_EXPIRED', message: 'This approval link has expired' };
  }

  const approvalRow = approvalResult.rows[0];

  if (approvalRow.status !== 'pending') {
    if (approvalRow.status === 'approved') {
      return { kind: 'approved', userId: approvalRow.user_id };
    }
    return { kind: 'error', code: 'TOKEN_ALREADY_USED', message: 'This approval link has already been used' };
  }

  if (new Date(approvalRow.expires_at) < new Date()) {
    await db.query(`
      UPDATE registration_approval_tokens
      SET status = 'expired', used_at = NOW()
      WHERE id = $1
    `, [approvalRow.id]);
    await clearSignupContext(approvalRow.id);
    return { kind: 'error', code: 'TOKEN_EXPIRED', message: 'This approval link has expired' };
  }

  return { kind: 'pending', row: approvalRow };
};

const verifyApprovalToken = async (token) => {
  const located = await locateApprovalRow(token);
  if (located.kind === 'error') {
    return { success: false, code: located.code, message: located.message };
  }
  if (located.kind === 'approved') {
    return { success: true, userId: located.userId, alreadyApproved: true };
  }
  const approvalRow = located.row;

  await db.query(`
    UPDATE registration_approval_tokens
    SET status = 'approved', used_at = NOW()
    WHERE id = $1
  `, [approvalRow.id]);
  await clearSignupContext(approvalRow.id);

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

  // Kick off email verification for the freshly approved user. Signup skips
  // it while approval is pending, and posting requires a verified email — so
  // without this mail an approved user silently cannot post.
  try {
    const userRow = await db.query(
      'SELECT email, email_verified_at FROM users WHERE id = $1',
      [approvalRow.user_id]
    );
    const user = userRow.rows[0];
    if (user && !user.email_verified_at) {
      const { sendVerificationEmail } = require('./emailVerificationService');
      await sendVerificationEmail(approvalRow.user_id, user.email);
    }
  } catch (err) {
    console.error('[RegistrationApproval] Failed to send post-approval verification email:', err.message);
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

const tokenErrorResult = (err) => {
  if (err.name === 'TokenExpiredError') {
    return { success: false, status: 400, code: 'TOKEN_EXPIRED', message: 'Approval token has expired' };
  }
  if (err.name === 'JsonWebTokenError') {
    return { success: false, status: 400, code: 'INVALID_TOKEN', message: 'Invalid approval token' };
  }
  return { success: false, status: 400, code: 'APPROVAL_FAILED', message: err.message || 'Failed to process request' };
};

const ALREADY_APPROVED_MESSAGE = 'This registration has already been approved. Rejecting is only possible while it is pending.';

// Read-only: who would be deleted? Backs the confirmation page so that a mail
// client prefetching the reject link cannot delete anything.
const previewRejectByToken = async (token) => {
  if (!token) {
    return { success: false, status: 400, code: 'TOKEN_REQUIRED', message: 'Approval token is required' };
  }
  try {
    const located = await locateApprovalRow(token);
    if (located.kind === 'error') {
      return { success: false, status: 400, code: located.code, message: located.message };
    }
    if (located.kind === 'approved') {
      return { success: false, status: 400, code: 'ALREADY_APPROVED', message: ALREADY_APPROVED_MESSAGE };
    }
    const userResult = await db.query('SELECT id, username, email FROM users WHERE id = $1', [located.row.user_id]);
    const user = userResult.rows[0];
    if (!user) {
      return { success: false, status: 400, code: 'USER_NOT_FOUND', message: 'This account no longer exists.' };
    }
    return { success: true, status: 200, user };
  } catch (err) {
    return tokenErrorResult(err);
  }
};

// Deletes a never-approved account outright. The cascade removes the token
// row (and with it the signup context); nothing about the person remains.
const rejectByToken = async (token) => {
  if (!isRegistrationApprovalRequired()) {
    return { success: false, status: 409, code: 'NOT_REQUIRED', message: 'Registration approval is not required' };
  }
  const preview = await previewRejectByToken(token);
  if (!preview.success) return preview;

  const { user } = preview;
  const guard = await db.query('SELECT is_approved FROM users WHERE id = $1', [user.id]);
  if (guard.rows[0]?.is_approved === true) {
    return { success: false, status: 400, code: 'ALREADY_APPROVED', message: ALREADY_APPROVED_MESSAGE };
  }

  await db.query('DELETE FROM users WHERE id = $1 AND is_approved = FALSE', [user.id]);
  console.log(`[RegistrationApproval] Rejected and deleted pending user ${user.id} (${user.username})`);
  return {
    success: true,
    status: 200,
    userId: user.id,
    username: user.username,
    message: `Registration rejected. The account "${user.username}" has been deleted.`
  };
};

exports.createApprovalRequest = createApprovalRequest;
exports.approveByToken = approveByToken;
exports.previewRejectByToken = previewRejectByToken;
exports.rejectByToken = rejectByToken;
exports.scrubStaleSignupContext = scrubStaleSignupContext;
exports.formatAdminApprovalMessage = formatAdminApprovalMessage;
exports.isRegistrationApprovalRequired = isRegistrationApprovalRequired;
