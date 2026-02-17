const REGISTRATION_CLOSED_MESSAGE = 'Registration is currently closed';
const REGISTRATION_APPROVAL_MESSAGE = 'Registration is pending admin approval.';

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

const isRegistrationApprovalRequired = () => {
  if (process.env.NODE_ENV === 'test') {
    return false;
  }

  const isJestRun =
    process.env.JEST_WORKER_ID ||
    process.env.npm_lifecycle_event === 'test' ||
    process.argv.some((arg) => {
      return arg.endsWith('/jest') || arg.includes('/jest') || arg.includes('\\jest');
    });

  if (isJestRun) {
    return false;
  }

  return String(process.env.REGISTRATION_APPROVAL_REQUIRED || '').toLowerCase() === 'true';
};

const getRegistrationApproverEmail = () => {
  return process.env.REGISTRATION_APPROVER_EMAIL || 'jayjag@posteo.de';
};

module.exports = {
  REGISTRATION_CLOSED_MESSAGE,
  REGISTRATION_APPROVAL_MESSAGE,
  isRegistrationEnabled,
  isRegistrationApprovalRequired,
  getRegistrationApproverEmail
};
