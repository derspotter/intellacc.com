/**
 * PayPal Payment Verification Service (Tier 3 alternative to Stripe)
 *
 * Uses the Payment Method Tokens API's purchase-less vault flow — the exact
 * PayPal analogue of a Stripe SetupIntent:
 *   1. POST /v3/vault/setup-tokens        -> approval URL (no money moves)
 *   2. buyer approves in PayPal
 *   3. POST /v3/vault/payment-tokens      -> permanent token; PayPal also
 *      fires VAULT.PAYMENT-TOKEN.CREATED to /api/webhooks/paypal.
 * Step 3 confirms synchronously, so the tier upgrade happens there; the
 * webhook is an idempotent belt-and-braces path (and covers approvals that
 * finish after the user closed our tab).
 */
const db = require('../db');

const getApiBase = () => process.env.PAYPAL_API_BASE || 'https://api-m.sandbox.paypal.com';
const getClientId = () => process.env.PAYPAL_CLIENT_ID;
const getClientSecret = () => process.env.PAYPAL_CLIENT_SECRET;
const getWebhookId = () => process.env.PAYPAL_WEBHOOK_ID;
const getPaymentVerificationEnabledEnv = () => process.env.PAYMENT_VERIFICATION_ENABLED;

const isJestRuntime = () => {
  return Boolean(
    process.env.JEST_WORKER_ID ||
    process.env.npm_lifecycle_event === 'test' ||
    process.argv.some((arg) => arg.endsWith('/jest') || arg.includes('/jest') || arg.includes('\\jest'))
  );
};

const parseBool = (value, defaultValue = false) => {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return defaultValue;
  return normalized === 'true' || normalized === '1' || normalized === 'yes';
};

const isPaypalConfigured = () => !isJestRuntime() && !!(getClientId() && getClientSecret());
const isProduction = () => process.env.NODE_ENV === 'production';
const isEnabled = () => parseBool(getPaymentVerificationEnabledEnv(), true);

const assertProviderAvailable = () => {
  if (!isEnabled()) {
    throw new Error('Payment verification is disabled by configuration.');
  }
  if (!isPaypalConfigured()) {
    throw new Error('PayPal verification is not configured');
  }
};

const getProviderStatus = () => {
  const enabled = isEnabled();
  const configured = isPaypalConfigured();
  const available = enabled && configured;
  const requiresConfig = process.env.REQUIRE_PAYPAL_VERIFICATION === 'true';

  return {
    provider: 'paypal',
    configured,
    required: requiresConfig,
    enabled,
    available,
    reason: available
      ? null
      : (!enabled
        ? 'Payment verification is disabled by configuration.'
        : 'PayPal verification credentials are not configured.')
  };
};

// ---- PayPal HTTP plumbing ----

let cachedToken = null;
let cachedTokenExpiresAt = 0;

const getAccessToken = async () => {
  if (cachedToken && Date.now() < cachedTokenExpiresAt - 60_000) {
    return cachedToken;
  }
  const credentials = Buffer.from(`${getClientId()}:${getClientSecret()}`).toString('base64');
  const response = await fetch(`${getApiBase()}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: 'grant_type=client_credentials'
  });
  const body = await response.json();
  if (!response.ok || !body.access_token) {
    throw new Error(`PayPal auth failed (${response.status}): ${body.error_description || body.error || 'unknown'}`);
  }
  cachedToken = body.access_token;
  cachedTokenExpiresAt = Date.now() + (body.expires_in || 300) * 1000;
  return cachedToken;
};

const paypalFetch = async (path, { method = 'POST', body, requestId } = {}) => {
  const token = await getAccessToken();
  const response = await fetch(`${getApiBase()}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(requestId ? { 'PayPal-Request-Id': requestId } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await response.text();
  let json = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  if (!response.ok) {
    const detail = json.details?.[0]?.description || json.message || json.error || text;
    throw new Error(`PayPal API ${path} failed (${response.status}): ${detail}`);
  }
  return json;
};

// ---- Verification flow ----

const ensurePhoneVerified = async (userId) => {
  const result = await db.query('SELECT verification_tier, email FROM users WHERE id = $1', [userId]);
  if (result.rows.length === 0) {
    throw new Error('User not found');
  }
  if ((result.rows[0].verification_tier || 0) < 2) {
    throw new Error('Phone verification required first');
  }
  return result.rows[0];
};

const markVerified = async (userId, providerId) => {
  await db.query(`
    INSERT INTO payment_verifications (user_id, provider, verification_method, verified_at)
    VALUES ($1, 'paypal', 'paypal_vault', NOW())
    ON CONFLICT (user_id, provider) DO UPDATE SET
      verification_method = 'paypal_vault',
      verified_at = NOW()
  `, [userId]);

  await db.query(`
    INSERT INTO user_verifications (user_id, tier, verification_type, provider, status, provider_id, verified_at)
    VALUES ($1, 3, 'payment', 'paypal', 'verified', $2, NOW())
    ON CONFLICT (user_id, tier) DO UPDATE SET
      status = 'verified',
      provider = 'paypal',
      provider_id = $2,
      verified_at = NOW(),
      updated_at = NOW()
  `, [userId, providerId]);

  await db.query(`
    UPDATE users SET verification_tier = GREATEST(verification_tier, 3)
    WHERE id = $1
  `, [userId]);
};

exports.createVerificationSession = async (userId, { returnUrl, cancelUrl } = {}) => {
  assertProviderAvailable();
  await ensurePhoneVerified(userId);

  const frontendBase = (process.env.FRONTEND_URL || 'https://intellacc.com').replace(/\/$/, '');
  const setupToken = await paypalFetch('/v3/vault/setup-tokens', {
    requestId: `verify-${userId}-${Date.now()}`,
    body: {
      payment_source: {
        paypal: {
          usage_type: 'MERCHANT',
          permit_multiple_payment_tokens: false,
          // Plain #settings for both: the SPA's hash router doesn't parse
          // query-in-hash, and the frontend tracks the pending setup token in
          // sessionStorage anyway (confirm fails cleanly for a cancelled,
          // never-approved token).
          experience_context: {
            return_url: returnUrl || `${frontendBase}/#settings`,
            cancel_url: cancelUrl || `${frontendBase}/#settings`
          }
        }
      }
    }
  });

  const approveUrl = (setupToken.links || []).find((link) => link.rel === 'approve')?.href;
  if (!setupToken.id || !approveUrl) {
    throw new Error('PayPal did not return an approval link');
  }

  // Remember the PayPal customer id so the webhook can resolve the user even
  // if the synchronous confirm never runs.
  const paypalCustomerId = setupToken.customer?.id || null;
  await db.query(`
    INSERT INTO payment_verifications (user_id, provider, provider_customer_id)
    VALUES ($1, 'paypal', $2)
    ON CONFLICT (user_id, provider) DO UPDATE SET
      provider_customer_id = EXCLUDED.provider_customer_id
  `, [userId, paypalCustomerId]);

  await db.query(`
    INSERT INTO user_verifications (user_id, tier, verification_type, provider, status, provider_id)
    VALUES ($1, 3, 'payment', 'paypal', 'pending', $2)
    ON CONFLICT (user_id, tier) DO UPDATE SET
      status = 'pending',
      provider = 'paypal',
      provider_id = $2,
      updated_at = NOW()
  `, [userId, setupToken.id]);

  return {
    provider: 'paypal',
    setupTokenId: setupToken.id,
    approveUrl
  };
};

exports.confirmSetupToken = async (userId, setupTokenId) => {
  assertProviderAvailable();

  // Only accept the setup token this user's pending verification created.
  const pending = await db.query(`
    SELECT provider_id FROM user_verifications
    WHERE user_id = $1 AND tier = 3 AND provider = 'paypal' AND status = 'pending'
  `, [userId]);
  if (pending.rows.length === 0 || pending.rows[0].provider_id !== setupTokenId) {
    throw new Error('No pending PayPal verification for this setup token');
  }

  const paymentToken = await paypalFetch('/v3/vault/payment-tokens', {
    requestId: `confirm-${userId}-${setupTokenId}`,
    body: {
      payment_source: {
        token: { id: setupTokenId, type: 'SETUP_TOKEN' }
      }
    }
  });

  if (!paymentToken.id) {
    throw new Error('PayPal did not return a payment token');
  }

  await markVerified(userId, paymentToken.id);
  return { status: 'verified', paymentTokenId: paymentToken.id };
};

exports.handlePaymentTokenCreated = async (resource, eventId = null) => {
  const paypalCustomerId = resource?.customer?.id || null;
  if (!paypalCustomerId) {
    console.warn('[PaypalVerification] VAULT.PAYMENT-TOKEN.CREATED without customer id:', eventId);
    return { status: 'unresolved_user', event_id: eventId };
  }

  const lookup = await db.query(
    'SELECT user_id FROM payment_verifications WHERE provider = $1 AND provider_customer_id = $2',
    ['paypal', paypalCustomerId]
  );
  const userId = lookup.rows[0]?.user_id || null;
  if (!userId) {
    console.warn('[PaypalVerification] Unable to resolve user for customer:', paypalCustomerId);
    return { status: 'unresolved_user', event_id: eventId };
  }

  const existingVerified = await db.query(`
    SELECT 1 FROM user_verifications
    WHERE user_id = $1 AND tier = 3 AND verification_type = 'payment' AND status = 'verified'
    LIMIT 1
  `, [userId]);
  if (existingVerified.rows.length > 0) {
    return { status: 'already_verified', event_id: eventId, alreadyVerified: true };
  }

  await markVerified(userId, resource.id || null);
  return { status: 'verified', event_id: eventId, alreadyVerified: false };
};

/**
 * Verify a webhook delivery against PayPal (they use a webhook ID plus their
 * verification API instead of an HMAC secret like Stripe).
 */
exports.verifyWebhookSignature = async (headers, event) => {
  const webhookId = getWebhookId();
  if (!webhookId) {
    if (isProduction()) {
      throw new Error('PayPal webhook id not configured');
    }
    return true; // dev/test without webhook id: accept (mirrors Stripe handler)
  }

  const result = await paypalFetch('/v1/notifications/verify-webhook-signature', {
    body: {
      auth_algo: headers['paypal-auth-algo'],
      cert_url: headers['paypal-cert-url'],
      transmission_id: headers['paypal-transmission-id'],
      transmission_sig: headers['paypal-transmission-sig'],
      transmission_time: headers['paypal-transmission-time'],
      webhook_id: webhookId,
      webhook_event: event
    }
  });
  return result.verification_status === 'SUCCESS';
};

exports.isEnabled = isEnabled;
exports.getProviderStatus = getProviderStatus;
