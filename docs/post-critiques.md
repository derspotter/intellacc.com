# Post critiques

Public posts with stored critiques show an expandable **AI critique · N** section
below their market links in both feed layouts. Critiques also appear when no
market matches. Feedback is labelled as AI-generated, displayed as plain text,
and does not change the author's post or Jev's market decision.

The authenticated batched `/api/posts/metadata` response includes a `critiques`
array (id, critique_type, description, severity), limited to 10 items per post.
Hidden and blocked posts are excluded by the existing visibility checks.
Community-group critiques are excluded. Status-only polls omit critiques and
their database join. A transition into reasoning refreshes the early Jev link;
completion refreshes the finished critique. There are no per-post requests.

Jev remains the primary market/stance matcher with Debian BGE hybrid retrieval.
Claude Opus 5.5 is the default public reviewer. Users can choose Opus, GPT-6 Luna,
or Off under **Settings → Public critiques on my posts**. The choice controls
future reviews of the author's public top-level posts and uses Intellacc's
OpenRouter account. Existing reviews are retained until normal reanalysis.

Matching retains its inexpensive Luna/DeepSeek fallback:

```dotenv
POST_SIGNAL_JEV_MODE=primary
POST_SIGNAL_MATCH_REASONER_MODEL=openai/gpt-6-luna
POST_SIGNAL_MATCH_REASONER_FALLBACK_MODELS=deepseek/deepseek-v4.1-flash
```

Long posts inherit that matching model unless explicitly overridden. Uncertain
Jev decisions use the inexpensive matching reasoner, followed by the author's
chosen reviewer. Reviewer failure never substitutes a cheaper public critique.
The review has a 60-second request timeout, 4000 output tokens and medium
reasoning for Opus. A malformed response can receive one format-repair attempt.
Existing confirmed links remain protected.
Critiques are generated after submission for eligible predictive posts with
retrieved candidates. Casual posts do not incur a critique request. An empty
critique array means no feedback to display, not a verified factual endorsement.
Existing stored critiques become visible without bulk regeneration.

New reviews record the actual provider model and show it in the expanded panel.
Legacy critiques have no model attribution. The authenticated session-only
`GET/PUT /api/ai/critique-settings` API uses the caller's identity, accepts only
the offered models, and does not require or change personal AI credentials.
Settings are stored in `user_post_critique_settings` by the additive migration
`20260922_post_critique_preferences.sql`.

**Critique privately** opens a prepared question in the reader's private AI
conversation about the post. The reader presses Send to generate it using their
personal provider, model and API key from **Your AI assistant** settings.
Unconfigured OpenRouter settings suggest Opus 5.5, while saved choices remain
unchanged. Private feedback stays in owner-scoped AI history and never updates
the public critique. Existing request budgets, idempotency and visibility checks
apply. Opening the draft alone makes no paid request.

The prompt requests at most three substantive, constructive critiques in the
post's language, with no minimum quota and no claims of external fact checking.
The migration `20260922_expand_post_critique_types.sql` aligns fresh-database
constraints with the categories already accepted by the reasoner.

Deploy the backend with the migration and updated environment, then build and
publish `frontend-solid`. Retain previous hashed assets for existing sessions.
Validation covers batched visibility and defaults, keyboard expansion, text-only
rendering, logout clearing, and Jev-link/critique completion polling.
