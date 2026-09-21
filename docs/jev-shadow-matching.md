# Jev post-to-market comparison

Jev observes the existing matcher in `shadow` mode. It cannot create or remove
market links, change critiques, reward authors, settle markets or trade. The
default is `off`; unknown mode values also disable it. This is an evaluation
integration, not an automatic replacement for the matcher.

## Configuration and deployment

Set these in the backend Compose environment source (keep the key out of Git):

```dotenv
POST_SIGNAL_JEV_MODE=shadow
POST_SIGNAL_JEV_MODEL=jev-1.13.0
TYPESAFE_API_KEY=<your TypeSafe API key>
```

The existing `POST_SIGNAL_AGENTIC_MATCH_ENABLED` and gate must also be enabled.
Deploy the backend code and additive `20260921_jev_shadow_matching.sql` migration,
then recreate the backend to load its new environment. A restart alone does not
load changed Compose variables. Use `POST_SIGNAL_JEV_MODE=off` and recreate to
disable calls. No frontend build is needed. A missing key produces a diagnostic
skip, never a request. API access must be obtained from TypeSafe.

Only public, visible, top-level posts are sent. Group posts, comments, DMs and private AI
history are excluded. Input includes the post, any article text already fetched
by the existing pipeline, and candidate market titles, details and deadlines.
Enabling this adds TypeSafe as a processor of that content. No user provider keys
are reused. The endpoint is fixed and redirects are rejected.

## Behavior and limits

The existing gate and retrieval run unchanged. Jev evaluates claim presence,
each retrieved candidate's relevance, and a best-market choice with an explicit
`none` option. Negative baseline gates still get a claim-presence comparison,
but no extra retrieval is performed. Failed baseline gates are observed too,
and excluded from the report's comparison rows. That allows inspection of suspected missed
claims, not a measurement of which market a missed claim would match.

Calls overlap the existing reasoner where possible. The pipeline awaits the
bounded result before final persistence (up to 3 seconds of API time plus a
1-second eligibility query). It saves a separate observation under the same
post-version locks as the baseline. Failed diagnostics use a savepoint and do
not roll back matching. A missing migration prevents paid calls. Provider errors
are reduced to fixed codes (validation errors include a field identifier), with no raw
response/error bodies or keys logged.

Limits are 2 concurrent calls and 500 attempts per UTC day **per backend process**,
15 candidates, 48 KB serialized input and 64 KB response. Oversized inputs are
skipped rather than silently truncated. There are no retries or queued calls.
The in-memory allowance resets on process restart and is not a billing cap.

One observation per post is retained, replaced on reanalysis and removed on post
deletion. It records input hashes, market snapshots, validated decisions, actual
model version, prompt version, token usage, latency and the baseline result.
Post/article bodies are not duplicated. The report excludes edited/superseded
versions. Counts describe latest posts, not all billed attempts or historical runs.
Jev usage stays separate from existing OpenRouter cost/usage accounting.

## Review

Run the read-only report from the deployed checkout:

```bash
docker exec -i intellacc_db psql -U intellacc_user -d intellaccdb \
  < backend/scripts/jev-shadow-report.sql
```

The cost estimate uses the published $0.042 per million input tokens, not an
invoice. Missing usage remains unknown. Compare latency, failure/skip rate,
claim misses and match disagreements. Human-label a held-out set including
unrelated posts, ambiguous wording and markets with differing deadlines. Include
both easy agreements and disagreements; agreement with the old model is not
accuracy. Select thresholds only after reviewing labels. No thresholds currently
turn these observations into user-visible decisions. Confidence is not a market
outcome forecast.

Contract checked against TypeSafe's official docs on 2026-09-21:

- https://docs.typesafe.ai/introduction/quickstart
- https://docs.typesafe.ai/primitives/choice
- https://docs.typesafe.ai/primitives/noul
- https://docs.typesafe.ai/confidence

Tests use synthetic responses and an isolated PostgreSQL database. They do not
establish live provider availability, latency, calibration or matching quality.
