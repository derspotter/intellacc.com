# Keyboard Navigation & A11y Sweep — Design

**Date:** 2026-07-07
**Status:** Design approved in conversation; spec pending user review
**Scope:** Van skin (default) + shared helpers; terminal skin keeps its existing
hotkeys (1/2/3 panes, ?, Escape, focus-trapped overlays) and can adopt the
shared helpers later.

## Goals

1. Every interactive element in the van skin is keyboard-operable (Tab
   reachable, Enter/Space activates, visible focus).
2. Gmail-style single-key shortcuts (`g` sequences, `/`, `?`, `j`/`k`).
3. Arrow-key movement between sidebar and main content.
4. Van modals behave like dialogs (Escape, focus trap, ARIA).

## Baseline (from code inventory, 2026-07-07)

- Already correct: van sidebar links + mobile tab bar (real `<a>`),
  PredictionsPage tablist buttons, OutcomeMarketCard radiogroup,
  FeedMixPanel slider, terminal-skin hotkey/focus-trap infra
  (`TerminalApp.jsx:148-235`).
- Gaps: ~15 files with click-only div/span/li (rows: `MarketList.jsx:19-31`,
  `EventsList.jsx:489`, `MyPositions.jsx:216`, `MessagesPage.jsx:928-931`;
  cards/actions: `GroupCard.jsx:25`, `MarketTicker.jsx:40`,
  `PostItem.jsx:602-609,815-822`, `ChatPanel.jsx` x4, Layout drawer
  backdrop). Two elements have `role="button"` but no key handler
  (PostItem spans, MessagesPage li). Van modals (`LoginModal.jsx:142`,
  `DeviceLinkModal.jsx:170`) lack Escape/trap/dialog semantics. Only 3
  ad-hoc `:focus-visible` rules exist.
- Terminal-skin views (NotificationsView etc.) are OUT of scope.

## Part 1 — Shared foundation

### `frontend-solid/src/utils/keyboard.js` (new)

- `activateOnKey(handler)` → returns an `onKeyDown` that calls `handler`
  on Enter and Space (preventDefault on Space to stop page scroll).
- `createFocusTrap(containerRef)` → Tab/Shift-Tab cycle within container;
  returns dispose. Extracted from the working TerminalApp pattern; both
  skins can use it (TerminalApp migration NOT part of this work).
- `createShortcuts(map)` → installs one `window` keydown listener.
  - Ignores events when: `event.target` is input/textarea/select or
    `isContentEditable`; any of ctrl/meta/alt is held; an overlay marked
    `data-shortcuts-ignore` contains the target.
  - Supports single keys (`/`, `?`, `j`, `k`, `Escape`) and two-key
    sequences (`g` + letter) with a 1.5 s pending-prefix timeout.
  - Returns dispose. Mounted once in the van `App`/`Layout` root, only for
    the van skin.

### Focus visibility (`styles.css`)

Global token near the root rules:

```css
:focus-visible {
  outline: 2px solid #0000ff;
  outline-offset: 1px;
}
body.dark-mode :focus-visible {
  outline-color: rgba(255, 255, 255, 0.85);
}
```

Existing ad-hoc rules stay; inputs keep their current styling (the
`:focus-visible` outline applies to keyboard focus only, so mouse users
see no change).

## Part 2 — A11y sweep (van skin)

Convert per pattern:

- **Activating elements → real `<button>`** where markup allows (GroupCard
  action, MarketTicker item, PostItem comment-count toggle and
  expand/collapse-all spans, ChatPanel actions), with a
  `.button-reset` utility class (no border/background/font inheritance)
  so visuals do not change.
- **Rows (select/expand) → `role="button"` + `tabindex="0"` +
  `activateOnKey`** on the existing div/li: EventsList row, MyPositions
  row, MarketList row, MessagesPage conversation li. Rows are list items
  visually — full listbox semantics is more than needed; button-row
  semantics matches what clicking does (expand/open).
- **Dismiss-only backdrops** (Layout drawer backdrop): `aria-hidden="true"`
  and stay mouse-only — Escape (below) covers keyboard dismissal.
- **Van modals** (LoginModal, DeviceLinkModal): `role="dialog"`,
  `aria-modal="true"`, `aria-label`, Escape closes, `createFocusTrap`
  active while open, focus moves to first field on open and returns to the
  invoker on close.

## Part 3 — Shortcuts (van skin, single-key)

| Keys | Action |
|---|---|
| `g h` | #home |
| `g p` | #predictions |
| `g m` | #messages |
| `g n` | #notifications |
| `g a` | #analytics |
| `g g` | #groups |
| `g s` | #settings |
| `g u` | own profile |
| `/` | #search + focus the search input |
| `?` | help overlay (lists all shortcuts; Escape closes; focus-trapped) |
| `j` / `k` | move row highlight down/up in the current view's primary list |
| `Enter` | open/expand the highlighted row |
| `Escape` | close overlay/modal; else collapse the focused/expanded row |

- `j`/`k` operate on a per-view "primary list" registration: feed posts
  (HomePage), market rows (EventsList), position rows (MyPositions),
  notifications, conversations (MessagesPage). A view registers its list
  container + row selector with the shortcut layer (small
  `registerPrimaryList` API in keyboard.js); `j`/`k` move DOM focus to the
  next/previous row (roving `tabindex`), which doubles as the highlight
  via `:focus-visible`.
- Admin-gated or auth-gated targets: `g` targets that require auth
  navigate to login when logged out (existing route behavior; no special
  handling).
- Help overlay is a small van-skin component (`ShortcutHelp.jsx`)
  rendered from the same shortcut map (single source of truth).

## Part 4 — Arrow-key pane switching

- `←` (outside text fields): move focus to the current sidebar nav item
  (`.sidebar` first link, or the one matching the active route).
- Within the sidebar: `↑`/`↓` move between nav items (roving tabindex),
  `Enter` activates (native link behavior), `→` returns focus to the
  primary list's current row (or first row).
- `↑`/`↓` are NOT intercepted globally — page scrolling outside the
  sidebar is untouched. Only `←`/`→` are global (and only when not
  typing and no modifier).
- On mobile widths the sidebar is a drawer/tab bar: `←`/`→` do nothing
  below the 1024px breakpoint.

## Error handling / edge cases

- Shortcut listener disposed on skin switch to terminal (terminal manages
  its own keys); no double-handling.
- `?` and `/` on keyboards where they require Shift: match on
  `event.key`, not keycode, so layouts (e.g. German) work.
- Sequences never fire actions while a modal/overlay is open except
  Escape (registry checks an `overlayOpen` signal exposed by the help
  overlay + modals).
- j/k on a view with no registered list: no-op.

## Testing

E2E `tests/e2e/keyboard-navigation.spec.js` (keyboard-only driving):
1. Tab to a market row → Enter expands → Escape collapses (focus stays on
   the row).
2. `g p` navigates to predictions; `g h` back home.
3. `/` lands on search with the input focused (typed text appears in it).
4. `j`/`k` in the feed move focus across post cards.
5. Typing `g p` inside the post composer does NOT navigate.
6. Login modal: opens with focus in first field, Tab cycles inside,
   Escape closes and restores focus.
7. `←` focuses sidebar, `↓` next item, `Enter` navigates, `→` returns to
   the list.
8. `?` opens help; Escape closes.

Existing predictions/messaging specs must stay green (rows keep their CSS
classes; only attributes and wrappers change).

## Out of scope

- Terminal skin changes (keeps its own bindings; helpers are available).
- User-configurable keybindings.
- Command palette (Ctrl+K) — rejected in design conversation.
- Screen-reader-specific work beyond the roles/labels named above.
