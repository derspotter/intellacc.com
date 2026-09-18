# Background link previews

Previously, creating a post waited for a remote page fetch and metadata
extraction before inserting the post. Slow redirects could each consume their
own eight-second timeout. The new path saves the post and a durable preview job
in one PostgreSQL statement, then returns without fetching the remote page.

## Worker behavior

- Two preview slots per backend process, checked every two seconds. Overlapping
  ticks share the running batch, including when recording a retry fails.
- Jobs use sixty-second leases and `SKIP LOCKED` claims. A process restart can
  recover expired jobs; separate processes cannot claim the same live lease.
- A job gets at most three attempts, with retry delays of thirty and sixty
  seconds. Exhausted jobs remain in the table with their last error for
  inspection. Editing the post resets the job generation and attempts.
- URLs are normalized using `URL`, preserving query strings and removing
  fragments. Fresh metadata is reused for twenty-four hours without extending
  its timestamp on reads. Concurrent jobs for the same URL within one worker
  share a download. Cache keys retain the requested URL so redirect aliases
  remain reusable; metadata extraction still uses the resolved target URL.
- Each remote operation shares a ten-second deadline across DNS validation,
  redirects, HTTP and asynchronous extraction. Every redirect retains SSRF
  validation, the five-redirect limit, and the existing five-MiB response limit.
  Expiry aborts the Axios request. Synchronous parsing cannot be preempted by a
  JavaScript timer; the response-size limit still bounds its input.
- External work holds no database connection. Final writes take a short
  transaction, locking the post before its job and checking generation, lease
  and current URL. A late result cannot overwrite an edit, including A → B → A.
  Removing a URL clears its preview and cancels the queued job.
  Editing text around an unchanged, already-enriched URL does not enqueue work.
- Completion emits `post_preview_updated` with only `post_id` to the author's
  existing notification room. Normal post reads return the enriched fields.
  Current frontend skins do not render preview metadata, so no layout or
  frontend-build change is included here.

The shared fetch deadline also bounds the article fetch used by AI matching.
Article text remains ephemeral and is not stored in the preview cache.

## Verification

Tests use the full migration sequence in a disposable PostgreSQL database, a
real HTTP API, mocked remote fetches, and a database pool limited to one
connection. Coverage includes immediate post creation, available connections
during a stalled fetch, cache freshness, same-URL deduplication, concurrency,
lease recovery, stale edits, URL removal and retry exhaustion. Deadline tests
verify redirect checks, rejection of private redirects, HTTP cancellation and
stalled DNS. Existing matcher integration and connection regressions, group
post broadcast rules and repost behavior are also covered, along with unchanged
URL edits and preservation of failure reasons.
The final regression run passed all 32 tests across six suites.

Claude Code/Fable 5.1 reviewed the change with read-only tools and API keys
unset, using the signed-in session, and found no blocking issues. The review
prompted the unchanged-URL optimization and preservation of fetch errors.
Cross-post negative caching and timed retention of exhausted/hidden jobs remain
possible follow-ups. Jobs have at most one row per post and cascade on deletion;
exhausted jobs are excluded from the ready index. Worker tests require an
isolated database and modify lease/retry timestamps only for their fixture user.

This verifies the removal of remote fetches from the publish path, not a
measured production latency improvement.

## Rollout

Apply `backend/migrations/20260918_link_preview_jobs.sql` before starting the
new backend, using the normal migration startup flow. The migration adds one
queue table and index. Existing posts are not backfilled. No environment or
frontend changes are required. The previous code can ignore the additive table
if a rollback is needed.

Prepared on `codex/performance-link-previews`; not deployed. Batches 1 and 2
are live.
