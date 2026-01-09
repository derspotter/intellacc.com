# Tiered Identity Verification System Implementation Plan

## Overview
This plan introduces a 4-tier verification system to progressively build trust, enable high-stakes features, and prevent Sybil attacks. The system is designed to be modular, allowing users to unlock capabilities as they verify their identity.

---

## Tier Summary

| Tier | Method | Unlocks | Cost |
|------|--------|---------|------|
| 0 | None | Read-only | Free |
| 1 | Email | Posting, commenting, basic messaging | ~Free |
| 2 | Phone (SMS/TOTP) | Prediction markets participation | ~$0.05/verify |
| 3 | Identity (KYC) | Withdrawals, payouts | ~$1.50-5.00/verify |
| 4 | Proof of Human | High-stakes markets, governance | Free (World ID) |

---

## Database Schema Changes

### 1. New Table: `user_verifications`
Tracks the granular status of each verification attempt.

```sql
CREATE TABLE user_verifications (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    tier_level INTEGER NOT NULL CHECK (tier_level BETWEEN 1 AND 4),
    verification_type VARCHAR(50) NOT NULL, -- 'email', 'phone', 'document', 'biometric'
    provider VARCHAR(50), -- 'internal', 'twilio', 'stripe', 'worldcoin'
    status VARCHAR(20) NOT NULL DEFAULT 'pending', -- 'pending', 'verified', 'failed', 'revoked'
    provider_id VARCHAR(255), -- External reference ID (e.g., Stripe verification session ID)
    metadata JSONB, -- Store provider-specific details (non-sensitive)
    verified_at TIMESTAMP,
    expires_at TIMESTAMP, -- For documents that expire
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(user_id, tier_level)
);

CREATE INDEX idx_user_verifications_user ON user_verifications(user_id);
CREATE INDEX idx_user_verifications_status ON user_verifications(status);
```

### 2. Update `users` Table
Add a summary column for performance in permission checks.

```sql
ALTER TABLE users
ADD COLUMN verification_tier INTEGER DEFAULT 0,
ADD COLUMN is_email_verified BOOLEAN DEFAULT FALSE,
ADD COLUMN phone_number VARCHAR(20); -- E.164 format
```

---

## Tier 1: Email Verification (Basic)

**Requirement for:** Posting, commenting, basic messaging.

### Backend Implementation

#### Email Service (`backend/src/services/emailService.js`)
```javascript
const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: process.env.SMTP_PORT,
    auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS
    }
});

exports.sendVerificationEmail = async (email, token) => {
    const verifyUrl = `${process.env.FRONTEND_URL}/#verify-email?token=${token}`;

    await transporter.sendMail({
        from: '"Intellacc" <noreply@intellacc.com>',
        to: email,
        subject: 'Verify your email address',
        html: `
            <h1>Welcome to Intellacc!</h1>
            <p>Click the link below to verify your email:</p>
            <a href="${verifyUrl}">${verifyUrl}</a>
            <p>This link expires in 24 hours.</p>
        `
    });
};
```

#### Endpoints
- `POST /api/auth/verify-email/request` - Resend verification link
- `GET /api/auth/verify-email/confirm?token=...` - Confirm email

### Frontend Components
- `EmailVerificationBanner.js` - "Please verify your email" banner
- `VerifyEmail.js` - Landing page for token handling

### Flow
1. On Registration: Send email automatically
2. User clicks link → Backend validates token
3. Update `user_verifications` (Tier 1) and `users.is_email_verified`

---

## Tier 2: Phone Verification (Sybil Resistance Lite)

**Requirement for:** Prediction markets participation (betting/trading).

### Provider: Twilio Verify API
- Cost: ~$0.05 per verification
- Supports SMS, Voice, TOTP

### Backend Implementation

#### Endpoints
```javascript
// POST /api/verification/phone/start
// Input: { phone_number: "+1234567890" }
// Calls Twilio Verify to send code

// POST /api/verification/phone/check
// Input: { code: "123456" }
// Verifies code with Twilio
```

### Frontend Components
- `PhoneVerificationModal.js` - Phone number input + OTP input

### Security
- Rate limit: Max 3 attempts per hour
- Store hash of phone number to prevent duplicate accounts

---

## Tier 3: Identity Verification (KYC)

**Requirement for:** Withdrawals, converting RP to value, large deposits.

### Provider: Stripe Identity
- Cost: ~$1.50-5.00 per verification
- Global coverage, developer-friendly

### Backend Implementation

#### Endpoints
```javascript
// POST /api/verification/identity/session
// Creates Stripe Verification Session, returns client_secret

// Webhook: identity.verification_session.verified
// Updates user_verifications when Stripe confirms
```

### Frontend Components
- Button to launch Stripe Identity modal
- Status UI: "Pending", "Verified", "Rejected"

### Privacy (CRITICAL)
- **DO NOT** store PII (passport photos, ID numbers) in Intellacc DB
- Store only `provider_id` and status
- Trust Stripe to handle sensitive data storage

---

## Tier 4: Proof of Human (Biometric / Unique Human)

**Requirement for:** High-stakes markets, "One Person One Vote" governance.

### Provider: World ID (Worldcoin)
- Cost: Free
- Specifically solves "Unique Human" problem
- Zero-Knowledge proofs (no biometric data stored)

### Alternative Providers
- Civic
- Stripe Identity enhanced (Video Selfie)

### Backend Implementation

#### Protocol: OIDC (OpenID Connect)
```javascript
// GET /api/auth/world-id/login
// Redirect to Worldcoin authorization

// GET /api/auth/world-id/callback
// Handle code exchange
// Verify nullifier_hash has not been used by another user
```

### Frontend Components
- "Verify with World ID" button

---

## Middleware: Permission Gating

```javascript
// backend/src/middleware/verification.js

const requireTier = (minTier) => (req, res, next) => {
    if (req.user.verification_tier < minTier) {
        return res.status(403).json({
            error: 'Insufficient verification tier',
            required: minTier,
            current: req.user.verification_tier,
            upgrade_url: '/settings/verification'
        });
    }
    next();
};

// Usage in routes:
router.post('/posts', authenticateJWT, requireTier(1), postController.createPost);
router.post('/predict', authenticateJWT, requireTier(2), predictionsController.createPrediction);
router.post('/withdraw', authenticateJWT, requireTier(3), paymentsController.withdraw);
```

---

## Tier Interaction Logic

### Sequential Model (Recommended)
- Tier 1 (Email) is mandatory foundation
- Tier 2 (Phone) requires Tier 1
- Tier 3 (ID) requires Tier 2
- Tier 4 (Proof of Human) is optional enhancement

### Tier Calculation
```javascript
// Update users.verification_tier whenever user_verifications changes
const updateTier = async (userId) => {
    const result = await db.query(`
        SELECT MAX(tier_level) as max_tier
        FROM user_verifications
        WHERE user_id = $1 AND status = 'verified'
    `, [userId]);

    await db.query(`
        UPDATE users SET verification_tier = $1 WHERE id = $2
    `, [result.rows[0].max_tier || 0, userId]);
};
```

---

## Password Recovery via Verified Identity

Instead of recovery codes, use verified identity for account recovery:

| User's Tier | Recovery Method |
|-------------|-----------------|
| Tier 1 | Email reset link (standard) |
| Tier 2 | SMS code to verified phone |
| Tier 3 | Support ticket + ID verification match |
| Tier 4 | World ID re-verification |

### Implementation
```javascript
// POST /api/auth/forgot-password
// 1. Check user's verification tier
// 2. Send recovery via highest verified method
// 3. For Tier 3+, require support intervention
```

---

## Security & Privacy Considerations

### Data Minimization
- **Phone numbers**: Store encrypted or hashed if only needed for uniqueness
- **ID Documents**: NEVER store - rely on Stripe
- **Biometrics**: NEVER store - World ID uses Zero-Knowledge proofs

### Tier Downgrade
- If user changes email → Tier 1 revoked until re-verified
- If user changes phone → Tier 2 revoked until re-verified
- If Stripe sends invalidation webhook → Tier 3 revoked

### Rate Limiting
- Email: 3 requests per hour
- Phone: 3 attempts per hour
- Identity: 3 sessions per day

---

## Cost Management

| Tier | Cost per Verification | Strategy |
|------|----------------------|----------|
| 1 | ~$0.001 (email) | Absorb |
| 2 | ~$0.05 (SMS) | Absorb for now |
| 3 | ~$1.50-5.00 | Pass to user OR absorb for high-value users |
| 4 | Free | N/A |

---

## Implementation Roadmap

### Phase 1: Foundation & Email (2-3 days)
- [ ] Create migration: `user_verifications` table
- [ ] Update `users` table with verification columns
- [ ] Implement `emailService.js` with Nodemailer/SendGrid
- [ ] Add `/verify-email` endpoints
- [ ] Create `EmailVerificationBanner.js` component
- [ ] Gate `POST /posts` behind Tier 1
- [ ] Update signup flow to send verification email

### Phase 2: Phone Verification (2-3 days)
- [ ] Sign up for Twilio Verify
- [ ] Implement phone verification endpoints
- [ ] Create `PhoneVerificationModal.js`
- [ ] Add phone verification to Settings page
- [ ] Gate `POST /predict` behind Tier 2

### Phase 3: Identity Verification (3-4 days)
- [ ] Set up Stripe Identity (Test Mode first)
- [ ] Implement verification session endpoint
- [ ] Set up Stripe webhook handler
- [ ] Create Identity verification UI in Settings
- [ ] Gate withdrawals behind Tier 3

### Phase 4: Proof of Human (2-3 days)
- [ ] Register World ID application
- [ ] Implement OIDC flow
- [ ] Add World ID verification button
- [ ] Create special "verified human" badge/features

### Phase 5: Recovery Integration (1-2 days)
- [ ] Update forgot-password flow to use tiered recovery
- [ ] Implement phone-based recovery for Tier 2+
- [ ] Document support process for Tier 3 recovery

---

## Files to Create/Modify

### New Files
```
backend/src/services/emailService.js
backend/src/services/twilioService.js
backend/src/services/stripeIdentityService.js
backend/src/services/worldIdService.js
backend/src/controllers/verificationController.js
backend/src/middleware/verification.js
backend/migrations/YYYYMMDD_add_user_verifications.sql

frontend/src/components/auth/EmailVerificationBanner.js
frontend/src/components/auth/VerifyEmail.js
frontend/src/components/settings/PhoneVerification.js
frontend/src/components/settings/IdentityVerification.js
frontend/src/components/settings/WorldIdVerification.js
frontend/src/components/settings/VerificationStatus.js
```

### Modified Files
```
backend/src/routes/api.js - Add verification routes
backend/src/controllers/userController.js - Send verification on signup
frontend/src/components/layout/MainLayout.js - Add verification banner
frontend/src/pages/Settings.js - Add verification section
```

---

## Success Criteria

1. New users cannot post until email verified
2. Users cannot participate in markets until phone verified
3. Withdrawals require KYC verification
4. High-stakes features require proof of human
5. Password recovery works via verified identity (no recovery codes)
6. No sensitive PII stored in Intellacc database
