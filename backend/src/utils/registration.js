const REGISTRATION_CLOSED_MESSAGE = 'Registration is currently closed';

const isRegistrationEnabled = () => {
  return String(process.env.ALLOW_REGISTRATION || '').toLowerCase() === 'true';
};

module.exports = {
  REGISTRATION_CLOSED_MESSAGE,
  isRegistrationEnabled
};
