# Post matcher response contract and models

The LLM reasoner defaults to `openai/gpt-5.6-luna`, including posts longer than
400 words. The fallback is `deepseek/deepseek-v4.1-flash`. The claim gate,
hybrid retrieval and optional Jev shadow comparison retain their own roles.

Recommended backend environment:

```dotenv
POST_SIGNAL_MATCH_REASONER_MODEL=openai/gpt-5.6-luna
POST_SIGNAL_MATCH_REASONER_FALLBACK_MODELS=deepseek/deepseek-v4.1-flash
POST_SIGNAL_MATCH_REASONER_MAX_TOKENS=2500
POST_SIGNAL_MATCH_REASONING_MAX_TOKENS=256
POST_SIGNAL_MATCH_REASONER_TIMEOUT_MS=20000
```

Existing environment values override code/Compose defaults. Recreate the backend
after changing its Compose environment. Long posts inherit the ordinary model
and fallback unless `POST_SIGNAL_MATCH_REASONER_HEAVY_MODEL` or
`POST_SIGNAL_MATCH_REASONER_HEAVY_FALLBACK_MODELS` is explicitly configured.
The server's existing `OPENROUTER_API_KEY` is used. No frontend build is needed.

## Response repair

The full JSON schema now travels in the prompt as well as `response_format`.
If an endpoint cannot enforce structured outputs, the same contract remains in
the prompt. The response is validated locally before normalization, including
required arrays, enums, candidate IDs, probability range and references that
would otherwise be silently discarded. A bare `best_market: 1653` is invalid:
we cannot infer its stance, so one repair request asks for a complete object.

There are at most two reasoner rounds, each using the bounded configured model
fallback list. With the default two models and 20-second timeout, the worst
case is approximately 80 seconds of API attempts. Valid explicit no-match JSON
is accepted immediately. Repeated malformed output raises
`MATCH_REASONER_INVALID_OUTPUT`; the existing pipeline records the error,
retains retrieval candidates, and does not erase prior links or critique state.
No raw malformed response is echoed into repair prompts or diagnostic errors.

Stance means whether the post predicts the chosen market's affirmative YES
outcome. It does not mean whether the model agrees with the author's argument.
One-claim posts can have an empty relations array instead of a fabricated
self-relation.

## Evidence, 2026-09-21

Official Luna documentation lists structured outputs and pricing of $0.20 per
million input tokens and $1.20 per million output tokens:
https://developers.openai.com/api/docs/models/gpt-5.6-luna

The first five-case live comparison selected the expected market or no-match
with both Luna and Gemini Flash. Luna mislabeled Greenland's stance once;
Gemini got all five market/stance pairs right. Luna's total reported cost for
those five requests was $0.0051304 versus Gemini's $0.012008.

After making stance semantics explicit, Luna passed seven checks: Greenland
negation, MrBeast negation, a positive AI claim, a new bridge-opening negation,
a double-negative election claim, a negatively worded market, and an unrelated
post. Those seven calls took 3.7–7.8 seconds each and cost $0.00061–$0.00140 each.
The schema-free MrBeast recovery path also passed a live check with the full
contract in the prompt. All calls were evaluations; no post or link was changed.

This is a small task-specific check, not proof of universal model superiority
or a production accuracy guarantee. The selection balances the observed
behavior and cost. Continue evaluating disagreements, especially subtle scope
and deadline differences and long arguments.

## Fallback update, 2026-09-22

DeepSeek V4.1 Flash replaces Gemini Flash as the configured fallback, including
long posts. OpenRouter lists provider-dependent pricing, starting at $0.12 per
million input and $0.48 per million output tokens at the time of this change:
https://openrouter.ai/deepseek/deepseek-v4.1-flash
The historical Gemini comparison above is retained as evaluation evidence.

DeepSeek requests use `reasoning.effort=low`; Luna retains its existing budget.
The full response schema is preserved when the fallback is used. DeepSeek's
model catalog exposes low/high/max effort, with high as its default, rather
than a hard reasoning-token budget. Live checks with the old token-budget
request had two successes and two 20-second timeouts. Three low-effort checks
had two successes (13.7s and 9.9s) and one timeout. The successful low-effort
calls reported $0.0011304 and $0.00028476. Lower list prices do not guarantee
lower total cost or better latency on every request. The timeout remains 20s.
