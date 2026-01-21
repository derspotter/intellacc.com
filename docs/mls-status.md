# MLS Status

Updated: 2026-01-22

## Scope
This doc tracks MLS E2EE implementation status across the WASM bindings, frontend client, and backend relay. It replaces the old `mls-diagnosis.md` report and is the current source of truth.

## Summary
- Core MLS flows are implemented (two-phase joins, commits/proposals, key rotation, membership changes, PSK/external commit support).
- Security UX is present (safety numbers, TOFU fingerprint storage, verification badges, warning banners).
- Several protocol APIs and UX affordances are still missing (proposal creation wrappers, commit builder wrapper, periodic key rotation UI, richer messaging UX).

## Implemented (MLS Protocol + Transport)
- Two-phase welcome flow (`stage_welcome` → `validate` → `accept`/`reject`) with credential checks and pending-invite handling.
- Commit/proposal processing and merge flow with rollback on failure.
- Key rotation (`self_update`), remove member, leave group wrappers in JS and WASM.
- AAD binding on encrypt/decrypt for application/commit/proposal messages.
- Fork detection via confirmation tag exchange and callbacks.
- External commits and GroupInfo export/inspect flow.
- External PSK creation + proposal commit support.
- External sender support wired through group context extensions.
- Key package lifetime enforcement and rotation logic; last-resort packages per device.
- Message padding configured for join/create configs.
- Relay hardening: membership checks, commit epoch uniqueness, relay queue metadata.
- MLS state persistence via encrypted vault (legacy `openmls_storage` no longer written).

## Implemented (Security UX)
- Safety numbers modal with fingerprint display, copy, hex/numeric formats.
- TOFU fingerprint storage in vault + fingerprint change warnings.
- Contact verification state stored and surfaced (badges + verification modal).
- Pending invite list with accept/reject flow.

## Partially Implemented
- CommitBuilder: used internally in WASM (reboot/external commit), but no general JS wrapper for app-driven multi-proposal commits.
- LeafNode lifetime validation: KeyPackage lifetimes are enforced, but staged-welcome inspection cannot validate existing members' LeafNode ranges.
- Typing indicators: socket/store plumbing exists, but no message-view UI.

## Missing Protocol APIs
- `add_members_without_update()` wrapper.
- `propose_add_member()` wrapper.
- `propose_remove_member()` wrapper.
- `propose_self_update()` wrapper.
- `self_update_with_new_signer()` wrapper.
- External/custom proposal builders (client-side creation).
- Required capabilities / extension negotiation API surface.

## Missing UX / App Features
- Periodic key rotation and manual "Refresh Keys" UI.
- Member fingerprint inspection UI before accepting a staged welcome.
- Persistent message dedup across restarts (current dedup is in-memory only).
- Group admin controls.
- Message reactions, editing/deletion, read receipts, disappearing messages.

## Known Tech Debt
- DM membership rules allow a re-add after leave; clarify policy before tightening validation.
- External sender inputs are not validated for length/format (hardening item).

## Next Milestones
1. Expose proposal wrappers + CommitBuilder in JS for policy-controlled commits.
2. Add periodic key rotation + manual key refresh UI.
3. Add staged-welcome inspection UI (fingerprints before accept).
4. Persist processed message IDs in vault to avoid duplicate processing after restarts.

## Deprecation Note
- This file replaces `mls-diagnosis.md`. If you need the historical report, check git history.
