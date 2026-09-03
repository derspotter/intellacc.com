/**
 * Guards every `/users/:id` route against non-numeric ids.
 *
 * A frontend link built from a missing field used to hit `/users/undefined`;
 * Postgres then rejected the integer cast and the request surfaced as a 500
 * "Error fetching user". Reject anything that is not a positive integer up
 * front so the client gets a deterministic 400.
 */
const validateUserIdParam = (req, res, next) => {
  const raw = req.params.id;
  if (typeof raw !== 'string' || !/^[1-9]\d*$/.test(raw)) {
    return res.status(400).json({ message: 'Invalid user id' });
  }
  return next();
};

module.exports = validateUserIdParam;
