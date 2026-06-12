# WhatsApp Bridge Extraction Plan (from OpenClaw)

Status: draft only, no implementation yet.

## Goal
- Use a self-hosted WhatsApp bridge derived from OpenClaw code.
- Keep Intellacc verification logic in our backend (OTP generation, validation, rate limits, audit).
- Use the bridge only as delivery transport.

## Scope
- In scope:
  - Extract WhatsApp transport components from OpenClaw.
  - Build a thin internal service boundary for `sendVerificationMessage`.
  - Support verification and transactional notifications.
- Out of scope:
  - Replacing existing verification logic.
  - Auto-generating OTP text with LLMs.
  - Multi-channel routing beyond WhatsApp in this phase.

## Hard Requirements
1. OTP/security state remains server-side in Intellacc.
2. Bridge failures never bypass verification checks.
3. Feature-flagged rollout with immediate kill switch.
4. Message templates for OTP remain deterministic and static.

## Unknowns to Resolve First (Gate 0)
1. OpenClaw license obligations for code extraction/derivative use.
2. Exact module boundaries for WhatsApp bridge in OpenClaw.
3. Session persistence format and reconnect behavior.
4. Throughput/rate limits and anti-ban constraints.

If any of the above fails, stop extraction and switch to provider/API route.

## Decision Matrix: Extract vs Fork vs Official API
| Option | Pros | Cons | Best Use |
|---|---|---|---|
| Extract bridge code into Intellacc | Minimal runtime surface, tighter control, easier custom hardening | Highest engineering effort, merge pain on upstream changes, license diligence required | If we want long-term ownership and lean runtime |
| Fork OpenClaw and vendor as subservice | Faster start, keeps upstream structure, easier rebases than ad-hoc extraction | Larger attack surface, more ops overhead, still tied to OpenClaw architecture choices | If we need speed and can isolate it operationally |
| Use OpenClaw as external running service | Fastest integration, little code to write | Operational dependency, interface drift risk, less control over internal behavior | Short pilot/prototype only |
| Official WhatsApp Business provider (later) | Highest delivery reliability, policy stability, better compliance posture | Higher cost, onboarding/compliance overhead | Production-grade scale and strict reliability |

Recommended sequencing:
1. Pilot quickly with `fork/subservice` or `external OpenClaw` behind adapter and flags.
2. If validated and stable, choose either:
  - stay with isolated fork for cost/control, or
  - migrate to official provider for reliability/compliance.
3. Only do deep extraction if we commit to owning long-term maintenance.

## Target Architecture
1. `verificationController` -> `verificationMessageService`
2. `verificationMessageService` -> `whatsappTransport` adapter
3. `whatsappTransport` -> extracted OpenClaw bridge runtime
4. Delivery status callback -> `verificationMessageService` event log

Interface contract (internal):
- `sendVerificationMessage({ userId, phoneE164, locale, code, templateId, requestId })`
- returns `{ accepted: boolean, providerMessageId?, errorCode? }`

## Implementation Phases

### Phase 1: Feasibility + Legal
- Inventory OpenClaw files needed for WhatsApp bridge only.
- Record dependency tree and runtime requirements.
- Produce license compliance memo (attribution, source obligations, notices).
- Decide `extract` vs `fork + vendor` strategy.

Deliverable:
- `docs/openclaw-whatsapp-feasibility.md` with go/no-go decision.

### Phase 2: Isolation Layer
- Implement `whatsappTransport` abstraction in backend (no bridge wired yet).
- Keep current verification flow unchanged behind adapter fallback.
- Add feature flags:
  - `WHATSAPP_BRIDGE_ENABLED=false`
  - `WHATSAPP_BRIDGE_PROVIDER=openclaw_extracted`
  - `WHATSAPP_BRIDGE_TIMEOUT_MS`
  - `WHATSAPP_BRIDGE_MAX_RETRIES`

Deliverable:
- Adapter interface + no-op/fallback implementation.

### Phase 3: Bridge Extraction
- Import minimal OpenClaw bridge subset into isolated backend module.
- Remove unrelated agent/orchestration dependencies.
- Add strict request validation and error mapping.
- Add session lifecycle management:
  - QR pair bootstrap
  - session encryption at rest
  - reconnect/backoff

Deliverable:
- Bridge service runnable in staging with test number.

### Phase 4: Reliability + Security Hardening
- Add idempotency key (`requestId`) and dedupe.
- Queue outbound sends (`verification_outbox`) with retry policy.
- Add delivery states: `queued/sent/delivered/failed/expired`.
- Redact PII in logs; keep audit IDs only.
- Enforce per-phone and per-IP send limits.

Deliverable:
- Stable delivery pipeline with observability.

### Phase 5: Rollout
- Staging smoke tests with real WhatsApp accounts.
- Canary rollout: small percentage of verification traffic.
- Monitor failure rate and latency SLO.
- Expand gradually; keep kill switch active.

Deliverable:
- Production rollout checklist + rollback playbook.

## Data Model (Draft)
- `verification_outbox`
  - `id`, `request_id` (unique), `user_id`, `channel`, `recipient`, `template_id`
  - `status`, `provider_message_id`, `attempt_count`, `next_attempt_at`
  - `error_code`, `created_at`, `updated_at`
- `verification_delivery_events`
  - `id`, `outbox_id`, `event_type`, `event_payload_redacted`, `created_at`

## Security Controls
1. Never send plaintext secrets except OTP code and minimal template text.
2. Encrypt bridge session artifacts at rest.
3. Strict RBAC on bridge admin/bootstrap endpoints.
4. Disable verbose logs in production.
5. Add abuse controls:
  - resend cooldown
  - per-user/day caps
  - anomaly detection on failure spikes

## Operations
- Metrics:
  - send success rate
  - time-to-delivery p50/p95
  - retries per message
  - error class distribution
  - verification completion conversion
- Alerts:
  - failure rate > threshold for 10m
  - reconnect loop detected
  - queue lag > threshold

## Exit Criteria (Done)
1. OTP verification works end-to-end through extracted bridge in staging and prod canary.
2. No change in verification correctness or bypass behavior.
3. Failure handling and fallback paths are proven.
4. License/compliance requirements documented and satisfied.
