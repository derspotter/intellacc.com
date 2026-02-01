/**
 * Payment Verification Service
 * Uses Stripe SetupIntents to verify a payment method
 */
const db = require('../db');

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const STRIPE_PUBLISHABLE_KEY = process.env.STRIPE_PUBLISHABLE_KEY;

let stripeClient = null;

const getStripeClient = () => {
  if (!STRIPE_SECRET_KEY) {
    throw new Error('Stripe is not configured');
  }
  if (!stripeClient) {
    const stripe = require('stripe');
    stripeClient = stripe(STRIPE_SECRET_KEY);
  }
  return stripeClient;
};

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

exports.createVerificationSession = async (userId) => {
  const user = await ensurePhoneVerified(userId);

  if (!STRIPE_PUBLISHABLE_KEY) {
    throw new Error('Stripe publishable key is missing');
  }

  const stripe = getStripeClient();

  let customerId;
  const existing = await db.query(
    'SELECT provider_customer_id FROM payment_verifications WHERE user_id = $1 AND provider = $2',
    [userId, 'stripe']
  );

  if (existing.rows.length > 0 && existing.rows[0].provider_customer_id) {
    customerId = existing.rows[0].provider_customer_id;
  } else {
    const customer = await stripe.customers.create({
      email: user.email,
      metadata: { intellacc_user_id: String(userId) }
    });
    customerId = customer.id;

    if (existing.rows.length > 0) {
      await db.query(`
        UPDATE payment_verifications
        SET provider_customer_id = $2
        WHERE user_id = $1 AND provider = 'stripe'
      `, [userId, customerId]);
    } else {
      await db.query(`
        INSERT INTO payment_verifications (user_id, provider, provider_customer_id)
        VALUES ($1, 'stripe', $2)
      `, [userId, customerId]);
    }
  }

  const setupIntent = await stripe.setupIntents.create({
    customer: customerId,
    payment_method_types: ['card'],
    metadata: {
      purpose: 'verification',
      user_id: String(userId)
    }
  });

  await db.query(`
    INSERT INTO user_verifications (user_id, tier, verification_type, provider, status, provider_id)
    VALUES ($1, 3, 'payment', 'stripe', 'pending', $2)
    ON CONFLICT (user_id, tier) DO UPDATE SET
      status = 'pending',
      provider = 'stripe',
      provider_id = $2,
      updated_at = NOW()
  `, [userId, setupIntent.id]);

  return {
    clientSecret: setupIntent.client_secret,
    publishableKey: STRIPE_PUBLISHABLE_KEY
  };
};

exports.handleSetupIntentSucceeded = async (setupIntent) => {
  let resolvedUserId = setupIntent.metadata?.user_id
    ? parseInt(setupIntent.metadata.user_id, 10)
    : null;

  if (!resolvedUserId && setupIntent.customer) {
    const lookup = await db.query(
      'SELECT user_id FROM payment_verifications WHERE provider = $1 AND provider_customer_id = $2',
      ['stripe', setupIntent.customer]
    );
    resolvedUserId = lookup.rows[0]?.user_id || null;
  }

  if (!resolvedUserId) {
    console.warn('[PaymentVerification] Unable to resolve user for SetupIntent:', setupIntent.id);
    return;
  }

  await db.query(`
    UPDATE payment_verifications
    SET verification_method = 'card_check', verified_at = NOW()
    WHERE user_id = $1 AND provider = 'stripe'
  `, [resolvedUserId]);

  await db.query(`
    INSERT INTO user_verifications (user_id, tier, verification_type, provider, status, verified_at)
    VALUES ($1, 3, 'payment', 'stripe', 'verified', NOW())
    ON CONFLICT (user_id, tier) DO UPDATE SET
      status = 'verified',
      verified_at = NOW(),
      updated_at = NOW()
  `, [resolvedUserId]);

  await db.query(`
    UPDATE users SET verification_tier = GREATEST(verification_tier, 3)
    WHERE id = $1
  `, [resolvedUserId]);
};

exports.constructWebhookEvent = (payload, signature, webhookSecret) => {
  const stripe = getStripeClient();
  return stripe.webhooks.constructEvent(payload, signature, webhookSecret);
};
