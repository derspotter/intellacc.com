/**
 * Profile link guard. A link built from a missing id used to navigate to
 * `#user/undefined`, which the API answered with an error. Builders go
 * through here so a missing id yields no link instead of a broken one.
 */
export const isValidUserId = (id) => /^[1-9]\d*$/.test(String(id ?? ''));

export const userHash = (id) => (isValidUserId(id) ? `#user/${String(id)}` : null);

export const goToUser = (id) => {
  const hash = userHash(id);
  if (!hash) return false;
  window.location.hash = hash;
  return true;
};
