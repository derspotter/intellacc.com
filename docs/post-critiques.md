# Post critiques

Public posts with stored critiques show an expandable **AI critique · N** section
below market links in both layouts. Text is rendered safely and labelled as AI
feedback. New critiques show the model that produced them. Legacy critiques
have no model attribution.

## Personal keys and model choice

Critiques always use the requesting user's own saved provider/API key. Model IDs
are free text, validated for syntax, with no fixed model allowlist. The four
supported provider connections are OpenRouter, OpenAI, Anthropic and xAI.
There is no default critique model or platform-funded critique fallback.

Users first save a provider, API key and model under **Your AI assistant**.
Private critiques use that model. Public critiques on the author's own new
posts require a separate opt-in under **Public critiques on my posts**. An
optional public model ID overrides the assistant model using the same provider
and credential. Blank means inherit the assistant model. Saving model choices
or disabling reviews does not generate a paid request or alter existing reviews.

`GET/PUT /api/ai/critique-settings` is session-only and owner-scoped. The update
body is `{ enabled: boolean, model: string }`. Enabling requires an available
personal credential. Removing that credential immediately prevents new reviews.
Existing opt-ins from the former platform-funded implementation default to off
through `20260922_user_funded_critiques.sql`; they are not permission to bill a
personal key. Any account-specific Opus choice is stored in that account's
settings, never in a global model default.

## Generation and matching

Jev remains the primary market matcher using the platform's OpenRouter key and
Debian BGE hybrid retrieval. Its inexpensive matching fallback remains Luna and
DeepSeek. The matching reasoner cannot produce public critiques. A missing key,
opt-out or critique failure does not prevent matching or remove a Jev link.

The public critique service independently loads the author's encrypted
credential, rechecks the current public post content and opt-in, and reserves
an attempt against the existing personal AI budget. It uses the same fixed
provider endpoints, bounded inputs/responses and sanitized errors as AI chats.
No provider request holds a database connection. It requests at most three
constructive critiques, with no minimum quota and no claimed web fact checking.
Malformed output is rejected without a paid repair or fallback.

`ai_post_critique_requests` deduplicates by post, content hash, provider and model.
Completed results can be reused. Running/failed attempts do not automatically
retry or charge again. Public review reservations count toward the shared
personal AI request and concurrency limits. Pipeline version/visibility checks
protect the final publication against edits and hidden posts.

**Critique privately** opens a prepared question in the reader's private AI
conversation. Pressing Send invokes their personal model/key. This path retains
private-chat owner isolation, request idempotency and budgets and never changes
the public critique. Opening the draft makes no paid request.

## Presentation and deployment

The authenticated batched `/api/posts/metadata` endpoint returns up to ten stored
critiques per visible post. Hidden/blocked posts and community-group critiques
are excluded. Status-only polling omits the critique join. Jev's early link and
completed critiques refresh without per-post requests.

Deploy backend migrations before the frontend. Preserve prior hashed assets and
verify the public index and lazy assets. Tests cover arbitrary model selection,
key ownership, opt-in/missing-key behavior, budget enforcement, concurrent
request deduplication, provider failure, matching independence, safe rendering,
private drafts, and persistence of account settings.
