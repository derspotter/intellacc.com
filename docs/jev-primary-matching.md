# Jev primary market matching

`POST_SIGNAL_JEV_MODE=primary` makes Jev responsible for claim detection, market
selection and YES/NO/related stance on eligible public top-level posts. The
existing OpenRouter key and `typesafe/jev-1.13` model are used through the
Decisions endpoint. No frontend deployment or new database migration is needed.
This is post-submission matching; draft suggestions are not part of this change.

## Request path

1. Existing article augmentation, where applicable.
2. Hybrid retrieval using the live-market BGE index on Debian and local keywords.
3. One Jev request for claim presence, best market/none, each candidate's relevance
   and stance relative to its affirmative YES outcome. No preliminary LLM gate.
4. For an accepted decision, publish its link under the existing post/run locks.
5. Generate arguments/critiques with Luna (DeepSeek fallback). This text generation
   cannot replace Jev's selected market or stance. Its failure leaves the link
   available, and its delayed completion cannot overwrite a newer post edit.

The post remains in `reasoning` while critique generation runs, but the saved
market link is available to readers. Existing frontend rendering shows links
regardless of that processing status. A confident no-claim result skips all LLM
work and discards topic-only candidates. A confident no-market result for a
predictive claim can still receive critiques, without acquiring an LLM link.
Because critiques still use an LLM, faster matching does not eliminate that cost.

## Routing policy

Initial thresholds require both returned choice confidence and chosen-option
probability of at least 0.85 for market and stance, plus claim probability and
selected-market relevance of at least 0.8. A no-market decision needs the same
0.85 threshold and a clear claim/no-claim result. These are conservative routing
thresholds, not calibrated accuracy or outcome-probability guarantees.

Uncertainty, inconsistent output, missing schema/key, endpoint errors, timeouts,
oversized input, concurrency saturation and daily budget exhaustion all take
the existing LLM gate/reasoner path. There is no second Jev call on that fallback.
The limits remain three seconds per request, two concurrent calls, 500 attempts
per UTC day per backend process, 15 candidates and bounded input/output sizes.
The daily allowance resets on restart and is not an account billing cap.

Both persistence phases check the exact post content and processing run.
Primary-mode persistence rechecks public visibility and whether the selected
market remains open, unresolved and visible. Author-confirmed links outrank
automatic decisions, including links originally created by auto-matching.
Private/group posts and comments are not sent to Jev; existing LLM behavior for
those posts is retained. The existing master matcher/gate enable flags remain
required operational controls.

## Configuration, diagnostics and rollback

```dotenv
POST_SIGNAL_JEV_MODE=primary
POST_SIGNAL_JEV_MODEL=typesafe/jev-1.13
```

Recreate the backend to load these Compose settings. `off` restores the LLM path;
`shadow` restores comparison-only behavior. Changing modes affects future runs
and does not bulk rewrite existing posts.

The existing `post_match_jev_shadow` table now holds observations for both modes,
identified by `result.mode`. Primary results include `routing` (`primary` or
`llm_fallback`) and a fixed `fallback_reason`. The shadow comparison report
excludes them. Primary API costs are also included in normal usage records with
stage `jev`; subsequent text generation uses stage `critique`.

## Validation, 2026-09-22

Ten live evaluations using actual BGE candidate retrieval all selected the
expected market/none and stance. They cover MrBeast and Greenland negations,
positive AI/gold/NATO claims, Beyond Meat negation, a double negative, unrelated
text, topic-only text and German wording. Jev requests took 296–742ms and
reported $0.000013734–$0.000360906 per call. All ten passed the initial routing
thresholds. These are small evaluations, not a broad accuracy benchmark.

Database tests use an isolated PostgreSQL instance and deterministic barriers
for early publication and late critique/post-edit races. They cover fallback,
critique failure, invalid critique writes, confirmed links, privacy changes,
market hiding and suppression of candidates for no-claim results.

The full backend run passed all 94 suites (666 tests passed, one skipped).
After the final conclusion-link safeguard, all 32 tests in the four affected
persistence/primary/shadow suites passed again.
