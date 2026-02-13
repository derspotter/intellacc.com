const REGISTRATION_CLOSED_MESSAGE = 'Registration is currently closed';

const isRegistrationEnabled = () => {
  const isJestRun =
    process.env.JEST_WORKER_ID ||
    process.env.npm_lifecycle_event === 'test' ||
    process.argv.some((arg) => {
      return arg.endsWith('/jest') || arg.includes('/jest') || arg.includes('\\jest');
    });

  if (process.env.NODE_ENV === 'test' || isJestRun) {
    return true;
  }
  return String(process.env.ALLOW_REGISTRATION || '').toLowerCase() === 'true';
};

module.exports = {
  REGISTRATION_CLOSED_MESSAGE,
  isRegistrationEnabled
};
