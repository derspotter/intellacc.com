# SolidJS Unification Plan: Two Skins, One Framework

## Summary

Target architecture:

1. One frontend framework: **SolidJS only**
2. Two skins inside that Solid app:
   - **Van-style skin** (default, preserves current UX/design)
   - **Terminal/Bloomberg skin** (existing Solid style)
3. Migration approach: port VanJS behavior/design into Solid, then unify both skins in one Solid codebase.

Locked decisions:

- Skin system: **theme tokens**
- Default skin: **Van-style**
- Switch UX: **Settings toggle + optional `?skin=` query**
- Parity verification: **Playwright visual + behavioral checks using the `playwright-cli` skill**

## Final End State

- `frontend/` is SolidJS and contains both skins.
- `frontend-solid/` is retired after consolidation.
- No VanJS runtime remains in mainline.
- Skin choice is persisted and can be overridden for QA via query param.

## Core Architecture

### Skin model

- Single component tree and route structure.
- Skin-specific styling via CSS variables/design tokens.
- Token bundles:
  - `skin-van.css`
  - `skin-terminal.css`
- Runtime skin provider applies token class/attribute on root element.

### State and services

- Reuse shared service layer:
  - auth/api/socket/MLS/vault/device/passkey services
- Solid stores wrap shared services.
- No duplicated state logic per skin.

### Routing and switching

- One route map for all users.
- Skin selected by:
  1. query override `?skin=van|terminal`
  2. saved user preference (authenticated)
  3. localStorage (anonymous)
  4. default = `van`
- Settings page includes skin selector.

## API / Data Changes

### Backend additions

1. `GET /api/users/me/preferences` -> `{ skin: 'van' | 'terminal' | null }`
2. `PUT /api/users/me/preferences` with `{ skin }` enum validation

### DB migration

- Add nullable `users.ui_skin_preference` with allowed values `van|terminal`.

### Frontend contract

- local key: `intellacc.ui.skin`
- query override: `skin`

## Merge and Port Sequence

### Phase 1: Consolidation branch setup

1. Branch from `master`: `feat/solid-unified-skins`
2. Import `frontend-solid` as migration base.
3. Keep VanJS code untouched initially for reference.

### Phase 2: Skin infrastructure first

1. Add `SkinProvider` and token files.
2. Add settings toggle + query override resolver.
3. Wire persistence (API + localStorage fallback).

### Phase 3: VanJS design parity port into Solid

Port route-by-route:

1. Layout shell
2. Feed/posts
3. Markets/predictions
4. Messaging/MLS/vault/passkey
5. Profile/network
6. Settings/verification/admin

Per route:

- Shared logic once.
- Van-style tokens + parity CSS until visual match.
- Ensure terminal skin remains functional.

Current in-scope milestone:
- Scaffolded a dedicated Solid migration app at `frontend-solid/` with:
  - Vite + SolidJS runtime,
  - a route shell,
  - a first-pass `home` feed page (posts load baseline),
  - persistent + query-based skin selection (`?skin=van|terminal`) and body token class wiring.
- This is a migration seed only; behavior parity and full component parity are still to be ported route-by-route from VanJS.

Current status in this branch:
- Backend and API work for skin preference is complete.
- Skin provider now supports both hash-query and standard query-string overrides (`?skin=`) with `popstate/hashchange` reactivity in `frontend/src/services/skinProvider.js`.
- No Solid runtime scaffold exists yet; migration slice remains at "framework swap planning" stage.

### Phase 4: Existing Solid skin reconciliation

1. Map current `frontend-solid` styling into terminal token set.
2. Remove hardcoded skin-specific drift from shared components.
3. Keep only token-driven differences.

### Phase 5: Cutover and cleanup

1. Make unified Solid app the only frontend in compose/build.
2. Remove VanJS app code from mainline.
3. Tag fallback refs:
   - `fallback/vanjs-final`
   - `fallback/solid-pre-unified` (optional)

## Test Plan

### Required automated tests

1. Backend preference endpoint tests.
2. Solid unit/integration tests for skin resolver + persistence.
3. E2E matrix for both skins on critical flows:
   - auth
   - posts/feed
   - markets/trading
   - messaging/MLS
   - profile/settings/passkey/device-link

### Playwright parity verification (mandatory)

Use the `playwright-cli` skill to run parity checks on every migration slice:

1. Capture reference screenshots for:
   - VanJS baseline (pre-port)
   - Solid `skin=van`
   - Solid `skin=terminal`
2. Compare VanJS baseline vs Solid `skin=van` with strict threshold.
3. Run scripted interaction parity checks for both skins.
4. Attach screenshots/diffs/traces to PR.
5. Block merge if:
   - visual diff exceeds threshold on Van-style parity routes, or
   - behavioral assertions fail in either skin.

## Completion Criteria

- Both skins pass behavioral E2E matrix.
- Van-style passes Playwright visual parity signoff vs VanJS baseline.
- Terminal skin has no P1 regressions.
- VanJS runtime removed from mainline.

## Current Sprint Log

- `2026-02-18`: Continued from stable backend-focused state on `feat/solid-unified-skins`.
  - Added production-safe migration checkpoint and updated plan status.
  - Skin resolver now accepts `?skin=van|terminal` from either `location.search` or hash query while preserving existing behavior.
  - Next slice: create a dedicated `frontend-solid` migration scaffold and complete first route-by-route parity slice (`home/feed`) under Playwright parity checks.
- `2026-02-18`: Messages/Notifications parity slice completed in Solid migration with verified actions in dev compose.
  - Added dev-only device-id plumbing in `frontend-solid/src/services/api.js` (`deviceIdStore`, registration + `x-device-id` header usage) and full message send/consume flow in `frontend-solid/src/pages/MessagesPage.jsx`.
  - Extended `frontend-solid/src/pages/NotificationsPage.jsx` and existing routing to validate authenticated notifications list/actions in parity app.
  - Ran Playwright CLI checks on local solid stack (`docker-compose.solid-local.yml`) in auth state:
    - Notifications: list renders, mark as read, and delete flows execute.
    - Messages: open direct message thread, refresh, and send message flow executes.
  - Validation artifacts:
    - `parity-shots/solid-notifications-final.png`
    - `parity-shots/solid-messages-final.png`
    - `parity-shots/solid-messages-after-send.png`
  - Runtime validation:
    - `frontend-solid` build passes.
    - Backend `test/messaging_push_integration.test.js` passes in dev container.
  - Next items: continue with remaining parity route slices and decide when to harden message text rendering (buffer payload decode already handled).
- `2026-02-18`: Continued parity and API hardening.
  - Fixed API base normalization in `frontend-solid/src/services/api.js` to avoid absolute URL parse failures when `/api`-style base values are present in runtime config.
  - Added Playwright CLI validation on `frontend-solid` (local dev compose) for:
    - messages flow (`#messages`, open thread, refresh, send)
    - notifications list page state (`#notifications`)
  - Captured updated parity artifacts:
    - `parity-shots/solid-messages-flow.png`
    - `.playwright-cli/page-2026-02-18T20-59-10-070Z.yml`
    - `.playwright-cli/page-2026-02-18T20-59-21-311Z.yml`
    - `.playwright-cli/page-2026-02-18T20-59-30-544Z.yml`
    - `.playwright-cli/page-2026-02-18T20-59-47-808Z.yml`
- `2026-02-18`: Started first Solid scaffold migration slice.
  - Added `frontend-solid/` app with Vite + Solid runtime, route shell, and home/feed baseline.
  - Added local skin token system and baseline CSS tokens for `van` and `terminal` within the scaffold.
  - Ran build validation: `npm run build` passes with generated `dist` artifacts.
- `2026-02-18`: Completed first parity slice in `frontend-solid`.
  - Implemented migration slice for home feed: create-post form, posts list component, paginated fetch (`/posts` or `/feed`), and route-level authentication-aware behavior.
  - Added image attachment upload + inline preview support in create-post flow.
  - Extended solid API client with feed/public post pagination and attachment helpers.
- `2026-02-18`: Extended `frontend-solid` feed slice with post interactions.
  - Added like toggling + comment loading/submission flow in each feed row.
  - Added optimistic post-like updates with rollback on API errors.
  - Added comments list rendering and comment count sync through home feed state.
- `2026-02-18`: Extended `frontend-solid` post-management parity.
  - Added token-based edit/delete controls with owner/admin gates.
  - Added `PATCH /posts/:id` post-update flow (content + optional image replacement/removal).
  - Added `DELETE /posts/:id` removal flow and parent list cleanup callback.
  - Added auth helper for post ownership checks and expanded migration sprint notes.
- `2026-02-18`: Added core auth parity slice to Solid migration.
  - Added login/signup route scaffolding with hash navigation (`#login`, `#signup`).
  - Added `auth` service primitives (`saveToken`, `clearToken`, `login`, `register`, `logout`).
  - Added `frontend-solid` API login/register wrappers and `token` persistence integration.
  - Added nav actions for Login/Sign Up/Sign Out and auth-aware route rendering.
  - Added styles and form states for auth flows in `styles.css`.
  - Added dev-server proxy support for `/api` in `vite.config.js` (defaults to `http://127.0.0.1:3000`) for direct local auth/form testing.
  - Next validation step: run browser parity smoke flow with `playwright-cli` against route and post-auth feed.
- `2026-02-18`: Extended auth parity in `frontend-solid`.
  - Added `#forgot-password` and `#reset-password` routes with API wiring for `/auth/forgot-password` and `/auth/reset-password`.
  - Implemented password reset warning/acknowledgment flow, token parsing from hash, and pending/completion state handling.
  - Added reset status messaging styles and restored forgot-password navigation from login.
  - Added verification checklist update to run the new slice with `playwright-cli`.
- `2026-02-18`: Continued VanJS visual parity pass on solid-auth slice.
  - Reworked `frontend-solid` layout routing to mount auth pages without layout shell and updated Van-style shell wrappers.
  - Added/updated auth/forgot/reset/login/signup route markup to match VanJS class conventions.
  - Added a focused `frontend-solid` auth/feed style block set (`login-page`, `signup-page`, `create-post-card`, `.sidebar`, `.main-content`, `post-*` form/action classes).
  - Captured Playwright verification screenshots for auth/home routes in both stacks:
    - Solid: `/tmp/solid-home.png`, `/tmp/solid-login.png`, `/tmp/solid-signup.png`, `/tmp/solid-forgot-password.png`, `/tmp/solid-reset-password.png`
    - VanJS: `/tmp/van-home.png`, `/tmp/van-login.png`, `/tmp/van-signup.png`, `/tmp/van-forgot-password.png`, `/tmp/van-reset-password.png`
  - Next parity item: align `PostItem` markup/actions to fully match van `post-card` behavior and refresh diff pass.

- `2026-02-18`: Completed `PostItem` structural parity slice.
  - Refactored `frontend-solid/src/components/posts/PostItem.jsx` to Van-style `post-card` structure:
    - `post-header` with author/date/like/comment metadata and optional AI badge.
    - Separate edit mode content, image area, and action columns (`post-actions-left`, `post-actions-center`, `post-actions-right`).
    - Split comment interactions into toggled comment list/form containers (`comment-form-container`, `comments-list-container`).
  - Added parity class coverage in `frontend-solid/src/styles.css` for post metadata, edit states, and comments:
    - `post-header-sub`, `post-header-expand-wrap`, `post-content-area`, `edit-textarea`, `post-image-area`, `comments-section`.
  - Captured refreshed parity screenshots:
    - Solid (latest): `parity-shots/solid-home-latest.png`, `parity-shots/solid-login-latest.png`, `parity-shots/solid-signup-latest.png`, `parity-shots/solid-forgot-password-latest.png`, `parity-shots/solid-reset-password-latest.png`
    - VanJS: `parity-shots/van-home-latest.png`, `parity-shots/van-login-latest.png`, `parity-shots/van-signup-latest.png`, `parity-shots/van-forgot-password-latest.png`, `parity-shots/van-reset-password-latest.png`
- `2026-02-18`: Deeper `PostItem` parity pass for nested comments and behavioral edge cases.
  - Implemented nested comment rendering using recursive `PostItem` usage, so child replies inherit the same action surface (like, edit, delete, reply form).
  - Added expand/collapse-all controls per post card and comment-tree hydration behavior.
  - Added content-preview parity controls (clamp/overlay + show more/less) and safer edit-image states (`remove` + `undo`, existing attachment previews).
  - Added fallback behavior when `user_id` is missing on author links.
  - Added supporting style hooks (`.comments-list > li`, `.attachment-removed`) for nested rendering and edit-state visibility.
  - Captured latest feed screenshots:
    - Solid: `parity-shots/solid-home-latest-postitem.png`, `parity-shots/van-home-latest-postitem.png`
  - Fixed edge cases for deep-comment mutation and expand propagation:
    - comment updates/deletes now recurse into full reply trees.
    - collapse/expand-all state is now synchronized for nested children without losing local comment state.
    - Added verification captures:
      - `parity-shots/verification/van-landing.png`, `parity-shots/verification/solid-landing.png`
  - Applied final nested interaction parity refinements:
    - `PostItem` expand/collapse behavior no longer force-hides active comment forms.
    - comment submission now closes the form and updates counts without force-opening the comment list.
    - `Comment` button keeps a stable label for consistency with VanJS interaction patterns.
- `2026-02-18`: Started `predictions` route migration slice in `frontend-solid`.
  - Added `frontend-solid/src/pages/PredictionsPage.jsx` and integrated it into route handling.
  - Added event fetch/search + local prediction submission flow:
    - `/events` list with search.
    - `/predict` with yes/no + confidence input.
    - `/predictions` history from the authenticated user feed.
  - Added admin market creation form posting to `/events`.
  - Added `/scoring/leaderboard` readout with `/leaderboard/global` fallback.
  - Expanded `frontend-solid/src/services/api.js` with prediction and leaderboard endpoint helpers.
  - Added styles for `predictions-*` layout/cards/forms and mobile stacking in `styles.css`.
  - Playwright verification:
    - `playwright-cli` smoke run on `http://127.0.0.1:4174/#predictions`
    - screenshot: `/tmp/solid-predictions-full.png`
  - Next target for this route:
    - parity pass for admin/admin-only controls, status/resolution UX, and prediction history actions.

- `2026-02-18`: Extended route-level parity for core user areas.
  - Added routing support in `frontend-solid/src/App.jsx` for:
    - `#profile`
    - `#user/:id`
    - `#messages`
    - `#notifications`
    - `#settings`
  - Added pages:
    - `frontend-solid/src/pages/ProfilePage.jsx`
    - `frontend-solid/src/pages/MessagesPage.jsx`
    - `frontend-solid/src/pages/NotificationsPage.jsx`
    - `frontend-solid/src/pages/SettingsPage.jsx`
  - Added missing API client methods for:
    - users: profile lookup/edit, follow/following-status, followers/following, reputation
    - notifications: list/read/mark-all-read/delete
    - preferences: get/update UI skin
    - mls: direct/group messages
  - Added route/navigation styling support in `frontend-solid/src/components/Layout.jsx` and `frontend-solid/src/styles.css`.
  - Current status:
    - Route shell and page-level behavior are in place.
    - Next item: end-to-end parity checks for messaging and notifications behaviors (including send/consume and mark actions) plus visual delta validation with playwright.
- `2026-02-18`: Completed local dev-stack verification for the expanded route slice.
  - Added `docker-compose.solid-local.yml` for source-mounted `frontend-solid` runs on port `4174` against `intellacc_backend_dev` (network `intellacc-local-dev`).
  - Ran Playwright CLI sanity passes on new core routes (`home`, `login`, `profile`, `messages`, `notifications`, `settings`) for both `van` and `terminal` skin modes.
  - Captured verification artifacts under `parity-shots/verification/`:
    - `solid-*-yaml` for snapshots
    - `solid-*.png` for baseline screenshots
  - Current status:
    - Route shell and auth gating states are validated (including not-logged-in behavior).
    - Remaining item: authenticated-end messaging/notification action parity still needs end-to-end validation once a valid seed user token is available in the solid-local stack.

## Assumptions

- Van-style remains default for continuity.
- Skin differences are visual; behavior is shared and identical.
- New features are implemented once in shared Solid logic and skinned via tokens.
