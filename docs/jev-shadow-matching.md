# Jev post-to-market comparison

Jev observes the existing matcher in `shadow` mode. It cannot create or remove
market links, change critiques, reward authors, settle markets or trade. The
default is `off`; unknown mode values also disable it. This is an evaluation
integration, not an automatic replacement for the matcher.

## Configuration and deployment

Reuse the backend's existing `OPENROUTER_API_KEY`. No separate TypeSafe account
or key is required. Set these in the backend Compose environment source:

```dotenv
POST_SIGNAL_JEV_MODE=shadow
POST_SIGNAL_JEV_MODEL=typesafe/jev-1.13
```

The existing `POST_SIGNAL_AGENTIC_MATCH_ENABLED` and gate must also be enabled.
Deploy the backend code and additive `20260921_jev_shadow_matching.sql` migration,
then recreate the backend to load its new environment. A restart alone does not
load changed Compose variables. Use `POST_SIGNAL_JEV_MODE=off` and recreate to
disable calls. No frontend build is needed. A missing key produces a diagnostic
skip, never a request. Jev uses OpenRouter's alpha Decisions endpoint,
`https://openrouter.ai/api/alpha/decisions`, not chat completions. The endpoint
is fixed even if `OPENROUTER_BASE_URL` overrides the existing chat matcher.

Only public, visible, top-level posts are sent. Group posts, comments, DMs and private AI
history are excluded. Input includes the post, any article text already fetched
by the existing pipeline, and candidate market titles, details and deadlines.
Enabling this sends that content to TypeSafe through OpenRouter using the
server's shared key. Personal BYOK keys are not used. Redirects are rejected.

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
model version, prompt version, token usage, OpenRouter-reported cost, latency and
the baseline result. OpenRouter rounds probabilities to two decimal places;
validation allows that rounding and preserves the returned distribution.
Post/article bodies are not duplicated. The report excludes edited/superseded
versions. Counts describe latest posts, not all billed attempts or historical runs.
Jev observations stay separate from existing chat-matcher usage tables, although
the calls bill to the same OpenRouter account.

## Review

Run the read-only report from the deployed checkout:

```bash
docker exec -i intellacc_db psql -U intellacc_user -d intellaccdb \
  < backend/scripts/jev-shadow-report.sql
```

The report includes OpenRouter-reported USD cost and a separate estimate using
the published $0.042 per million input tokens. Neither is a complete account
invoice. Missing usage or cost remains unknown. Compare latency, failure/skip rate,
claim misses and match disagreements. Human-label a held-out set including
unrelated posts, ambiguous wording and markets with differing deadlines. Include
both easy agreements and disagreements; agreement with the old model is not
accuracy. Select thresholds only after reviewing labels. No thresholds currently
turn these observations into user-visible decisions. Confidence is not a market
outcome forecast.

Contract checked against official documentation on 2026-09-21:

- https://openrouter.ai/typesafe/jev-1.13/api
- https://github.com/OpenRouterTeam/ai-sdk-provider#decisions
- https://openrouter.ai/labs/jev/compile
- https://docs.typesafe.ai/introduction/quickstart
- https://docs.typesafe.ai/primitives/choice
- https://docs.typesafe.ai/primitives/noul
- https://docs.typesafe.ai/confidence

Automated tests use synthetic responses and an isolated PostgreSQL database.
A small live synthetic request using the existing backend OpenRouter key on
2026-09-21 returned HTTP 200, resolved model `typesafe/jev-1.13-20260917`, and
typed answers. It reported 365 input tokens and $0.00001533 cost, taking 699 ms
in that single check. A second live check used this adapter's actual request
builder and parser with two synthetic candidate markets: HTTP 200 in 639 ms,
816 input tokens, $0.000034272 reported cost, and the matching candidate selected.
The six focused matcher/adapter suites passed all 61 tests after the OpenRouter
change. These checks verify access and integration, not calibration, production
latency or matching quality. Deployment and shadow-mode activation are separate
steps.

## Paired speed check, 2026-09-22

Five fresh synthetic/public cases used identical post and candidate inputs:
MrBeast nomination negation, Greenland acquisition negation, an unrelated
bicycle post, differing bridge-opening deadlines, and a related-topic-only
MrBeast post. Both Jev and Luna selected the expected market or none in all
five. This measures selection, not stance accuracy or critique quality.

| Case | Jev ms | Luna ms | Jev USD | Luna USD |
| --- | ---: | ---: | ---: | ---: |
| MrBeast NO | 693 | 4708 | 0.000031626 | 0.00087735 |
| Greenland NO | 330 | 4700 | 0.000031500 | 0.00094860 |
| No match | 351 | 3086 | 0.000031248 | 0.00068720 |
| Deadline | 327 | 5468 | 0.000031038 | 0.00103165 |
| Related topic only | 381 | 2480 | 0.000031290 | 0.00059505 |

Mean request latency was 416ms for Jev versus 4088ms for Luna (9.8x), with
26.4x lower reported cost. Jev performs fewer tasks: the current adapter has
no stance decision, argument extraction or written critiques. These times
exclude the gate, retrieval, article fetch and persistence. They are not
end-to-end production latency or a representative quality benchmark.

A production matching replacement needs a stance decision, reviewed confidence
thresholds, an uncertainty/error fallback, and separation of written critiques
from the decision path. Simply changing the model name cannot do this.
