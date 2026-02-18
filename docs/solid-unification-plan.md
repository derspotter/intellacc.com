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

## Assumptions

- Van-style remains default for continuity.
- Skin differences are visual; behavior is shared and identical.
- New features are implemented once in shared Solid logic and skinned via tokens.
