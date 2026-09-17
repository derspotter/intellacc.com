# Performance fixes: first batch

## Changes

- Feed attachment loading now reacts only to attachment-ID changes. Updating a
  post's text or setting its downloaded image URL no longer triggers another
  download. Replacing an attachment or unmounting the component aborts pending
  requests and revokes its object URL. Late responses cannot replace the current
  image.
- Post matching releases database connections between individual progress
  writes. Article fetching, the claim gate, retrieval, and reasoning no longer
  run inside a long-lived database transaction. Candidate and reasoning writes
  commit together in a short final transaction, retaining the existing manual
  link guard and reasoner savepoint behavior.
- Each matching run has a UUID. Progress and final writes check both this UUID
  and the original post content, preventing superseded jobs and jobs for edited
  content from replacing newer results. Progress is visible while AI calls run.

## Migration and rollout

`backend/migrations/20260917_post_analysis_processing_run.sql` adds the nullable
`post_analysis.processing_run_id` UUID column. Apply it before starting the new
backend code, using the normal startup migration flow. Drain or stop old backend
matching jobs before switching versions: old code does not check run IDs.

The migration is additive. A code rollback can leave the column in place.
Commit `b0cfbc8` was deployed on 2026-09-17. The backend was restarted, the
migration record and UUID column were verified, and the public health endpoint
returned 200. The live frontend index, entry JavaScript, and Van shell JavaScript
matched the tested isolated build byte for byte. Previous frontend assets were
retained, with a rollback archive at
`/tmp/intellacc-frontend-before-step1-20260917.tar.gz`.

## Verification

Backend tests ran inside a dedicated backend container against a disposable
PostgreSQL database with the full migration sequence applied. All 18 tests in
these four suites passed:

```text
test/post_match_pipeline_connections.test.js
test/post_match_pipeline_guard.test.js
test/openRouterMatcher.test.js
test/openRouterMatcher.integration.test.js
```

The connection regressions use a real pool limited to one connection. They check
connection availability and visible status during each external stage, eight
simultaneous matching jobs, overlapping runs, post edits, stale failures, and
rollback after a failed final write. External AI calls are mocked.

All three Chromium tests in
`tests/e2e/post-attachment-lifecycle.spec.js` passed against the real Solid
component using `frontend-solid/test/post-attachment.html`. They check unchanged
IDs, replacement and URL cleanup, late responses, and unmounting during a
pending request. API traffic is mocked.

The containerized Solid frontend production build passed. Vite still reports
bundle-size and mixed static/dynamic import warnings, and Browserslist reports
outdated browser data. Those are outside this batch.

These checks verify behavior and connection availability. They do not establish
production latency or throughput improvements; those need production metrics
after rollout.
