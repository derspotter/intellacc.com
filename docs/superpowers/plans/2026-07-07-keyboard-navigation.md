# Keyboard Navigation & A11y Sweep Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the van skin fully keyboard-operable and add Gmail-style shortcuts (`g` sequences, `/`, `?`, `j`/`k`) plus arrow-key movement between sidebar and main content.

**Architecture:** One shared module `frontend-solid/src/utils/keyboard.js` holds all key handling: an Enter/Space activation helper, a focus trap, an overlay stack, and a single global shortcut registry mounted by the van layout (auto-disposed when the skin switches, because `Layout.jsx` unmounts `VanLayout`). Views opt into `j`/`k` via `data-` attributes — no per-view JS. The a11y sweep converts click-only elements to buttons or button-semantics rows without visual change.

**Tech Stack:** SolidJS, plain CSS (styles.css), Playwright E2E.

**Spec:** `docs/superpowers/specs/2026-07-07-keyboard-navigation-design.md` — binding for scope (van skin only; terminal skin untouched) and the shortcut table.

## Global Constraints

- Van skin only. Do not modify `TerminalApp.jsx` or `components/terminal/*`.
- Shortcuts must never fire while typing: target is `input`/`textarea`/`select` or `isContentEditable`, or any of ctrl/meta/alt held → ignore (Escape is exempt from the modal guard only, not from the typing guard — Escape while typing in a modal still closes the modal? NO: Escape always works for the overlay stack, even from inside an input, because closing a dialog from a field is standard; all OTHER keys are suppressed while typing).
- Match on `event.key` (layout-independent for `?`, `/`).
- Two-key sequence timeout: 1500 ms.
- Visual appearance must not change for mouse users: `:focus-visible` only, `.button-reset` strips button chrome.
- Existing CSS classes on converted elements stay (E2E selectors elsewhere depend on them).
- E2E from repo root: `./tests/e2e/reset-test-users.sh` then `npx playwright test tests/e2e/<spec>`; base http://localhost:4174 (source-mounted dev container — serves the working tree, no deploy needed for E2E).
- Prod deploy (final task only): `docker restart intellacc_frontend_solid`; verify via https://intellacc.de bundle contents, never via localhost:4174.
- Existing specs must stay green: `my-positions-section.spec.js`, `predictions-tabs.spec.js`, `messaging-v2-smoke.spec.js`.

---

### Task 1: keyboard.js foundation + navigation shortcuts + help overlay + focus ring

**Files:**
- Create: `frontend-solid/src/utils/keyboard.js`
- Create: `frontend-solid/src/components/ShortcutHelp.jsx`
- Modify: `frontend-solid/src/components/Layout.jsx` (mount in `VanLayout`, ~line 95-116)
- Modify: `frontend-solid/src/styles.css` (focus ring near the `html`/`body` rules ~line 101-113)
- Test: `tests/e2e/keyboard-navigation.spec.js` (new; grows in later tasks)

**Interfaces:**
- Produces (later tasks consume):
  - `activateOnKey(handler)` → `(event) => void` for `onKeyDown` — Enter/Space call `handler(event)`, Space `preventDefault()`s.
  - `createFocusTrap(container)` → `dispose()` — cycles Tab/Shift-Tab within `container` (an element).
  - `pushOverlay(onClose)` / `popOverlay()` — overlay stack; while non-empty the registry suppresses everything except Escape, and Escape calls the top `onClose`.
  - `installShortcuts(options)` → `dispose()` — the global registry; `options.openHelp()` is called on `?`.
  - CSS: `:focus-visible` ring; `.button-reset` class.
  - `SHORTCUTS` export: the table rendered by ShortcutHelp (single source of truth).

- [ ] **Step 1: Write the E2E tests (they will fail — feature absent)**

Create `tests/e2e/keyboard-navigation.spec.js`:

```js
// E2E: keyboard-only operation of the van skin. Shortcuts must work when not
// typing, never fire while typing, and everything interactive must be
// reachable and operable without a mouse.
const { test, expect } = require('@playwright/test');

const BASE = process.env.E2E_BASE_URL || 'http://localhost:4174';

const login = async (page) => {
  await page.goto(`${BASE}/#login`);
  await page.getByLabel(/email/i).fill('user1@example.com');
  await page.getByLabel(/password/i).fill('password123');
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.waitForURL(/#(home|feed)/, { timeout: 15000 });
};

test.describe('keyboard shortcuts', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    // Land somewhere neutral with no focused input.
    await page.goto(`${BASE}/#home`);
    await page.locator('body').click({ position: { x: 5, y: 5 } });
  });

  test('g p navigates to predictions, g h back home', async ({ page }) => {
    await page.keyboard.press('g');
    await page.keyboard.press('p');
    await expect(page).toHaveURL(/#predictions$/);
    await page.keyboard.press('g');
    await page.keyboard.press('h');
    await expect(page).toHaveURL(/#home$/);
  });

  test('/ focuses the search input', async ({ page }) => {
    await page.keyboard.press('/');
    await expect(page).toHaveURL(/#search/);
    const active = page.locator('.search-input:focus');
    await expect(active).toHaveCount(1, { timeout: 5000 });
    await page.keyboard.type('hello');
    await expect(page.locator('.search-input')).toHaveValue('hello');
  });

  test('shortcuts do not fire while typing', async ({ page }) => {
    // The home page search box is an input — typing g p there must not navigate.
    await page.locator('.search-input').first().click();
    await page.keyboard.type('gp');
    await expect(page).toHaveURL(/#home$/);
  });

  test('? opens help overlay, Escape closes it', async ({ page }) => {
    await page.keyboard.press('?');
    const help = page.locator('.shortcut-help');
    await expect(help).toBeVisible();
    await expect(help).toContainText('g then p');
    await page.keyboard.press('Escape');
    await expect(help).toHaveCount(0);
  });

  test('shortcuts are inert on the terminal skin', async ({ page }) => {
    // Terminal skin manages its own keys; the van registry must be unmounted.
    await page.evaluate(() => localStorage.setItem('intellacc-skin', 'terminal'));
    await page.reload();
    await page.keyboard.press('g');
    await page.keyboard.press('p');
    await expect(page).not.toHaveURL(/#predictions/);
    await page.evaluate(() => localStorage.setItem('intellacc-skin', 'van'));
  });
});
```

Note: check how the skin is persisted before relying on the last test —
read `frontend-solid/src/services/skinProvider.js` (the localStorage key
may differ; adjust `'intellacc-skin'` to the real key, or set the skin via
the UI toggle instead).

- [ ] **Step 2: Run to verify failure**

Run: `./tests/e2e/reset-test-users.sh && npx playwright test tests/e2e/keyboard-navigation.spec.js`
Expected: all tests FAIL (no navigation on g p, no help overlay).

- [ ] **Step 3: Implement `frontend-solid/src/utils/keyboard.js`**

```js
// Shared keyboard helpers for the van skin (terminal skin has its own).
// One global listener (installShortcuts) owns all single-key and g-sequence
// shortcuts; overlays register on a stack that suppresses everything but
// Escape while open.

const SEQUENCE_TIMEOUT_MS = 1500;

export const SHORTCUTS = [
  { keys: 'g then h', action: 'Home', hash: 'home' },
  { keys: 'g then p', action: 'Predictions', hash: 'predictions' },
  { keys: 'g then m', action: 'Messages', hash: 'messages' },
  { keys: 'g then n', action: 'Notifications', hash: 'notifications' },
  { keys: 'g then a', action: 'Analytics', hash: 'analytics' },
  { keys: 'g then g', action: 'Groups', hash: 'groups' },
  { keys: 'g then s', action: 'Settings', hash: 'settings' },
  { keys: 'g then u', action: 'My profile', hash: 'profile' },
  { keys: '/', action: 'Search' },
  { keys: 'j / k', action: 'Next / previous item in the list' },
  { keys: 'Enter', action: 'Open the focused item' },
  { keys: '← / →', action: 'Jump between sidebar and content' },
  { keys: '?', action: 'This help' },
  { keys: 'Esc', action: 'Close dialog / collapse item' },
];

const GO_TARGETS = Object.fromEntries(
  SHORTCUTS.filter((s) => s.hash).map((s) => [s.keys.slice(-1), s.hash])
);

export const activateOnKey = (handler) => (event) => {
  if (event.key === 'Enter' || event.key === ' ') {
    if (event.key === ' ') event.preventDefault();
    handler(event);
  }
};

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export const createFocusTrap = (container) => {
  const onKeyDown = (event) => {
    if (event.key !== 'Tab') return;
    const items = [...container.querySelectorAll(FOCUSABLE)].filter(
      (el) => el.offsetParent !== null
    );
    if (items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };
  container.addEventListener('keydown', onKeyDown);
  return () => container.removeEventListener('keydown', onKeyDown);
};

// Overlay stack: while non-empty, the shortcut registry is silent except for
// Escape, which closes the top overlay.
const overlayStack = [];
export const pushOverlay = (onClose) => overlayStack.push(onClose);
export const popOverlay = () => overlayStack.pop();
export const overlayDepth = () => overlayStack.length;

const isTypingTarget = (target) => {
  const tag = target?.tagName;
  return (
    tag === 'INPUT' ||
    tag === 'TEXTAREA' ||
    tag === 'SELECT' ||
    target?.isContentEditable
  );
};

const isDesktop = () => window.matchMedia('(min-width: 1025px)').matches;

const focusFirst = (selector) => {
  const el = document.querySelector(selector);
  if (el) el.focus();
  return !!el;
};

// Navigate to #search and focus its input once it renders.
const goToSearch = () => {
  window.location.hash = 'search';
  const started = Date.now();
  const tryFocus = () => {
    const input = document.querySelector('.page-search .search-input, .search-input');
    if (input) {
      input.focus();
      return;
    }
    if (Date.now() - started < 2000) requestAnimationFrame(tryFocus);
  };
  requestAnimationFrame(tryFocus);
};

const listRows = () => {
  const container = document.querySelector('[data-primary-list]');
  return container ? [...container.querySelectorAll('[data-kb-row]')] : [];
};

const moveInList = (delta) => {
  const rows = listRows();
  if (rows.length === 0) return;
  const current = document.activeElement?.closest('[data-kb-row]');
  const index = current ? rows.indexOf(current) : -1;
  const next = rows[Math.min(rows.length - 1, Math.max(0, index + delta))];
  if (next) {
    next.focus();
    next.scrollIntoView({ block: 'nearest' });
  }
};

const sidebarItems = () =>
  [...document.querySelectorAll('.sidebar .sidebar-item a, .sidebar .sidebar-item button')];

const focusSidebar = () => {
  if (!isDesktop()) return;
  const items = sidebarItems();
  if (items.length === 0) return;
  const currentHash = window.location.hash || '#home';
  const active = items.find((a) => a.getAttribute('href') === currentHash);
  (active || items[0]).focus();
};

const moveInSidebar = (delta) => {
  const items = sidebarItems();
  const index = items.indexOf(document.activeElement);
  if (index === -1) return;
  const next = items[Math.min(items.length - 1, Math.max(0, index + delta))];
  next?.focus();
};

const focusMain = () => {
  if (!isDesktop()) return;
  if (!focusFirst('[data-primary-list] [data-kb-row]')) {
    document.querySelector('.main-content')?.focus();
  }
};

export const installShortcuts = ({ openHelp }) => {
  let pendingPrefix = null;
  let prefixTimer = null;

  const clearPrefix = () => {
    pendingPrefix = null;
    if (prefixTimer) clearTimeout(prefixTimer);
    prefixTimer = null;
  };

  const onKeyDown = (event) => {
    // Escape serves the overlay stack from anywhere, including inputs.
    if (event.key === 'Escape' && overlayStack.length > 0) {
      event.preventDefault();
      overlayStack[overlayStack.length - 1]();
      return;
    }
    if (overlayStack.length > 0) return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (isTypingTarget(event.target)) return;

    // Escape with no overlay open: collapse the focused expanded row.
    if (event.key === 'Escape') {
      const expanded = document.activeElement?.closest('[aria-expanded="true"][role="button"]');
      if (expanded) {
        event.preventDefault();
        expanded.click();
        expanded.focus();
      }
      return;
    }

    // Enter on a j/k-focused row that is not itself a button (e.g. a feed
    // post card): delegate to the row's designated primary action. Only
    // when the row ITSELF is focused — Enter on a nested button must not
    // double-fire.
    if (event.key === 'Enter') {
      const row = event.target;
      if (
        row instanceof Element &&
        row.hasAttribute('data-kb-row') &&
        !row.matches('[role="button"], button, a')
      ) {
        row.querySelector('[data-kb-enter]')?.click();
      }
      return;
    }

    const inSidebar = !!event.target.closest?.('.sidebar');

    if (pendingPrefix === 'g') {
      clearPrefix();
      const hash = GO_TARGETS[event.key];
      if (hash) {
        event.preventDefault();
        window.location.hash = hash;
      }
      return;
    }

    switch (event.key) {
      case 'g':
        pendingPrefix = 'g';
        prefixTimer = setTimeout(clearPrefix, SEQUENCE_TIMEOUT_MS);
        return;
      case '/':
        event.preventDefault();
        goToSearch();
        return;
      case '?':
        event.preventDefault();
        openHelp();
        return;
      case 'j':
        moveInList(1);
        return;
      case 'k':
        moveInList(-1);
        return;
      case 'ArrowLeft':
        if (!inSidebar) {
          event.preventDefault();
          focusSidebar();
        }
        return;
      case 'ArrowRight':
        if (inSidebar) {
          event.preventDefault();
          focusMain();
        }
        return;
      case 'ArrowDown':
        if (inSidebar) {
          event.preventDefault();
          moveInSidebar(1);
        }
        return;
      case 'ArrowUp':
        if (inSidebar) {
          event.preventDefault();
          moveInSidebar(-1);
        }
        return;
      default:
        return;
    }
  };

  window.addEventListener('keydown', onKeyDown);
  return () => {
    clearPrefix();
    window.removeEventListener('keydown', onKeyDown);
  };
};
```

(`j`/`k`/arrow behavior lands fully in Task 4 when views add the `data-`
attributes; the registry ships complete now so Task 4 is attribute-only.)

- [ ] **Step 4: Implement `frontend-solid/src/components/ShortcutHelp.jsx`**

```jsx
import { onCleanup, onMount, For } from 'solid-js';
import { SHORTCUTS, createFocusTrap, pushOverlay, popOverlay } from '../utils/keyboard';

// Keyboard-shortcut reference dialog, opened with `?`.
export default function ShortcutHelp(props) {
  let panel;
  let disposeTrap;

  onMount(() => {
    pushOverlay(props.onClose);
    disposeTrap = createFocusTrap(panel);
    panel.querySelector('button')?.focus();
  });

  onCleanup(() => {
    popOverlay();
    disposeTrap?.();
  });

  return (
    <div class="shortcut-help-backdrop" onClick={props.onClose}>
      <div
        class="shortcut-help"
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard shortcuts"
        ref={panel}
        onClick={(e) => e.stopPropagation()}
      >
        <h2>Keyboard shortcuts</h2>
        <table>
          <tbody>
            <For each={SHORTCUTS}>
              {(s) => (
                <tr>
                  <td class="shortcut-keys">{s.keys}</td>
                  <td>{s.action}</td>
                </tr>
              )}
            </For>
          </tbody>
        </table>
        <button type="button" class="secondary" onClick={props.onClose}>
          Close
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Mount in `VanLayout` (Layout.jsx)**

In `VanLayout` (Layout.jsx:95-116): add signals + lifecycle. Because
`Layout`'s `<Show when={skinState() === 'van'}>` unmounts `VanLayout` on
skin switch, `onCleanup` disposes the registry automatically — that is the
spec's "disposed on skin switch" requirement.

```jsx
import { installShortcuts } from '../utils/keyboard';
import ShortcutHelp from './ShortcutHelp';
// inside VanLayout:
const [helpOpen, setHelpOpen] = createSignal(false);
onMount(() => {
  window.addEventListener('hashchange', closeDrawer);
  const dispose = installShortcuts({ openHelp: () => setHelpOpen(true) });
  onCleanup(dispose);
});
// in the JSX, alongside MobileTabBar:
<Show when={helpOpen()}>
  <ShortcutHelp onClose={() => setHelpOpen(false)} />
</Show>
```

(Merge with the existing `onMount`/`onCleanup` for `hashchange` rather than
adding a second pair.)

- [ ] **Step 6: CSS (styles.css)**

After the `body` rule (~line 113):

```css
/* Keyboard focus: visible ring for keyboard users only. */
:focus-visible {
  outline: 2px solid #0000ff;
  outline-offset: 1px;
}
body.dark-mode :focus-visible {
  outline-color: rgba(255, 255, 255, 0.85);
}

/* Strip button chrome when converting clickable divs/spans to <button>. */
.button-reset {
  background: none;
  border: none;
  padding: 0;
  margin: 0;
  font: inherit;
  color: inherit;
  text-align: inherit;
  cursor: pointer;
}
```

Near the other overlay styles (search for `modal-overlay` or use the end of
the file):

```css
.shortcut-help-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}
.shortcut-help {
  background: var(--card-bg, #fff);
  border: 2px solid #000;
  padding: 1.25rem 1.5rem;
  max-width: 420px;
  width: 90%;
  max-height: 80vh;
  overflow-y: auto;
}
.shortcut-help table {
  width: 100%;
  border-collapse: collapse;
  margin: 0.75rem 0 1rem;
}
.shortcut-help td {
  padding: 0.25rem 0.5rem 0.25rem 0;
  border-bottom: 1px solid var(--border-color, #ddd);
}
.shortcut-keys {
  font-weight: 600;
  white-space: nowrap;
}
body.dark-mode .shortcut-help {
  border-color: var(--border-color);
}
```

- [ ] **Step 7: Run the E2E to green**

Run: `npx playwright test tests/e2e/keyboard-navigation.spec.js`
Expected: all Task-1 tests PASS. (`j`/`k` and arrow tests come later.)

- [ ] **Step 8: Commit**

```bash
git add frontend-solid/src/utils/keyboard.js frontend-solid/src/components/ShortcutHelp.jsx frontend-solid/src/components/Layout.jsx frontend-solid/src/styles.css tests/e2e/keyboard-navigation.spec.js
git commit -m "feat(a11y): shortcut registry, g-navigation, / search, ? help overlay

Single global keydown listener mounted by the van layout (auto-disposed on
skin switch); typing/modifier/overlay guards; focus-visible ring token.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: A11y sweep — rows and buttons

**Files:**
- Modify: `frontend-solid/src/components/predictions/EventsList.jsx` (row ~line 489)
- Modify: `frontend-solid/src/components/predictions/MyPositions.jsx` (row ~line 216)
- Modify: `frontend-solid/src/components/market/MarketList.jsx:19-31`
- Modify: `frontend-solid/src/components/market/MarketTicker.jsx:40-41`
- Modify: `frontend-solid/src/components/groups/GroupCard.jsx:25`
- Modify: `frontend-solid/src/components/posts/PostItem.jsx:602-609,815-822`
- Modify: `frontend-solid/src/pages/MessagesPage.jsx:928-931`
- Modify: `frontend-solid/src/components/ChatPanel.jsx` (4 clickable div/span)
- Modify: `frontend-solid/src/components/Layout.jsx:108` (drawer backdrop: `aria-hidden`)
- Test: extend `tests/e2e/keyboard-navigation.spec.js`

**Interfaces:**
- Consumes: `activateOnKey` from `frontend-solid/src/utils/keyboard.js`, `.button-reset` CSS (Task 1).
- Produces: every converted row has `role="button"` `tabindex="0"`; visual classes unchanged.

Two conversion patterns — apply the right one per site:

**Pattern A — real `<button>`** (for activating elements whose tag can change):

```jsx
// before
<span class="comments-toggle" role="button" tabindex="0" onClick={toggle}>…</span>
// after
<button type="button" class="button-reset comments-toggle" onClick={toggle}>…</button>
```

Keep every existing class. Remove now-redundant `role`/`tabindex`. Sites:
`GroupCard.jsx:25` (wrap the card's activation area — if the whole card div
is the click target and contains other interactive elements, use Pattern B
on the div instead; check first), `MarketTicker.jsx:40`, `PostItem.jsx`
comment-count span (~602) and expand/collapse-all span (~815),
`ChatPanel.jsx` all four sites (same check as GroupCard for container-level
onClick).

**Pattern B — button-semantics row** (row div/li that expands/selects and
may contain nested interactive elements — a `<button>` cannot contain
buttons, so keep the tag):

```jsx
// before
<div class="event-list-item-row" onClick={() => handleEventClick(marketItem)}>
// after
<div
  class="event-list-item-row"
  role="button"
  tabindex="0"
  onClick={() => handleEventClick(marketItem)}
  onKeyDown={activateOnKey(() => handleEventClick(marketItem))}
>
```

Sites: `EventsList.jsx` row (~489), `MyPositions.jsx` row (~216 — note the
resolved-row variant is intentionally non-interactive: give it
`role="button"`/`tabindex`/handler ONLY when `!isResolved`, e.g. spread
conditionally), `MarketList.jsx:19-31` row, `MessagesPage.jsx:928-931`
conversation li (it already has `role="button"` — add `tabindex="0"` +
`onKeyDown`).

**Expandable rows also get `aria-expanded`** so the registry's Escape can
collapse them (and screen readers announce state): on the EventsList row
add `aria-expanded={isExpanded(marketItem.id)}`, on the MyPositions open
row add `aria-expanded={expandedPositionIds().has(rowKey)}`.

**Enter delegation marker:** the PostItem comment-count toggle (Pattern A
button) additionally gets `data-kb-enter` — Task 4's feed post cards are
not buttons, and the registry clicks `[data-kb-enter]` inside the focused
row on Enter.

**Backdrop:** `Layout.jsx:108` drawer backdrop div gets `aria-hidden="true"`
(mouse-only dismiss; Escape path is Task 3's pattern but the drawer already
closes on hashchange — leave behavior otherwise as-is).

- [ ] **Step 1: Write the failing E2E additions**

Append to `tests/e2e/keyboard-navigation.spec.js`:

```js
test.describe('keyboard row operation', () => {
  test('market row expands with Enter and collapses with Escape', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/#predictions/markets`);
    await page.waitForSelector('.events-simple-list li');
    const firstRow = page.locator('.event-list-item-row').first();
    await firstRow.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('.event-row-expanded').first()).toBeVisible();
    await expect(firstRow).toHaveAttribute('aria-expanded', 'true');
    await page.keyboard.press('Escape');
    await expect(page.locator('.event-row-expanded')).toHaveCount(0);
    // Focus stays on the row after collapsing.
    const stillFocused = await page.evaluate(() =>
      document.activeElement?.classList.contains('event-list-item-row')
    );
    expect(stillFocused).toBe(true);
  });

  test('post comment toggle is a focusable button', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/#home`);
    await page.waitForSelector('.post-card', { timeout: 15000 });
    const toggle = page.locator('.post-card button.button-reset').first();
    await expect(toggle).toBeVisible();
  });
});
```

Run: `npx playwright test tests/e2e/keyboard-navigation.spec.js`
Expected: new tests FAIL (rows not focusable / buttons absent).

- [ ] **Step 2: Apply the conversions** (both patterns, all sites listed above; read each site first — line numbers are from a 2026-07-07 inventory and may have drifted).

- [ ] **Step 3: Run the new tests to green, then the regression specs**

```bash
npx playwright test tests/e2e/keyboard-navigation.spec.js
npx playwright test tests/e2e/my-positions-section.spec.js tests/e2e/predictions-tabs.spec.js tests/e2e/messaging-v2-smoke.spec.js
```

Expected: all PASS (converted elements keep their classes, so selectors hold).

- [ ] **Step 4: Commit**

```bash
git add -A frontend-solid/src tests/e2e/keyboard-navigation.spec.js
git commit -m "feat(a11y): keyboard-operable rows, cards, and toggles across the van skin

Clickable divs/spans become real buttons (.button-reset) or role=button
rows with Enter/Space activation; drawer backdrop marked aria-hidden.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Van modals — dialog semantics, Escape, focus trap

**Files:**
- Modify: `frontend-solid/src/components/auth/LoginModal.jsx` (~line 142)
- Modify: `frontend-solid/src/components/vault/DeviceLinkModal.jsx` (~line 170)
- Test: extend `tests/e2e/keyboard-navigation.spec.js`

**Interfaces:**
- Consumes: `createFocusTrap`, `pushOverlay`, `popOverlay` (Task 1 — Escape handling comes from the registry's overlay stack, so the modals do NOT add their own Escape listeners).

Pattern (apply to both modals; read each component first to find its close
handler and outermost overlay element):

```jsx
import { onMount, onCleanup } from 'solid-js';
import { createFocusTrap, pushOverlay, popOverlay } from '../../utils/keyboard';

// inside the component:
let panelRef;
let disposeTrap;
let invoker;
onMount(() => {
  invoker = document.activeElement;
  pushOverlay(handleClose);           // the modal's existing close function
  disposeTrap = createFocusTrap(panelRef);
  panelRef.querySelector('input, button')?.focus();
});
onCleanup(() => {
  popOverlay();
  disposeTrap?.();
  invoker?.focus?.();
});
// on the dialog panel element:
<div class="…existing classes…" role="dialog" aria-modal="true" aria-label="Sign in" ref={panelRef}>
```

(`aria-label`: "Sign in" for LoginModal, "Link device" for DeviceLinkModal.)
Caveat: the overlay stack lives in the van registry, but `pushOverlay`/Escape
must work even if these modals can appear outside `VanLayout` — check where
they are rendered; if a modal can render while the terminal skin is active,
add a scoped `keydown` listener on the panel for Escape as a fallback
(document what you found in the report).

- [ ] **Step 1: Write the failing E2E addition**

```js
test.describe('modal keyboard behavior', () => {
  test('login modal: focus lands inside, Tab cycles, Escape closes', async ({ page }) => {
    // Find a flow that opens LoginModal (e.g. an auth-gated action while
    // logged out). Read the component's usage; if it is only reachable via
    // messaging vault flows, use DeviceLinkModal via settings instead —
    // whichever modal is reachable in E2E. Assert: role=dialog visible,
    // document.activeElement inside it, Escape hides it.
    await page.goto(`${BASE}/#home`);
    // …drive the discovered flow…
    const dialog = page.locator('[role="dialog"]');
    await expect(dialog).toBeVisible();
    const focusInside = await page.evaluate(() =>
      document.querySelector('[role="dialog"]').contains(document.activeElement)
    );
    expect(focusInside).toBe(true);
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
  });
});
```

This step requires discovering the open-flow in the running app first;
whatever flow you use, the three assertions (visible dialog, focus inside,
Escape closes) are the requirement. If NEITHER modal is reachable in E2E
without real vault/device state, verify manually in the browser, record the
evidence in your report, and commit the spec with the test marked
`test.skip` and a comment naming the blocker.

- [ ] **Step 2: Implement both modals** (pattern above).

- [ ] **Step 3: Run E2E + regression** (same commands as Task 2 Step 3). Expected: PASS (or documented skip).

- [ ] **Step 4: Commit**

```bash
git add frontend-solid/src/components/auth/LoginModal.jsx frontend-solid/src/components/vault/DeviceLinkModal.jsx tests/e2e/keyboard-navigation.spec.js
git commit -m "feat(a11y): van modals as real dialogs — Escape, focus trap, restore

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: j/k list navigation + arrow pane switching + deploy

**Files:**
- Modify: `frontend-solid/src/components/posts/PostsList.jsx` (or wherever the feed maps posts — find the container that renders `article.post-card`)
- Modify: `frontend-solid/src/components/predictions/EventsList.jsx` (list `<ul>` + rows)
- Modify: `frontend-solid/src/components/predictions/MyPositions.jsx` (list `<ul>` + rows)
- Modify: `frontend-solid/src/pages/NotificationsPage.jsx` (list + rows)
- Modify: `frontend-solid/src/pages/MessagesPage.jsx` (conversation list + rows)
- Test: extend `tests/e2e/keyboard-navigation.spec.js`

**Interfaces:**
- Consumes: the registry's `[data-primary-list]`/`[data-kb-row]` contract from Task 1 (already implemented there — this task only adds attributes).

Per view, add `data-primary-list` to the ONE primary list container and
`data-kb-row` to each row:

- Rows already focusable from Task 2 (role="button" rows): just add
  `data-kb-row`.
- Feed post cards (`article.post-card` in the PostItem render): add
  `data-kb-row` and `tabindex="-1"` — focusable via j/k but NOT in the Tab
  order (a card full of buttons should not add a Tab stop itself).
- Notifications rows: check current markup in `NotificationsPage.jsx`
  (`role="list"` exists at ~347); rows may already be links/buttons — add
  `data-kb-row` to the row element, plus `tabindex="-1"` if it is not
  already focusable.
- Only ONE `data-primary-list` may be in the DOM per page. EventsList and
  MyPositions render on different tabs of the predictions page, so both can
  carry the attribute (only one is mounted at a time). HomePage embeds
  SearchPage — make sure the search results list does NOT get the attribute.

- [ ] **Step 1: Write the failing E2E additions**

```js
test.describe('list and pane navigation', () => {
  test('j/k move focus through feed posts', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/#home`);
    await page.waitForSelector('.post-card', { timeout: 15000 });
    await page.locator('body').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('j');
    const first = await page.evaluate(() => document.activeElement?.className);
    expect(first).toContain('post-card');
    await page.keyboard.press('j');
    const secondIsDifferent = await page.evaluate(
      () => document.activeElement === document.querySelectorAll('[data-kb-row]')[1]
    );
    expect(secondIsDifferent).toBe(true);
    await page.keyboard.press('k');
    const backToFirst = await page.evaluate(
      () => document.activeElement === document.querySelectorAll('[data-kb-row]')[0]
    );
    expect(backToFirst).toBe(true);
  });

  test('arrow keys jump between sidebar and market list', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/#predictions/markets`);
    await page.waitForSelector('.events-simple-list li');
    await page.locator('body').click({ position: { x: 700, y: 300 } });
    await page.keyboard.press('ArrowLeft');
    const inSidebar = await page.evaluate(() =>
      document.activeElement?.closest('.sidebar') !== null
    );
    expect(inSidebar).toBe(true);
    await page.keyboard.press('ArrowDown');
    const stillInSidebar = await page.evaluate(() =>
      document.activeElement?.closest('.sidebar') !== null
    );
    expect(stillInSidebar).toBe(true);
    await page.keyboard.press('ArrowRight');
    const onRow = await page.evaluate(() =>
      document.activeElement?.hasAttribute('data-kb-row')
    );
    expect(onRow).toBe(true);
  });
});
```

Run → expected FAIL (attributes absent).

- [ ] **Step 2: Add the attributes per view** (list above).

- [ ] **Step 3: Full keyboard spec + regressions to green**

```bash
npx playwright test tests/e2e/keyboard-navigation.spec.js
npx playwright test tests/e2e/my-positions-section.spec.js tests/e2e/predictions-tabs.spec.js tests/e2e/predictions-pagination.spec.js tests/e2e/messaging-v2-smoke.spec.js
```

(predictions-pagination needs `PLAYWRIGHT_BASE_URL=http://localhost:4174`.)

- [ ] **Step 4: Commit**

```bash
git add -A frontend-solid/src tests/e2e/keyboard-navigation.spec.js
git commit -m "feat(a11y): j/k list navigation and arrow-key sidebar/content switching

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

- [ ] **Step 5: Deploy and verify prod**

```bash
docker restart intellacc_frontend_solid
# wait for the rebuild, then:
docker exec intellacc_frontend_solid sh -c 'grep -l "shortcut-help" dist/assets/*.js | head -1'
BUNDLE=$(curl -s https://intellacc.de/ | grep -o 'assets/index-[^"]*\.js' | head -1)
curl -s "https://intellacc.de/$BUNDLE" | grep -c "shortcut-help"
```

Expected: both greps match (prod serves the keyboard build). Never verify
via localhost:4174 (dev container).
