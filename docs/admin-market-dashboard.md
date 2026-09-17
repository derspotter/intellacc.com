# Admin market dashboard

Open `#predictions/admin` as an administrator in either frontend layout.

- Proposals lists all pending community submissions, including expired proposals and the admin's own submissions.
- Closed markets lists unresolved markets past their closing date that pass the public catalog visibility rules. Hidden markets and unconfigured non-binary markets are excluded. Existing history is retained.
- Both queues support title/ID search and pagination, ordered by closing date. Summary counts cover the full queue, independently of search.
- Publication records `admin_reviewed_by` and `admin_reviewed_at`, uses the existing creator bond/reward settlement and returns outstanding reviewer stakes, and does not fabricate a vote or charge the administrator a validator stake. A row lock prevents duplicate publication. Expired publication requires explicit acknowledgement.
- Resolution uses the existing market settlement API. An active community resolution proposal uses its admin-ruling API so its stakes are settled too. Outcomes must be explicitly selected.

Backend routes: `GET /api/admin/markets` and `POST /api/admin/markets/proposals/:id/publish` or `/reject`. Both require administrator authentication. Migration: `20260916_admin_question_publication.sql`.

Validation: backend admin-market and existing bootstrap-review tests, read-only database integration checks, containerized frontend build, and browser tests with mocked writes in both layouts.
