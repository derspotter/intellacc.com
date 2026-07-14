# WhatsApp OTP Channel via wacli — Design (PARKED)

Status: **parked** — approved design, not scheduled for implementation until a
dedicated WhatsApp number exists for Intellacc. See "Preconditions to unpark".

## Summary

Phone verification gains a user-selectable delivery channel: SMS (default) or
WhatsApp. WhatsApp delivery uses [wacli](https://wacli.sh) (whatsmeow-based
WhatsApp Web linked device, MIT), paired to a **dedicated Intellacc number**.
There is **no automatic cross-channel fallback**: a failed send returns an
error and the user retries, optionally on the other channel.

This replaces and removes the never-deployed OpenClaw CLI fallback path.

## Hard constraints

1. **Never use the Kanzlei WhatsApp session.** The wacli install at
   `~/.local/bin/wacli` with store `~/.local/state/wacli` is paired to the
   Kanzlei number (`4915129780850`) and is under a strict no-automation,
   human-reviewed-sends policy. It must never be mounted into, copied into, or
   invoked by any Intellacc container or service. Intellacc gets its own
   number, its own store, its own pairing.
2. No fallback between channels. The chosen channel either delivers or the
   request fails with a channel-specific error.
3. OTP generation, hashing, TTL, attempt limits, and rate limits are unchanged
   (`phone_verification_challenges` machinery stays as is).
4. Kill switch: unsetting the `WACLI_*` env vars removes the WhatsApp channel
   from the status payload and the UI; SMS-only behavior is restored with no
   code change.

## Preconditions to unpark

- A dedicated phone number (spare SIM/eSIM) for Intellacc WhatsApp sends.
- Acceptance that the number may be banned by Meta (unofficial protocol,
  automated traffic); the number must be disposable for the platform.
- The phone owning that number can come online periodically to keep the
  linked-device session alive.

## Backend changes (`backend/src/services/phoneVerificationService.js`)

### Remove

- `sendViaOpenClaw` and all `OPENCLAW_*` env accessors.
- The SMS→WhatsApp fallback branch in `deliverVerificationCode` (and the
  `fallback_from` result field).
- `channels.whatsapp_fallback` from `getProviderStatus()`.

### Add

- Env config: `WACLI_BIN` (path to binary), `WACLI_STORE_DIR`,
  `WACLI_TIMEOUT_MS` (default 15000).
- `useWacli()` — true when not under Jest and `WACLI_BIN` + `WACLI_STORE_DIR`
  are set.
- Startup health check: when `useWacli()`, run
  `wacli doctor --json --store $WACLI_STORE_DIR` once at boot; log (not crash)
  on failure and report the channel unavailable until it passes.
- `sendViaWacli(phoneNumber, message)`:
  - recipient is the E.164 number **without** the leading `+`
    (`normalizePhone` digits) — never a contact-name match;
  - `execFile(WACLI_BIN, ['send', 'text', '--to', digits, '--message',
    message, '--json', '--store', WACLI_STORE_DIR, '--lock-wait', '30s'],
    { timeout: WACLI_TIMEOUT_MS, maxBuffer: 1MB })`;
  - all wacli sends are serialized through one in-process promise queue
    (single SQLite store; parallel invocations contend on the store lock);
  - returns `{ provider: 'wacli-whatsapp', channel: 'whatsapp' }`.
- `startPhoneVerification(userId, phoneNumber, channel = 'sms')`:
  - `channel` validated against `['sms', 'whatsapp']` and against current
    availability (`whatsapp` requires `useWacli()` + healthy doctor check);
  - routes to `sendViaSmsGateway` / Twilio for `sms` (unchanged) or
    `sendViaWacli` for `whatsapp`;
  - the existing `channel` column on `phone_verification_challenges` records
    the channel actually used (it already exists; no migration needed).
- `getProviderStatus().channels` becomes `{ sms: <bool>, whatsapp: <bool> }`.

### API surface

- `POST` start-phone-verification endpoint accepts optional `channel` in the
  body; missing/unknown → `sms`; explicitly requested-but-unavailable
  `whatsapp` → 400 with a clear error, not a silent SMS downgrade.
- Verification status payload exposes the new `channels` object so the
  frontend can render the picker.

## Frontend changes (`frontend-solid/src/components/verification/PhoneVerification.jsx`)

- Channel toggle (SMS / WhatsApp radio pair) above the phone input, rendered
  only when the status payload reports `channels.whatsapp === true`. Default
  SMS. Today (channel unavailable) the UI is pixel-identical to current.
- Selected channel is passed to `api.verification.startPhoneVerification`.
- On send failure, error copy suggests retrying with the other channel when
  one is available.

## Deployment (when unparked)

- Build wacli into the backend image: multi-stage Dockerfile stage
  (`golang` builder, cgo enabled — wacli requires it) or `COPY` of the
  checksum-verified `linux_arm64` release binary.
- Named Docker volume mounted at `WACLI_STORE_DIR` (fresh, empty — never a
  bind mount of any host wacli store).
- One-time pairing: `docker exec -it intellacc_backend wacli auth` (QR in
  terminal, scanned by the dedicated number's phone). Session persists on the
  volume across image rebuilds.
- `backend/docker-compose.yml`: replace the `OPENCLAW_*` env passthrough with
  `WACLI_BIN` / `WACLI_STORE_DIR` / `WACLI_TIMEOUT_MS` and the volume.
- Update `docs/verification-production-checklist.md` accordingly.

## Error handling

- wacli exec failure (non-zero exit, timeout, unauthenticated session) →
  send error surfaced to the user as "WhatsApp delivery failed — try SMS";
  logged server-side with exit code / stderr summary, no OTP or full phone
  number in logs (hash or last-4 only, matching existing log hygiene).
- Doctor-check failure at boot → channel reported unavailable; SMS untouched.
- No retry loop at the transport layer (resend is a user action, already
  rate-limited by the challenge machinery).

## Testing

- Jest (wacli disabled under Jest, mirroring the old OpenClaw guard):
  - `channel` validation: unknown channel → error; `whatsapp` while
    unavailable → error; default is `sms`;
  - no-fallback semantics: SMS transport failure does not invoke any
    WhatsApp code path and vice versa;
  - status payload shape (`channels.sms` / `channels.whatsapp`).
- E2E (Playwright): picker absent when WhatsApp unavailable — the production
  state until unparked. A picker-visible spec is written but tagged to run
  only against a wacli-configured environment.

## Removed alternatives (for the record)

- **OpenClaw CLI as transport** — superseded; code path deleted.
- **Reusing the Kanzlei wacli session** — rejected: automated sends from the
  law office number (policy violation), ban risk to the Kanzlei line, and the
  store contains privileged client communications that must not be readable
  by the Intellacc backend.
- **Cross-channel fallback** — rejected by product decision (predictability
  over delivery rate).
