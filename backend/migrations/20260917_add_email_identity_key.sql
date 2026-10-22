BEGIN;

-- Gmail plus-addressing resolves to a single mailbox, so it must resolve to a
-- single account identity.
--
-- Gmail delivers user+anything@gmail.com to user@gmail.com. Treating the two as
-- separate accounts hands one mailbox unlimited signups, and lets a password
-- reset for "the same" address land on an account the person did not mean.
--
-- email_identity_key() is the one definition of "same mailbox" shared by the
-- application queries and by the index below. It folds the plus suffix away for
-- gmail.com ONLY. Every other provider -- including googlemail.com and any
-- self-hosted domain -- keeps its address verbatim apart from trimming and case
-- folding, and dots are never stripped anywhere.
--
-- users.email itself is never rewritten: it stays the deliverable address the
-- person typed (trimmed and lower-cased), plus suffix included.
--
CREATE OR REPLACE FUNCTION email_identity_key(email_input TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT CASE
    WHEN email_input IS NULL THEN NULL
    -- split_part(..., '@', 2) is empty for an address with no '@' and is the
    -- middle segment for a malformed 'a@b@gmail.com', so neither is folded.
    WHEN split_part(lower(btrim(email_input)), '@', 2) = 'gmail.com'
         -- '+tag@gmail.com' has an empty base; leave it alone rather than
         -- collapsing every such address onto the key '@gmail.com'.
         AND strpos(split_part(lower(btrim(email_input)), '@', 1), '+') > 1
      THEN split_part(split_part(lower(btrim(email_input)), '@', 1), '+', 1) || '@gmail.com'
    ELSE lower(btrim(email_input))
  END;
$$;

COMMENT ON FUNCTION email_identity_key(TEXT) IS
  'Account identity for an email address: trimmed + lower-cased, with the plus suffix removed for gmail.com only. Deliverable address stays in users.email.';

-- A collision must abort the migration, never weaken account uniqueness or
-- silently pick which existing account owns a mailbox. Resolve any collisions
-- explicitly before retrying. The unique index also protects racing signups.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_users_email_identity_active
  ON users (email_identity_key(email))
  WHERE deleted_at IS NULL;

COMMIT;
