# Terminal (Bloomberg/tmux) Skin — Functional Parity Design

Date: 2026-07-05
Status: approved (design dialogue with Justus, 2026-07-05)
Branch: worktree-bloomberg-tmux-skin, based on predictions-declutter-tabs

## Goal

The terminal skin must offer the **same functionality** as the van skin, but
**not the same design**: every feature is built natively in the Bloomberg /
tmux visual language (dense monospace grids, bb-* Tailwind palette,
`[BRACKET]` chrome, amber/green/red data colors). No van page components and
no van CSS are reused. Only the skin-agnostic data layer is shared: stores
(`src/store/`), `services/api.js`, socket service, tokenService, MLS client.

## Current state (audit, 2026-07-05)

Terminal skin has: three panes (FEED / MARKET / CHAT), real LMSR trading with
Kelly sizing (`MarketDetail`), E2EE chat (`ChatPanel`), basic feed with
composer + likes (`FeedPanel`), notifications overlay, command palette
(Ctrl+K), help overlay, login/register modal, `[VAN]` escape hatch.

Missing vs van skin: comments, images, reposts in feed; feed pagination;
market search + pagination (loads all ~5–6k events; market list also mounted
twice — hidden mobile + desktop copies); RP balance; leaderboard; weekly
question; profile pages; network (followers/following); groups; search;
notifications page; analytics; settings; admin tools; forgot/reset/verify
auth flows.

## Navigation model

The three panes stay as the home surface. Everything else is a full-screen
terminal-native **view**, reachable three ways:

1. **Command palette** (Ctrl+K) — one entry per view.
2. **Hash routes** — shared route table with the van skin. Extract `ROUTES`,
   `normalizeHashPath`, `parseRoute` from `VanApp.jsx` into
   `src/services/routes.js`; VanApp imports it unchanged. In the terminal
   skin: `#home`, `#predictions`, `#messages` focus panes 1/2/3 and close any
   open view; every other known route opens the matching terminal view.
   Deep links (`#user/123`, `#group/slug`, `#verify-email?...`) work in both
   skins.
3. **Top-bar hotspots** — e.g. RP readout opens LEADERBOARD, `@username`
   opens PROFILE.

A view renders as a full-screen layer under the tmux top bar with a title row
(`[VIEW] SETTINGS — ESC to close`). ESC or navigating to a pane route closes
it. One view open at a time.

## New terminal-native views

Each view is a new component under
`frontend-solid/src/components/terminal/views/`, styled with the existing
bb-* Tailwind tokens, using the same API calls as its van counterpart:

- **PROFILE** (`#profile`, `#user/:id`) — accuracy/stats data grid,
  follow/unfollow, user's posts and predictions as dense rows.
- **LEADERBOARD** (`#leaderboard`, terminal-only route) — ranked table;
  opened from RP readout.
- **NOTIFICATIONS** (`#notifications`) — full list; existing overlay stays
  for quick glance.
- **SEARCH** (`#search`) — users/posts results as dense rows.
- **GROUPS / GROUP** (`#groups`, `#group/:slug`) — browse, create, join,
  group feed and members.
- **NETWORK** (`#network`) — followers/following tables with follow toggles.
- **ANALYTICS** (`#analytics`) — stat rows + terminal-styled charts (reuse
  chart data endpoints; render minimal, e.g. ASCII-leaning/sparkline or
  simple SVG in bb colors).
- **SETTINGS** (`#settings`) — account, skin preference (reuse
  updateUiPreferences), topics, feed-mix weights.
- **ADMIN** (palette-only, admin users) — event management + market
  resolution.
- **Auth screens** (`#forgot-password`, `#reset-password`, `#verify-email`,
  `#signup`) — terminal-styled; render when logged out instead of the login
  modal so emailed links work. LoginModal gains a FORGOT PASSWORD link.

## Pane upgrades (native)

- **Top bar**: live RP balance readout; refresh on login, after each trade
  fill, and on socket market updates.
- **MARKET pane**: switch `marketStore.loadMarkets` to
  `api.events.getPage({ search, limit, offset })` (available on the base
  branch); debounced search input in the panel header; LOAD MORE row;
  fix the double-mount so exactly one `MarketList` + one `MarketDetail`
  instance exists (signal-driven mobile list↔detail toggle, not duplicate
  DOM). Weekly question slot in the market pane (same API as
  WeeklyQuestionCard).
- **FEED pane**: cursor pagination via `api.posts.getFeedPage` + LOAD MORE;
  `PostItem` gains expandable comments (lazy-loaded, inline composer),
  image display, repost rendering.

## Error handling

Follow existing terminal patterns: inline `ERROR // <MESSAGE>` rows in bb
market-down styling; optimistic updates revert on API failure (as feedStore
likes do today); views show `RUNNING QUERY...` loading rows and
`NO DATA` empty states in bb-muted.

## Testing

Playwright e2e per phase in `tests/e2e/` following the `solidMessaging`
helper pattern (`?skin=terminal` forcing):

- parity smoke: palette opens each view; ESC closes; hash deep links work
- market search returns server-filtered rows; LOAD MORE appends
- feed LOAD MORE appends; comment expand + post round-trips
- RP balance visible and updates after a trade
- logged-out `#verify-email` / `#forgot-password` render terminal screens

## Delivery phases (each shippable)

1. Routes module + view shell + pane upgrades (market search/pagination,
   feed pagination, dedupe mounts) + RP balance + LEADERBOARD view.
2. PROFILE + NOTIFICATIONS + SEARCH views; feed comments/images/reposts.
3. SETTINGS + GROUPS/GROUP + NETWORK views.
4. ANALYTICS + ADMIN + auth screens; final parity smoke suite.

## Out of scope

- Reusing van page components or van CSS anywhere in the terminal skin.
- New backend endpoints (base branch APIs suffice).
- Mobile-specific view chrome beyond scrollable full-screen layout.
- Visual-regression baselines for the terminal skin (tracked separately in
  feature-roadmap).
