# Feed metadata batching

The default feed previously mounted two badges per post which together made
four API requests. A 20-post page made 80 metadata requests; each pending post
then repeated three requests every five seconds.

## Behavior

- Mounted post components now share a metadata loader. Requests from the same
  render are coalesced, with at most 100 distinct IDs per request. Duplicate
  mounted copies share data. Larger batches are split.
- `POST /api/posts/metadata` accepts `post_ids` and optional `status_only`.
  It requires authentication and returns only visible posts, respecting both
  directions of user blocking and the feed's administrator semantics. Missing
  and inaccessible IDs are omitted. Hidden events are excluded from links,
  suggestions, and signal summaries.
- One SQL query supplies analysis status, the selected market link, up to three
  ranked candidates, and signal summaries. Existing single-post endpoints
  remain available for other consumers.
- A status-only batch polls pending/retrieving/reasoning posts every five
  seconds without joining market or reward tables. Terminal status triggers a
  full refresh for those posts, then polling stops. Manual attach, detach,
  confirm, and dismiss actions invalidate only the affected post.
- Metadata is shared only among mounted subscribers in the same session.
  Unmounting the last subscriber removes the entry and its polling schedule.
  Responses from an old account or invalidated request cannot replace current
  data. Permanent client errors stop immediately. Transient failures get three
  retries after 5, 10, and 20 seconds while subscribers remain, then stop until
  an explicit refresh or remount.

## Verification

The isolated PostgreSQL integration suite checks twenty-post responses,
constant SQL statement count (one metadata query plus the existing auth lookup
and activity stamp), manual-link priority, candidate ranking/limits, actual
signal aggregation, hidden posts and events, both block directions,
administrator semantics, status-only SQL, authentication, and input bounds.
Together with the existing manual-link guard suite, nine backend tests passed.

Nine Chromium regressions cover the three attachment tests from step 1 and
six new tests covering a twenty-post page, pending-only polls and completion,
manual detach, unmount cleanup, and account switching with an old response still
in flight, plus bounded retries and permanent client errors. The page made one
initial metadata request, one poll for its two pending posts, and one final
refresh, with zero calls to legacy metadata
endpoints. The containerized frontend production build passed with the existing
bundle-size and browser-data warnings.

Claude Code reviewed this batch using `claude-fable-5-1`, read-only tools, and
the signed-in session with API keys unset. It found no blocking issues. Its
retry and test-coupling suggestions were addressed. Its visibility note is an
intentional behavior change: unlike the old link/signal endpoints, this batch
does not show links or reward badges for hidden markets.

## Rollout

This batch requires no migration or configuration change. Deploy the backend
endpoint before the frontend that calls it. The change is prepared on
`codex/performance-feed-metadata`. Commit `78e6be2` was deployed on 2026-09-18:
the public health endpoint passed, unauthenticated metadata requests returned
401, and both metadata query modes passed a read-only production check against
nine visible posts. The live index, entry JavaScript, and Van shell JavaScript
matched the tested build. The previous frontend is archived at
`/tmp/intellacc-frontend-before-step2-20260918.tar.gz`. Step 1 remains live.

Request reduction is verified using a component fixture and mocked HTTP data;
production latency and throughput have not been benchmarked.
