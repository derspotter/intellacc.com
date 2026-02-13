const { validateProductionConfig } = require('../src/utils/productionGuard');

describe('Production configuration guard', () => {
  const originalEnv = { ...process.env };

  const withBaseProdEnv = () => {
    process.env = {
      ...originalEnv,
      NODE_ENV: 'production',
      FRONTEND_URL: 'https://intellacc.com',
      JWT_SECRET: 'super-long-random-production-jwt-secret-value',
      EMAIL_TOKEN_SECRET: 'super-long-email-verification-secret',
      PASSWORD_RESET_SECRET: 'super-long-password-reset-secret',
      SMTP_HOST: 'test-postfix',
      SMTP_FROM: 'noreply@intellacc.com',
      PASSWORD_RESET_DELAY_HOURS: '168'
    };
  };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('passes with a valid production configuration', () => {
    withBaseProdEnv();
    expect(() => validateProductionConfig()).not.toThrow();
  });

  it('throws when critical secrets are placeholders', () => {
    withBaseProdEnv();
    process.env.JWT_SECRET = 'change_me_jwt_secret';
    expect(() => validateProductionConfig()).toThrow(/refusing to start/i);
  });

  it('throws when SMTP host is missing in production', () => {
    withBaseProdEnv();
    delete process.env.SMTP_HOST;
    expect(() => validateProductionConfig()).toThrow(/SMTP_HOST is required/i);
  });

  it('throws when frontend URL is localhost', () => {
    withBaseProdEnv();
    process.env.FRONTEND_URL = 'http://localhost:5173';
    expect(() => validateProductionConfig()).toThrow(/should not be localhost/i);
  });
});
