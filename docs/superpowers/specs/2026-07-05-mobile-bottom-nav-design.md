# Mobile Bottom Tab Bar + More Drawer — Design

Status: approved by Justus 2026-07-05 (pattern chosen via option question).
Context: mobile audit (2026-07-05) found the site has NO navigation at mobile
widths — the sidebar is moved off-screen (`left: -250px`) and the `.sidebar.open`
CSS plus reserved header/bottom-nav spacing survive from the removed VanJS
mobile UI, but no Solid component renders a toggle, header, or tab bar.

## Goal

A phone user can reach every route. Desktop rendering unchanged.

## What gets built

### 1. `frontend-solid/src/components/MobileTabBar.jsx`
- Fixed bottom bar, shown only ≤768px (CSS `display: none` above).
- Five items: Home (`#home`), Predictions (`#predictions`),
  Notifications (`#notifications`), Messages (`#messages`), More (button).
- Active tab derived from `window.location.hash` (same hash-routing signal the
  app already uses). Bauhaus styling: black bar, geometric glyphs, matches Van
  skin variables. `padding-bottom: env(safe-area-inset-bottom)`.
- Logged-out: same tabs; Notifications/Messages pages already show their own
  sign-in prompts.

### 2. More drawer (in `Layout.jsx`)
- More toggles `open` class on the existing `.sidebar` (CSS transition already
  present) plus a backdrop overlay (new, ~10 lines CSS).
- Drawer closes on: backdrop tap, any nav link tap, route change.
- Sidebar content unchanged — it is the long-tail nav (Search, Analytics,
  Network, Groups, Settings, Profile, Login/Logout).

### 3. Dead-space cleanup in `styles.css`
- Remove the 56px `padding-top` reserved for the phantom "fixed mobile header"
  (no top header in this design).
- Keep/align the ~60px bottom spacing with the real tab bar height.

### 4. Error banner overlap fix
- Audit showed error/notice banners render duplicated and overlapping
  (phone-verify notice, unauthorized banner). Root-cause (likely double-mounted
  notice component) and fix so a single banner renders in normal flow.

### 5. Playwright mobile smoke test
- 390×844: tab bar visible, tapping each tab routes correctly, More opens and
  closes the drawer, `document.documentElement.scrollWidth === innerWidth` on
  all five destinations.
- Note for test authors: `playwright-cli open` wipes storage; tests must
  navigate in-page for logged-in flows.

## Out of scope (follow-ups)
- JWT lifetime (1h, no refresh) — backend change, separate decision.
- Terminal skin mobile support — desktop-oriented by design.
- Bottom-bar notification badges — nice-to-have once notifications matter.

## Error handling
No new network surface. The drawer/tab bar is pure client state; the only
failure mode is CSS regression on desktop, covered by keeping all new rules
inside `@media (max-width: 768px)` and the tab bar `display: none` outside it.
