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
GPT-6 Luna generates the argument review, with DeepSeek V4.1 Flash as fallback:

```dotenv
POST_SIGNAL_JEV_MODE=primary
POST_SIGNAL_MATCH_REASONER_MODEL=openai/gpt-6-luna
POST_SIGNAL_MATCH_REASONER_FALLBACK_MODELS=deepseek/deepseek-v4.1-flash
```

Long posts inherit that model unless explicitly overridden. The same reasoner
handles uncertain Jev decisions. Existing confirmed links remain protected.
Critiques are generated after submission for eligible predictive posts with
retrieved candidates. Casual posts do not incur a critique request. An empty
critique array means no feedback to display, not a verified factual endorsement.
Existing stored critiques become visible without bulk regeneration.

The prompt requests at most three substantive, constructive critiques in the
post's language, with no minimum quota and no claims of external fact checking.
The migration `20260922_expand_post_critique_types.sql` aligns fresh-database
constraints with the categories already accepted by the reasoner.

Deploy the backend with the migration and updated environment, then build and
publish `frontend-solid`. Retain previous hashed assets for existing sessions.
Validation covers batched visibility and defaults, keyboard expansion, text-only
rendering, logout clearing, and Jev-link/critique completion polling.
