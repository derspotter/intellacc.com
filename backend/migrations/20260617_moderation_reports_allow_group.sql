-- 2026-06-17: Allow community-group moderation reports.
-- The original moderation_reports CHECK constraints only permitted
-- ('post','comment','user'). Community Groups moderation lets members
-- report a whole group, which inserts reported_content_type='group' with
-- the group id as reported_content_id. Relax both constraints to allow it.

BEGIN;

ALTER TABLE moderation_reports
  DROP CONSTRAINT IF EXISTS moderation_reports_content_type;
ALTER TABLE moderation_reports
  ADD CONSTRAINT moderation_reports_content_type
    CHECK (reported_content_type IN ('post', 'comment', 'user', 'group'));

ALTER TABLE moderation_reports
  DROP CONSTRAINT IF EXISTS moderation_reports_report_type_target;
ALTER TABLE moderation_reports
  ADD CONSTRAINT moderation_reports_report_type_target CHECK (
    (reported_content_type IN ('post', 'comment', 'group') AND reported_content_id IS NOT NULL)
    OR (reported_content_type = 'user' AND reported_content_id IS NULL)
  );

COMMIT;
