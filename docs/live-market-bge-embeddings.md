# Live-market embeddings on Debian

Matching can use Debian's existing `BAAI/bge-m3` service instead of requesting
OpenAI query embeddings through OpenRouter. `events.embedding_bge_m3` holds the
1024-dimensional vectors. The original 768-dimensional `events.embedding` and
topic vectors remain intact for topic classification and rollback.

Only markets satisfying all three conditions are backfilled:

- `outcome IS NULL`
- `closing_date > NOW()`
- `hidden_at IS NULL`

All live market types receive vectors. Retrieval retains its existing additional
requirement of binary markets or at least two active outcomes. An MD5 content
fingerprint tracks title/details changes; this is a change detector, not a
security signature. Eligibility and the fingerprint are checked again at write
time. Retrieval excludes stale vectors, while keyword matches remain eligible.
Closed, resolved and hidden markets never receive new BGE vectors from the
backfill or creation hook. Existing vectors can remain after a market closes.

## Private connection

The server's user service `intellacc-embedding-tunnel.service` authenticates to
`justus@100.119.163.1` using existing SSH credentials and verified host keys. It
forwards a private Unix socket to Debian's loopback TEI port 8085. No remote
service is changed and no new TCP listener is exposed. The service restarts on
failure; the existing user linger setting starts it at boot.

Unit template: `scripts/intellacc-embedding-tunnel.service`. Installed under
`~/.config/systemd/user/`. Its socket directory
`/home/jay/.local/state/intellacc-embeddings` is mounted read-only into the
backend at `/var/run/intellacc-embeddings`. The directory has mode 0700 and the
socket 0600; the current backend container runs as root. If changing the backend
user, explicitly grant that user socket access instead of making it public.

The adapter checks TEI's model identity and pooling, rejects malformed/non-finite
or incorrectly sized vectors, and bounds requests/responses. Each HTTP request
has a two-second timeout (a fresh model verification plus inference can take up
to four seconds). Input truncation is disabled. Large inputs fail to keyword
retrieval rather than being silently truncated.

## Rollout and maintenance

Apply `20260922_live_market_bge_embeddings.sql`, deploy the code and socket mount,
and initially leave `POST_SIGNAL_MARKET_EMBEDDING_PROVIDER=openrouter`. Populate
the separate column with:

```sh
docker exec -e POST_SIGNAL_MARKET_EMBEDDING_PROVIDER=bge-m3 intellacc_backend \
  node src/scripts/backfillLiveMarketBge.js
```

Review retrieval quality before setting this in `backend/.env` and recreating
the backend:

```dotenv
POST_SIGNAL_MARKET_EMBEDDING_PROVIDER=bge-m3
POST_SIGNAL_BGE_TIMEOUT_MS=2000
```

New-market enrichment also writes the live BGE vector. The existing embedding
sweep (first pass after 60 seconds, then every six hours) fills missing/stale
vectors, including newly unhidden/reopened markets. The legacy backfill now
also skips ineligible markets. On Debian failure, matching uses local keyword
retrieval; it never compares vectors from different models. Keyword-only
candidates are retained in the hybrid merge, including before a vector exists.

Rollback: set the provider to `openrouter` and recreate the backend. Both the
separate BGE columns and legacy vectors can be left in place. No destructive
migration is needed. Jev mode and reasoning-model selection are independent.

Small sequential measurements before rollout: Debian's first request took
96ms, then 20–26ms including the server-to-Debian SSH network path; OpenRouter
took 1464ms then 359–419ms on the same short synthetic/public queries. These are
not production load-test figures or proof of equal retrieval quality.
