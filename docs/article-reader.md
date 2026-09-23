# Browser fallback for article text

`fetchArticleContent` first uses the existing HTTP + Readability path. On an
HTTP error or missing readable text, it calls the private `article-reader`
service. This shared function supplies both market matching/public critiques
and private post chats. Metadata previews keep their existing HTTP-only path.

The browser reads anonymous public HTML with Chromium, then runs Mozilla
Readability. Website JavaScript, service workers, subframes, images, and other
subresources are disabled. There is no login, paywall handling, CAPTCHA solving,
stealth plugin, or use of account cookies. A failed fetch stays unavailable.
Sites that require their own JavaScript may not work with this reader.

The reader has no provider keys, database credentials or application mounts.
Only the backend and reader join the private Docker network. The reader also
has a separate egress network, with no published port. Browser traffic passes
through a per-job proxy that accepts only HTTP/HTTPS on ports 80/443. Each
connection resolves and checks all addresses and connects directly to a checked
public IP, including redirect destinations. Private, loopback, reserved and
IPv4-mapped private IPv6 destinations are rejected.

Each job gets a fresh browser and context. At most two jobs run, with no queue;
excess requests return 503 and normal callers receive unavailable article text.
The service has a 20-second deadline; the backend has a shared 25-second total
deadline for HTTP plus browser retrieval and cancels the worker on disconnect.
Traffic, decoded HTML and returned text are bounded (12 MiB, 5 MiB and 100,000
characters respectively). Existing smaller model prompt limits still apply.
Article text is ephemeral, never saved in the database, files or logs.

## Operations

The production compose service is `article-reader`, container
`intellacc_article_reader`. Build it before recreating the backend:

```sh
docker compose build article-reader
docker compose up -d --no-deps article-reader
docker compose up -d --no-deps --force-recreate backend
```

`ARTICLE_BROWSER_URL=http://article-reader:3012` is set by production compose.
The private network uses `10.233.241.0/28` because this host's automatic Docker
address pool is exhausted. `ARTICLE_READER_PRIVATE_SUBNET` can override it on
hosts with a conflicting LAN/VPN subnet.
Omitting this variable disables browser fallback in other stacks. The service
returns `GET /health` and accepts `POST /read` with `{ "url": "https://..." }`.
It returns `{ text, url }`, or a generic error without article or URL logging.
Its image pins matching Playwright package/browser versions. It runs as a
non-root user with a read-only filesystem, temporary browser storage, dropped
capabilities, and CPU/memory/process limits.

Run reader tests in its image, mounting `article-reader/test` at `/app/test`,
with `npm test`. Backend regression tests are `article_browser_fallback.test.js`,
`metadata_deadline.test.js`, and `ai_conversations.test.js`. For live validation,
call `fetchArticleContent` from the backend and verify text length/title markers
without printing or retaining the full article.
