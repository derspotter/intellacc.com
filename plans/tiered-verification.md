# Tiered Identity Verification + AI Detection System

## Overview

A 3-tier verification system combined with AI content detection to:
1. Prevent spam accounts
2. Achieve sybil resistance (1 phone = 1 account)
3. Prove financial identity (payment method = real person)
4. Detect and flag AI-generated content

**No real money involved** - this is purely for identity assurance and bot prevention.

---

## System Components

### Verification Tiers

| Tier | Method | Purpose | Cost |
|------|--------|---------|------|
| 0 | None | Read-only access | Free |
| 1 | Email | Spam prevention, account recovery | Free |
| 2 | Phone (hashed) | Sybil resistance, 1 phone = 1 account | ~$0.05 |
| 3 | Payment Method | Financial identity = real person | ~$0.50-1 |

### AI Content Detection (Pangram)

All user-generated content is analyzed for AI generation:
- Posts
- Comments
- Messages (if not E2EE)
- Profile bios

---

## Feature Gating

| Feature | Required Tier |
|---------|---------------|
| Read content | 0 (none) |
| Create account | 0 (none) |
| Post, comment | 1 (email) |
| Send messages | 1 (email) |
| Prediction markets | 2 (phone) |
| Create markets | 3 (payment) |
| Governance voting | 3 (payment) |

---

## Database Schema

### Migration: `add_user_verifications.sql`

```sql
-- Verification tracking table
CREATE TABLE user_verifications (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    tier INTEGER NOT NULL CHECK (tier BETWEEN 1 AND 3),
    verification_type VARCHAR(50) NOT NULL, -- 'email', 'phone', 'payment'
    provider VARCHAR(50) NOT NULL, -- 'internal', 'twilio', 'stripe', 'paypal'
    status VARCHAR(20) NOT NULL DEFAULT 'pending', -- 'pending', 'verified', 'failed', 'revoked'
    provider_id VARCHAR(255), -- External reference ID
    verified_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Enforce sequential tiers: can't verify tier N without tier N-1
CREATE UNIQUE INDEX idx_user_verifications_user_tier ON user_verifications(user_id, tier);

-- Phone uniqueness for sybil resistance (store hash only)
CREATE TABLE phone_hashes (
    id SERIAL PRIMARY KEY,
    phone_hash VARCHAR(64) NOT NULL UNIQUE, -- SHA-256 of normalized E.164 number
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Payment method verification (no sensitive data stored)
CREATE TABLE payment_verifications (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider VARCHAR(20) NOT NULL, -- 'stripe', 'paypal'
    provider_customer_id VARCHAR(255), -- Stripe customer ID or PayPal payer ID
    verification_method VARCHAR(50), -- 'card_check', 'micro_deposit', 'paypal_auth'
    verified_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW()
);

-- AI detection results
CREATE TABLE content_ai_analysis (
    id SERIAL PRIMARY KEY,
    content_type VARCHAR(20) NOT NULL, -- 'post', 'comment', 'bio'
    content_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    ai_probability DECIMAL(5,4), -- 0.0000 to 1.0000
    detected_model VARCHAR(50), -- 'chatgpt', 'claude', 'gemini', etc.
    is_flagged BOOLEAN DEFAULT FALSE,
    analyzed_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_ai_analysis_flagged ON content_ai_analysis(is_flagged) WHERE is_flagged = TRUE;

-- Update users table
ALTER TABLE users
ADD COLUMN verification_tier INTEGER DEFAULT 0,
ADD COLUMN email_verified_at TIMESTAMP,
ADD COLUMN ai_flag_count INTEGER DEFAULT 0;
```

---

## Tier 1: Email Verification

### Flow
1. User registers with email
2. System sends verification link (JWT token, 24h expiry)
3. User clicks link → email verified
4. User can now post/comment/message

### Backend Implementation

```javascript
// backend/src/services/emailVerificationService.js
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');

const EMAIL_TOKEN_SECRET = process.env.EMAIL_TOKEN_SECRET;
const EMAIL_TOKEN_EXPIRY = '24h';

exports.sendVerificationEmail = async (userId, email) => {
    const token = jwt.sign({ userId, email, purpose: 'email_verify' }, EMAIL_TOKEN_SECRET, { expiresIn: EMAIL_TOKEN_EXPIRY });

    const verifyUrl = `${process.env.FRONTEND_URL}/#verify-email?token=${token}`;

    await transporter.sendMail({
        from: '"Intellacc" <noreply@intellacc.com>',
        to: email,
        subject: 'Verify your Intellacc account',
        html: `
            <h1>Welcome to Intellacc!</h1>
            <p>Click below to verify your email:</p>
            <a href="${verifyUrl}" style="background: #007bff; color: white; padding: 12px 24px; text-decoration: none; border-radius: 4px;">Verify Email</a>
            <p>This link expires in 24 hours.</p>
        `
    });
};

exports.verifyEmailToken = async (token) => {
    const decoded = jwt.verify(token, EMAIL_TOKEN_SECRET);

    await db.query(`
        INSERT INTO user_verifications (user_id, tier, verification_type, provider, status, verified_at)
        VALUES ($1, 1, 'email', 'internal', 'verified', NOW())
        ON CONFLICT (user_id, tier) DO UPDATE SET status = 'verified', verified_at = NOW()
    `, [decoded.userId]);

    await db.query(`
        UPDATE users SET verification_tier = GREATEST(verification_tier, 1), email_verified_at = NOW()
        WHERE id = $1
    `, [decoded.userId]);

    return decoded.userId;
};
```

### Endpoints
- `POST /api/auth/verify-email/send` - Resend verification email
- `POST /api/auth/verify-email/confirm` - Verify token (POST to avoid URL leakage)

---

## Tier 2: Phone Verification

### Flow
1. User enters phone number (E.164 format)
2. System checks if phone hash already exists (sybil check)
3. Twilio sends SMS code
4. User enters code → phone verified
5. Phone hash stored for uniqueness

### Backend Implementation

```javascript
// backend/src/services/phoneVerificationService.js
const twilio = require('twilio');
const crypto = require('crypto');

const client = twilio(process.env.TWILIO_SID, process.env.TWILIO_AUTH_TOKEN);
const VERIFY_SERVICE_SID = process.env.TWILIO_VERIFY_SID;

// Normalize and hash phone for privacy + uniqueness
const hashPhone = (phone) => {
    const normalized = phone.replace(/\D/g, ''); // Remove non-digits
    return crypto.createHash('sha256').update(normalized + process.env.PHONE_HASH_SALT).digest('hex');
};

exports.startPhoneVerification = async (userId, phoneNumber) => {
    // Check tier 1 first (sequential enforcement)
    const user = await db.query('SELECT verification_tier FROM users WHERE id = $1', [userId]);
    if (user.rows[0].verification_tier < 1) {
        throw new Error('Email verification required first');
    }

    // Check if phone already used
    const phoneHash = hashPhone(phoneNumber);
    const existing = await db.query('SELECT user_id FROM phone_hashes WHERE phone_hash = $1', [phoneHash]);
    if (existing.rows.length > 0 && existing.rows[0].user_id !== userId) {
        throw new Error('Phone number already associated with another account');
    }

    // Send verification code via Twilio
    await client.verify.v2.services(VERIFY_SERVICE_SID)
        .verifications
        .create({ to: phoneNumber, channel: 'sms' });

    return { success: true };
};

exports.confirmPhoneVerification = async (userId, phoneNumber, code) => {
    const verification = await client.verify.v2.services(VERIFY_SERVICE_SID)
        .verificationChecks
        .create({ to: phoneNumber, code });

    if (verification.status !== 'approved') {
        throw new Error('Invalid verification code');
    }

    const phoneHash = hashPhone(phoneNumber);

    // Store phone hash for uniqueness
    await db.query(`
        INSERT INTO phone_hashes (phone_hash, user_id)
        VALUES ($1, $2)
        ON CONFLICT (phone_hash) DO NOTHING
    `, [phoneHash, userId]);

    // Update verification status
    await db.query(`
        INSERT INTO user_verifications (user_id, tier, verification_type, provider, status, verified_at)
        VALUES ($1, 2, 'phone', 'twilio', 'verified', NOW())
        ON CONFLICT (user_id, tier) DO UPDATE SET status = 'verified', verified_at = NOW()
    `, [userId]);

    await db.query(`
        UPDATE users SET verification_tier = GREATEST(verification_tier, 2) WHERE id = $1
    `, [userId]);

    return { success: true };
};
```

### Endpoints
- `POST /api/verification/phone/start` - Send SMS code
- `POST /api/verification/phone/confirm` - Verify code

### Rate Limits
- 3 SMS per phone per hour
- 5 SMS per user per day
- 10 SMS per IP per hour

---

## Tier 3: Payment Verification

### Purpose
Proves user has a real financial identity. Bots don't have credit cards.

**No charges are made** - we just verify the payment method is valid.

### Options

#### Option A: Stripe (Recommended)
- Create SetupIntent to verify card
- No charge, just validation
- Cost: ~$0.50 per verification attempt

#### Option B: PayPal
- OAuth flow to verify PayPal account
- No charge, just authentication
- Cost: Free

### Backend Implementation (Stripe)

```javascript
// backend/src/services/paymentVerificationService.js
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

exports.createVerificationSession = async (userId) => {
    // Check tier 2 first (sequential enforcement)
    const user = await db.query('SELECT verification_tier, email FROM users WHERE id = $1', [userId]);
    if (user.rows[0].verification_tier < 2) {
        throw new Error('Phone verification required first');
    }

    // Create or get Stripe customer
    let customerId;
    const existing = await db.query('SELECT provider_customer_id FROM payment_verifications WHERE user_id = $1 AND provider = $2', [userId, 'stripe']);

    if (existing.rows.length > 0) {
        customerId = existing.rows[0].provider_customer_id;
    } else {
        const customer = await stripe.customers.create({
            email: user.rows[0].email,
            metadata: { intellacc_user_id: userId.toString() }
        });
        customerId = customer.id;

        await db.query(`
            INSERT INTO payment_verifications (user_id, provider, provider_customer_id)
            VALUES ($1, 'stripe', $2)
        `, [userId, customerId]);
    }

    // Create SetupIntent (verifies card without charging)
    const setupIntent = await stripe.setupIntents.create({
        customer: customerId,
        payment_method_types: ['card'],
        metadata: { purpose: 'verification', user_id: userId.toString() }
    });

    return { clientSecret: setupIntent.client_secret };
};

// Webhook handler for successful verification
exports.handleSetupIntentSucceeded = async (setupIntent) => {
    const userId = parseInt(setupIntent.metadata.user_id);

    await db.query(`
        UPDATE payment_verifications
        SET verification_method = 'card_check', verified_at = NOW()
        WHERE user_id = $1 AND provider = 'stripe'
    `, [userId]);

    await db.query(`
        INSERT INTO user_verifications (user_id, tier, verification_type, provider, status, verified_at)
        VALUES ($1, 3, 'payment', 'stripe', 'verified', NOW())
        ON CONFLICT (user_id, tier) DO UPDATE SET status = 'verified', verified_at = NOW()
    `, [userId]);

    await db.query(`
        UPDATE users SET verification_tier = GREATEST(verification_tier, 3) WHERE id = $1
    `, [userId]);
};
```

### Endpoints
- `POST /api/verification/payment/setup` - Create SetupIntent
- `POST /api/webhooks/stripe` - Handle Stripe webhooks

---

## Pangram AI Detection

### Integration

All user-generated content is analyzed before/after publishing.

```javascript
// backend/src/services/pangramService.js
const PANGRAM_API_KEY = process.env.PANGRAM_API_KEY;
const PANGRAM_API_URL = 'https://api.pangram.com/v1/detect';

exports.analyzeContent = async (text, contentType, contentId, userId) => {
    if (!text || text.length < 50) {
        return { ai_probability: 0, is_flagged: false }; // Too short to analyze
    }

    const response = await fetch(PANGRAM_API_URL, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${PANGRAM_API_KEY}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ text })
    });

    const result = await response.json();

    const aiProbability = result.ai_probability || 0;
    const detectedModel = result.detected_model || null;
    const isFlagged = aiProbability > 0.85; // Flag if >85% likely AI

    // Store analysis result
    await db.query(`
        INSERT INTO content_ai_analysis (content_type, content_id, user_id, ai_probability, detected_model, is_flagged)
        VALUES ($1, $2, $3, $4, $5, $6)
    `, [contentType, contentId, userId, aiProbability, detectedModel, isFlagged]);

    // Update user's AI flag count
    if (isFlagged) {
        await db.query(`
            UPDATE users SET ai_flag_count = ai_flag_count + 1 WHERE id = $1
        `, [userId]);
    }

    return { ai_probability: aiProbability, detected_model: detectedModel, is_flagged: isFlagged };
};
```

### Integration Points

```javascript
// In postController.js
const pangram = require('../services/pangramService');

exports.createPost = async (req, res) => {
    // ... create post ...

    // Analyze content asynchronously
    pangram.analyzeContent(post.content, 'post', post.id, req.user.id)
        .catch(err => console.error('[Pangram] Analysis failed:', err));

    res.json(post);
};
```

### Display
- Posts/comments with high AI probability show a subtle indicator
- Users with many AI flags may face restrictions
- Optional: Hide AI-flagged content from feeds

---

## Middleware

```javascript
// backend/src/middleware/verification.js

const requireTier = (minTier) => (req, res, next) => {
    if (!req.user) {
        return res.status(401).json({ error: 'Authentication required' });
    }

    if (req.user.verification_tier < minTier) {
        const tierNames = ['none', 'email', 'phone', 'payment'];
        return res.status(403).json({
            error: 'Higher verification required',
            required_tier: minTier,
            required_method: tierNames[minTier],
            current_tier: req.user.verification_tier,
            upgrade_url: '/#settings/verification'
        });
    }

    next();
};

module.exports = { requireTier };
```

### Usage

```javascript
// backend/src/routes/api.js
const { requireTier } = require('../middleware/verification');

// Tier 1: Email verified
router.post('/posts', authenticateJWT, requireTier(1), postController.createPost);
router.post('/comments', authenticateJWT, requireTier(1), postController.createComment);

// Tier 2: Phone verified
router.post('/predict', authenticateJWT, requireTier(2), predictionsController.createPrediction);
router.post('/events/:id/update', authenticateJWT, requireTier(2), /* ... */);

// Tier 3: Payment verified
router.post('/events', authenticateJWT, requireTier(3), predictionsController.createEvent);
router.post('/governance/vote', authenticateJWT, requireTier(3), governanceController.vote);
```

---

## Frontend Components

### Files to Create

```
frontend/src/components/verification/
├── VerificationStatus.js      # Shows current tier + next steps
├── EmailVerification.js       # Email verify flow
├── PhoneVerification.js       # Phone verify flow
├── PaymentVerification.js     # Stripe card verification
└── VerificationBanner.js      # "Verify to unlock features" banner

frontend/src/components/common/
└── AiContentBadge.js          # Shows AI probability indicator
```

### VerificationStatus Component

```javascript
// frontend/src/components/verification/VerificationStatus.js
import van from 'vanjs-core';
const { div, h3, p, button, span } = van.tags;

const VerificationStatus = ({ user }) => {
    const tiers = [
        { level: 1, name: 'Email', icon: '📧', unlocks: 'Post, comment, message' },
        { level: 2, name: 'Phone', icon: '📱', unlocks: 'Prediction markets' },
        { level: 3, name: 'Payment', icon: '💳', unlocks: 'Create markets, governance' }
    ];

    return div({ class: 'verification-status' },
        h3('Verification Status'),
        div({ class: 'tier-list' },
            tiers.map(tier =>
                div({ class: `tier-item ${user.verification_tier >= tier.level ? 'verified' : 'pending'}` },
                    span({ class: 'tier-icon' }, tier.icon),
                    span({ class: 'tier-name' }, `Tier ${tier.level}: ${tier.name}`),
                    span({ class: 'tier-status' },
                        user.verification_tier >= tier.level ? '✓ Verified' : 'Not verified'
                    ),
                    p({ class: 'tier-unlocks' }, `Unlocks: ${tier.unlocks}`)
                )
            )
        )
    );
};
```

---

## Implementation Roadmap

### Phase 1: Email Verification (2-3 days)
- [ ] Create migration
- [ ] Implement emailVerificationService
- [ ] Add endpoints
- [ ] Create frontend components
- [ ] Update signup flow to send verification
- [ ] Gate posting behind Tier 1
- [ ] Add verification banner

### Phase 2: Phone Verification (2-3 days)
- [ ] Set up Twilio Verify
- [ ] Implement phoneVerificationService
- [ ] Add phone hash table + uniqueness check
- [ ] Create PhoneVerification component
- [ ] Gate prediction markets behind Tier 2

### Phase 3: Payment Verification (2-3 days)
- [ ] Set up Stripe (test mode)
- [ ] Implement paymentVerificationService
- [ ] Add Stripe webhook handler
- [ ] Create PaymentVerification component
- [ ] Gate market creation behind Tier 3

### Phase 4: Pangram Integration (1-2 days)
- [ ] Implement pangramService
- [ ] Add content_ai_analysis table
- [ ] Integrate into post/comment creation
- [ ] Create AiContentBadge component
- [ ] Add admin view for flagged content

---

## Environment Variables

```bash
# Email
SMTP_HOST=smtp.sendgrid.net
SMTP_PORT=587
SMTP_USER=apikey
SMTP_PASS=your_sendgrid_api_key
EMAIL_TOKEN_SECRET=random_secret_for_jwt

# Phone
TWILIO_SID=your_twilio_sid
TWILIO_AUTH_TOKEN=your_twilio_auth_token
TWILIO_VERIFY_SID=your_verify_service_sid
PHONE_HASH_SALT=random_salt_for_hashing

# Payment
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...

# AI Detection
PANGRAM_API_KEY=your_pangram_api_key
```

---

## Success Criteria

1. New users cannot post until email verified
2. Users cannot participate in markets until phone verified
3. Phone numbers are unique (1 phone = 1 account)
4. Users cannot create markets until payment verified
5. All posts/comments are analyzed for AI content
6. AI-generated content is flagged and visible to moderators
7. No sensitive data (actual phone numbers, card details) stored locally
