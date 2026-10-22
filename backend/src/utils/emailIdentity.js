// Preserve plus tags for delivery. SQL email_identity_key() handles account lookup.
const normalizeEmail = (email) => String(email ?? '').trim().toLowerCase();

module.exports = { normalizeEmail };
