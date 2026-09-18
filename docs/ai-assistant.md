# Personal AI assistant (bring your own key)

Each user can connect their own model provider key and then use the assistant in
three places:

- **Private AI DMs** — a conversation with the assistant in Messages.
- **Private AI drawer on a post** — a conversation opened from a post; the post
  (and its visible ancestors) is given to the model as context.
- **Public `@ai` replies** — mentioning `@ai` in a post or comment queues a
  public reply, posted by a dedicated bot account and labelled as AI.

Every inference is billed to the **invoking user's own key**. There is no
platform key and no fallback: without a saved key the assistant simply refuses.

## Setup

### 1. Dedicated credential secret

User API keys are stored as AES-256-GCM ciphertext bound to the owning user id
(GCM additional authenticated data). The key comes from a **dedicated** secret;
`JWT_SECRET` is never used as a fallback and there is no dev default. If the
secret is missing or malformed, `GET /api/ai/settings` reports
`available: false` and saving credentials or running inference is refused (fail
closed). Existing history and credential deletion remain available.

Generate a 32-byte base64 secret on the host (never commit it):

```bash
openssl rand -base64 32
# or
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Put it in `backend/.env`:

```
AI_CREDENTIAL_SECRET=<32 bytes, base64>
```

Rotating the secret makes existing ciphertexts unreadable; affected users get
`not_configured` and must re-enter their key.

### 2. Migration

`backend/migrations/20260918_ai_assistant.sql` is additive. It creates the
`user_ai_settings`, `ai_conversations`, `ai_messages`,
`ai_conversation_requests`, `ai_usage_events` and `ai_public_reply_jobs`
tables, adds `users.system_bot_key`, and inserts the non-login bot account
(`system_bot_key = 'ai_assistant'`, handle `ai` if free, otherwise
`ai_assistant`, otherwise a suffixed variant). The bot is always looked up by
`system_bot_key`, never by handle, and its password hash is not a bcrypt hash,
so password login is disabled. `ai` and `ai_assistant` are also reserved usernames.

Migrations run on backend container start; production migrations are applied
at deploy time only.

### 3. Optional tuning (env)

| Variable | Default | Range | Meaning |
| --- | --- | --- | --- |
| `AI_MAX_REQUESTS_PER_HOUR` | 30 | 1–1000 | Durable per-user budget (all kinds) |
| `AI_MAX_REQUESTS_PER_DAY` | 200 | 1–10000 | Durable per-user budget (all kinds) |
| `AI_MAX_CONCURRENT` | 2 | 1–10 | Simultaneous generations per user |
| `AI_MAX_OUTPUT_TOKENS` | 1024 | 64–4096 | Provider `max_tokens` cap |
| `AI_PROVIDER_TIMEOUT_MS` | 60000 | 5000–120000 | Abort timeout per provider call |

## Providers

| id | Endpoint (fixed) | Wire format |
| --- | --- | --- |
| `openai` | `https://api.openai.com/v1/responses` | Responses API, `store: false`, `instructions` + role `input`; text read from `output[type=message].content[type=output_text]` |
| `anthropic` | `https://api.anthropic.com/v1/messages` | `system` separate, `max_tokens`, header `anthropic-version: 2023-06-01` |
| `openrouter` | `https://openrouter.ai/api/v1/chat/completions` | Chat completions with a leading system message |
| `xai` | `https://api.x.ai/v1/chat/completions` | Chat completions with a leading system message |

- Hosts are hard-coded; there is no base-URL setting. Redirects are errors.
- The model id is whatever the user types: 1–128 chars of letters, digits and
  `. _ : / -`. Nothing is hard-coded, no "latest" defaults.
- No tools, search or browsing are requested, and the system prompt tells the
  model it cannot browse or read private messages.
- Responses are read with a 1 MiB cap and assistant text is truncated at 16 000
  characters. Errors are mapped to short codes (`auth`, `rate_limited`,
  `model_not_found`, `billing`, `bad_request`, `upstream`, `timeout`,
  `network`, `invalid_response`, `empty_response`, `response_too_large`).
  Provider bodies, prompts and keys are never logged or returned.

## API

All routes live under `/api/ai`, require a JWT session and reject agent API
keys (`403`). Error bodies are `{ error: <code>, message: <safe text> }`.

### Settings

| Method | Path | Body / result |
| --- | --- | --- |
| `GET` | `/ai/settings` | `{ configured, provider, model, keyHint, publicReplies, available }` — never the key or ciphertext; `keyHint` is `…` + last 4 chars |
| `PUT` | `/ai/settings` | `{ provider, model, apiKey?, publicReplies }`. Omitted/empty `apiKey` keeps the stored key **only for the same provider**; switching providers requires a new key. Returns the same shape as `GET`. `503` when `available` is false |
| `DELETE` | `/ai/settings` | Deletes the credential. `{ ok: true }` |
| `POST` | `/ai/test` | One tiny inference with the saved settings (≤16 tokens). `{ ok: true }` or `502 { error, message }`; counts against the budget |

### Private conversations

| Method | Path | Body / result |
| --- | --- | --- |
| `GET` | `/ai/conversations` | `{ conversations: [{ id, title, post_id, updated_at }] }` — the owner's 50 most recent |
| `POST` | `/ai/conversations` | `{ postId? }` → `201 { conversation: { id, title, post_id } }`. No provider call. The post must be visible to the caller (hidden, blocked or non-member group posts → `404`) |
| `GET` | `/ai/conversations/:id` | `{ conversation, messages: [{ id, role, content, model, status, error_code, created_at }] }` — last 100 turns, chronological. `status` is `ok` or `failed`; in-flight turns are not returned. Other owners get `404` |
| `POST` | `/ai/conversations/:id/messages` | `{ message (≤8000 chars), requestId (UUID) }` → `{ messages: [userMessage, assistantMessage] }` |
| `DELETE` | `/ai/conversations/:id` | `{ ok: true }`; `409 busy` while an answer is being generated |

Sending a message:

- **Idempotent per `requestId`.** A repeat of a succeeded request replays the
  stored turns without a provider call. A repeat while running returns
  `409 in_progress`. A repeat of a failed request returns
  `409 request_failed` with `errorCode`; the client must choose a **new**
  `requestId` to retry (that is a new paid attempt the user chose).
- **One generation per conversation** (`409 busy`). A generation older than
  five minutes is treated as crashed: it is marked `failed/interrupted` and the
  conversation becomes usable again. Ambiguous outcomes (timeouts, crashes)
  are never retried automatically.
- Provider failures return `502 { error: <code>, message }`; missing key or
  model return `400 not_configured` / `400 invalid_model`; budget exhaustion
  returns `429`.
- Prompt bounds: the last 20 successful turns (≤24 000 chars), the post
  context (≤4 000 chars) plus up to 8 visible ancestors (≤12 000 chars).

History is stored in plaintext on the server, separate from the end-to-end
encrypted MLS user-to-user messages. The application server and chosen provider
process AI conversations. The UI explains this. Users can delete conversations.

### Public `@ai` replies

`POST /api/posts` recognises an explicit `@ai` token (standalone handle; not
`x@ai.example`, `@ai_bot`, `@aiden`). Bot posts and reposts never trigger it.
The post is always published; the response gains:

- `aiReplyStatus: 'queued'` when a job was created, or
- `aiReplyStatus: 'declined'` plus a human-readable `aiNotice` when setup is
  missing (no key, public replies off, no model, secret unavailable, group post).

| Method | Path | Result |
| --- | --- | --- |
| `GET` | `/ai/public-replies/:postId` | Requester-only status: `{ status: queued\|running\|published\|failed\|declined, reason, errorCode, replyPostId, model, updatedAt }`; `404` for other users |

The worker (started from `src/index.js`) claims queued jobs atomically
(`FOR UPDATE SKIP LOCKED`, 180 s lease), re-checks the requester's key and
`publicReplies` flag, loads **only the visible public ancestor chain** (hidden,
blocked or deleted-author ancestors and any group post fail the job with a
clear reason), reserves budget, calls the provider once, then publishes in a
transaction that re-validates the post and the lease. The reply is a comment by
the bot with `is_bot = true`, formatted as:

```
[AI reply · <model> · requested by @<username>]

<answer>
```

It increments the parent's comment count, creates the usual comment/reply
notification for the requester, emits `new_comment` to the post room and a
private `ai_public_reply_status` event to the requester. Publication is
at-most-once (`reply_post_id` is unique; expired leases are failed, never
re-run). Failures are visible through the status endpoint and the socket event.

## Limits and abuse controls

- **Route limiter**: 20 generation requests / minute and 30 settings changes /
  15 minutes per user (relaxed outside production).
- **Durable budget** (`ai_usage_events`): every reserved attempt — public,
  private or test, successful or not — counts toward the hourly and daily
  caps, and at most `AI_MAX_CONCURRENT` generations run per user.
- Per-conversation lock and per-post job uniqueness prevent double billing.
- Agent API keys cannot read settings, run inference or read private history.

## Tests

`backend/test/ai_*.test.js` run without a database or network (the pg pool is
faked, providers are injected). From the repo root:

```bash
docker run --rm --network none \
  -v "$PWD/backend:/workspace:ro" -w /workspace \
  -e NODE_PATH=/usr/src/app/node_modules \
  intellacccom-backend /usr/src/app/node_modules/.bin/jest test/ai_ --runInBand --forceExit
```

(The `intellacccom-backend` image keeps `node_modules` under `/usr/src/app`.)

`backend/test/aiIntegration.smoke.js` additionally exercises the real SQL with
synthetic users and stubbed model completions. It refuses any database not named
`ai_test`. Run it only in a disposable database loaded with a schema-only dump
and this migration, never against production. It checks concurrency, replay,
ownership, public publication, hidden/group ancestry and HTTP agent-key guards.

Browser regression coverage is in `tests/e2e/ai-assistant.spec.js`, using the
fixture at `frontend-solid/test/ai-assistant.html` and mocked API responses.
It covers both skins, the mobile sheet, draft persistence, continuation in
Messages, key setup/removal, logout cleanup and retries reusing request IDs.

Validation on 2026-09-18: 82 new backend tests, 16 existing feed/account/post
regressions, four browser tests, the frontend production build and the isolated
database smoke check passed. The migration was applied twice successfully to a
copy of the current production schema without any production user data.
No live provider requests or production deployment were performed.

Official API references used for the adapters:

- [OpenAI Responses](https://developers.openai.com/api/reference/typescript/resources/beta/subresources/responses/methods/create)
- [Anthropic Messages](https://platform.claude.com/docs/en/api/messages/create)
- [OpenRouter](https://openrouter.ai/docs/quickstart)
- [xAI Chat Completions](https://docs.x.ai/developers/rest-api-reference/inference/chat-completions)
