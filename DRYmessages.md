# DRY Messaging Plan (Frontend)

This plan makes the messaging codebase more DRY, reactive, and stable without re‑introducing the selection/aliasing bug. It consolidates identity and normalization into the store, renders from plain reactive projections, and minimizes updates on socket events.

## Goals
- Single source of truth in the store (normalize, dedupe, identity, labels).
- Render from plain, reactive projections (no Proxy aliasing).
- Minimal, predictable updates on socket events and selection.
- Remove duplicated logic across page, store, and service.
- Keep list stable on selection; update on socket events without refetching.

## Consolidate Identity & Normalization
- Store‑only normalization:
  - Add `normalizeConversation(c, currentUserId)` in `frontend/src/utils/messagingUtils.js`.
  - Store applies normalization/dedupe (not the service; not the page).
- Service stops computing `pairKey`/`id` and just passes raw API data to the store.
- Replace `setConversations` + `addConversation` with store APIs:
  - `upsertConversations(rawList)` → normalize, dedupe by `id|pairKey`, compute `displayName`, `lastTime`, update `byId + ids`.
  - `upsertConversation(raw)` for single insert/update.
- Remove all on‑render name recomputations; render `displayName` only.

## Single Reactive Projection
- Add/standardize `sidebarItems` as a `vanX.calc` that maps `conversationIds + conversationsById` to plain items `{ id, name, time, unread }`.
- Apply search filtering and sorting by `time` desc inside the computed (not in the page).
- Page renders only `sidebarItems` (keys by `id`, labels from `displayName`).

## DRY Loading & Selection
- Keep only two loading flags in the store:
  - `conversationsLoading` for initial/refresh loads of conversations.
  - `messagesLoading` for per‑conversation message fetch.
- Page:
  - Init toggles `conversationsLoading` only.
  - Selection toggles `messagesLoading` only; does not touch conversation loading.
- Add `selectedConversationName` (computed) returning `displayName` for header.

## Socket Handling (Unify + Minimal Updates)
- In the service, create `applyMessageEvent(conversationId, { createdAt, selected })`:
  - If `selected`: refresh messages with `getMessages` → store.setMessages.
  - Else: `store.incrementUnread(conversationId, 1)` and `store.updateConversation(conversationId, { last_message_created_at: createdAt || now })`.
- Both `newMessage` and `messageSent` call this helper (DRY). For `messageSent` on unselected, skip unread bump but update last time.
- Optional backend tweak: include `created_at` in socket payload so UI uses server time.

## Auth & Utilities (DRY)
- Replace manual token parsing with shared `getTokenData()` from the auth service.
- Remove duplicate `getUserId()` variants; either import from one utility or inject current userId once into the store for normalization.

## Remove Debug Noise
- Strip console logs from service/store/page once behavior is verified.
- Keep a dev‑only global export `window.messagingStore` for manual inspection in dev tools.

## Performance Tweaks
- Compute filtering/sorting in `sidebarItems` (not in render) to avoid repeated work.
- Batch store updates where possible (atomic assign of `byId + ids`) to reduce recalcs.
- Use `requestAnimationFrame` for `scrollToBottom` to align with painting.
- Consider virtualizing the messages list for very long threads.

## Optional Backend Improvements
- Socket `newMessage` emits `created_at`; client uses it for `lastTime` instead of `now`.
- Add a “since”/delta conversations endpoint if you plan frequent refresh (not needed with sockets, but helpful for resilience).

## Refactor Outline (Incremental)
1. Add `normalizeConversation` helper in `messagingUtils`.
2. Store: implement `upsertConversations`/`upsertConversation` (normalize, dedupe by `id|pairKey`, compute `displayName`, `lastTime`, update `byId + ids`).
3. Service: stop computing `pairKey`; call `store.upsertConversations` with raw API data. Add `applyMessageEvent` and use it in both socket handlers.
4. Store: add `selectedConversationName` computed; page header uses it.
5. Page: render sidebar from `sidebarItems` only; remove any fallback recompute logic and snapshots.
6. Remove debug logging; keep `window.messagingStore` in dev only.
7. Polish: rAF for scroll, consider virtualization if needed.

## Success Criteria
- Sidebar never aliases/renames rows on selection.
- New messages update unread/time and reorder as needed without refetching.
- Minimal duplicated logic across layers; identity/labels live only in the store.
- Rendering is driven by plain, reactive projections.

## Risks & Mitigations
- Risk: reactive cycles causing redundant recomputes.
  - Mitigation: batch store updates; keep projections pure and deterministic.
- Risk: backend data inconsistencies (e.g., duplicate rows).
  - Mitigation: dedupe strictly by `id|pairKey` at ingestion.
- Risk: socket payloads missing timestamps.
  - Mitigation: fallback to `now`, but prefer backend‐provided `created_at`.

## Even Drier And Faster (Next Iteration)

These optimizations keep the same architecture and semantics, but reduce work and improve clarity.

1) Store Micro‑Optimizations
- Cache `currentUserId` in the store once (e.g., `store.currentUserId`) set at init; pass it to all normalization instead of decoding JWT repeatedly.
- Normalize numeric time up front: add `lastTs` (epoch ms) alongside `lastTime` to avoid repeated `new Date(...)` parsing during sorts; sort by `lastTs` directly.
- Collapse token parsing helpers: import a single `getTokenData()` (auth service) everywhere; remove ad‑hoc JWT parsing.
- Make `upsertConversations` idempotent: skip writes if no fields actually changed (shallow compare) to avoid redundant reactive recomputes.
- Keep pairKey as a safety net only; if backend guarantees `conversation_id` uniqueness, plan to remove pairKey from hot paths (dedupe by id only) to reduce key space.

2) Rendering Micro‑Optimizations
- Sidebar projection memoization: keep `sidebarItems` pure but rely on `conversationIds`, `conversationsById`, and `searchQuery` only; avoid deriving from the heavier `conversations` array.
- No sorting in render: sorting remains inside `sidebarItems` (already done). With `lastTs` in place, sorting is faster and GC‑friendly.
- Messages list: use `requestAnimationFrame` for `scrollToBottom` to align with paint frames.
- Consider message virtualization for very long threads (windowing) when message counts scale.

3) Messages Fetch DRYness
- Selection should not refetch if messages are already in `messagesByConversation[convId]` and are fresh.
- Add `messagesMeta[convId] = { lastFetchedTs }` in the store; on selection, fetch only if empty or stale (e.g., older than 30s) or when a socket indicates new content for the selected conversation.
- For older history/pagination, keep `hasMore` and `oldestTs` per conversation in `messagesMeta` to avoid re‑asking for ranges you already loaded.

4) Socket Handling DRYness
- Keep `applyMessageEvent` as the single path for updating unread/time and refreshing selected conversation.
- Prefer server `created_at` over `now` in events; if missing, fall back to `Date.now()`.
- De‑dupe socket events by tracking a `lastSeenEventAt` per conversation in store to avoid redundant updates on reconnect bursts.

5) Cleanup & Dev UX
- Remove most console logs; guard any keepers with `if (import.meta?.env?.DEV)`.
- Retain a single dev‑only global: `window.messagingStore` for live inspection.
- Add light JSDoc to `normalizeConversation` and store methods (`upsert*`, `updateConversation`) to document field semantics (`displayName`, `lastTime`, `lastTs`, `my_unread_count`).

6) Optional Backend Nits
- Add `created_at` to socket payloads (`newMessage`, `messageSent`).
- (If needed) add a delta endpoint (`/messages/conversations?since=...`) for resiliency after offline periods.

## Implementation Checklist (Follow‑up)
- [ ] Add `store.currentUserId`; remove ad‑hoc JWT decodes.
- [ ] Extend normalization to set `lastTs` and swap sorter to use it.
- [ ] Add `messagesMeta` with `lastFetchedTs` and `hasMore`; gate selection fetch on staleness.
- [ ] Switch `scrollToBottom` to `requestAnimationFrame`.
- [ ] Remove console logs; gate any dev logs.
- [ ] (Optional) remove `pairKey` from hot paths if backend guarantees unique ids.
