const isPlaceholderValue = (value) => {
  if (!value || typeof value !== 'string') return true;
  const normalized = value.trim().toLowerCase();
  return (
    normalized.includes('dev-') ||
    normalized.includes('change_me') ||
    normalized.includes('your_') ||
    normalized.includes('example.com') ||
    normalized.includes('localhost')
  );
};

const parseBool = (value) => {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized === 'true' || normalized === '1' || normalized === 'yes';
};

const validateProductionSecret = (name, minimumLength = 16) => {
  const value = process.env[name];
  if (!value) {
    return `${name} is required in production`;
  }
  if (value.length < minimumLength) {
    return `${name} should be at least ${minimumLength} characters`;
  }
  if (isPlaceholderValue(value)) {
    return `${name} appears to be a placeholder/default value`;
  }
  return null;
};

const validateOptionalProviderVars = (vars, serviceName, minimumLength = 16) => {
  const issues = [];
  vars.forEach((name) => {
    const error = validateProductionSecret(name, minimumLength);
    if (error) {
      issues.push(error.replace(`${name} is required in production`, `${name} is required when ${serviceName} is required in production`));
    }
  });

  return issues;
};

const validateProductionConfig = () => {
  if (process.env.NODE_ENV !== 'production') {
    return;
  }

  const issues = [];

  const jwtError = validateProductionSecret('JWT_SECRET', 32);
  if (jwtError) issues.push(jwtError);

  const emailTokenError = validateProductionSecret('EMAIL_TOKEN_SECRET', 24);
  if (emailTokenError) issues.push(emailTokenError);

  const resetTokenError = validateProductionSecret('PASSWORD_RESET_SECRET', 24);
  if (resetTokenError) issues.push(resetTokenError);

  const frontendUrl = process.env.FRONTEND_URL || '';
  if (!frontendUrl) {
    issues.push('FRONTEND_URL is required in production');
  } else if (/^https?:\/\/localhost/i.test(frontendUrl)) {
    issues.push(`FRONTEND_URL should not be localhost in production (got ${frontendUrl})`);
  }

  if (!process.env.SMTP_HOST) {
    issues.push('SMTP_HOST is required in production for password reset and email verification');
  } else if (process.env.SMTP_HOST === 'localhost' && process.env.FRONTEND_URL) {
    console.warn('[ProductionGuard] SMTP_HOST is set to localhost. Ensure backend can resolve this hostname in production.');
  }

  if (!process.env.SMTP_FROM || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(process.env.SMTP_FROM)) {
    issues.push('SMTP_FROM must be a valid email address in production');
  } else if (isPlaceholderValue(process.env.SMTP_FROM)) {
    issues.push(`SMTP_FROM appears to be a placeholder/default value (${process.env.SMTP_FROM})`);
  }

  if (parseBool(process.env.REQUIRE_TWILIO_VERIFICATION)) {
    if (!parseBool(process.env.PHONE_VERIFICATION_ENABLED, true)) {
      issues.push('PHONE_VERIFICATION_ENABLED is false but REQUIRE_TWILIO_VERIFICATION is true.');
    }
    issues.push(...validateOptionalProviderVars(
      ['TWILIO_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_VERIFY_SID'],
      'phone verification',
      10
    ));
  }

  if (parseBool(process.env.REQUIRE_STRIPE_VERIFICATION)) {
    if (!parseBool(process.env.PAYMENT_VERIFICATION_ENABLED, true)) {
      issues.push('PAYMENT_VERIFICATION_ENABLED is false but REQUIRE_STRIPE_VERIFICATION is true.');
    }
    const stripeIssues = validateOptionalProviderVars(
      ['STRIPE_SECRET_KEY', 'STRIPE_PUBLISHABLE_KEY'],
      'payment verification',
      10
    );
    const webhookError = validateProductionSecret('STRIPE_WEBHOOK_SECRET', 10);
    if (webhookError) {
      issues.push(
        webhookError.replace(
          'STRIPE_WEBHOOK_SECRET is required in production',
          'STRIPE_WEBHOOK_SECRET is required when payment verification is required in production'
        )
      );
    }

    issues.push(...stripeIssues);
  }

  const resetDelay = Number(process.env.PASSWORD_RESET_DELAY_HOURS || '168');
  if (!Number.isFinite(resetDelay) || resetDelay <= 0) {
    issues.push('PASSWORD_RESET_DELAY_HOURS must be a positive number');
  }

  if (issues.length > 0) {
    throw new Error(
      '[ProductionGuard] Refusing to start in production due to invalid security/configuration settings:\n' +
      issues.map((item) => `- ${item}`).join('\n')
    );
  }

  console.log('[ProductionGuard] Production configuration checks passed');
};

module.exports = {
  validateProductionConfig
};
