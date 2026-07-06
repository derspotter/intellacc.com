# Terminal Skin Parity — Phase 4 Implementation Plan (final phase)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Terminal-native ANALYTICS and ADMIN views, logged-out auth screens (signup/forgot/reset/verify) with LoginModal fixes, and the deferred advanced settings sections (API keys, passkeys, devices, vault). Completes functional parity.

**Architecture:** Extends the view registry (adds `analytics`, `admin` with a new `adminOnly` flag, and a logged-out auth-screen layer in TerminalApp). Advanced settings sections extend SettingsView. All vault/device/passkey work reuses the SHARED services (`vaultService`, `vaultStore`, `webauthnService`, `idleLock`) — these are skin-agnostic service modules, not van components.

**Tech Stack:** SolidJS + Tailwind bb-* tokens, Playwright e2e.

**Spec:** `docs/superpowers/specs/2026-07-05-terminal-skin-parity-design.md`

## Global Constraints

- Branch `worktree-bloomberg-tmux-skin`; worktree `.claude/worktrees/bloomberg-tmux-skin`. No van page components/CSS; bb-* tokens, UPPERCASE mono, `[BRACKET]` chrome, no emojis. Shared SERVICES (`vaultService`, `vaultStore`, `webauthnService`, `services/idleLock`, `services/pushService`) are allowed and expected.
- Registry contract as before; new optional `adminOnly: true` flag: TerminalApp's palette filter AND `applyRoute` must skip adminOnly entries when `!isAdmin()` (`isAdmin` from `services/auth` — JWT role claim).
- `getCurrentUserId`/`isAdmin`/`isAuthenticated` from `services/auth`. Request-epoch guards on stale-clobber-prone async.
- No api.js or backend changes this phase.
- E2E: helpers as before; `?skin=terminal`; never touch real `registration_approval_tokens` rows; KNOWN BACKEND BUG (10 rapid posts) — not relevant here but keep seeds minimal; known-red `terminal-feed-pagination.spec.js` stays excluded.
- Admin e2e users: set `role='admin'` via dbQuery UPDATE, then re-login through `/api/login` to mint a JWT carrying the role claim (VERIFY the login controller includes `role` in the token payload before relying on this; if it doesn't, read how prod admin JWTs get the claim and adapt — report findings).
- Test env: worktree Vite dev on 4175 (running); `SOLID_URL=http://127.0.0.1:4175 PLAYWRIGHT_BASE_URL=http://127.0.0.1:4175`.
- TDD per task; commit per task with trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: ANALYTICS view

**Files:**
- Create: `frontend-solid/src/components/terminal/views/AnalyticsView.jsx`
- Modify: `registry.js` (add `analytics`)
- Test: `tests/e2e/terminal-analytics.spec.js`

**Interfaces:**
- Consumes: `getPredictionAnalyticsDashboard()` (named export) → `GET /analytics/predictions/me` → `{summary:{total_predictions,accuracy_percent,pending_predictions,resolved_predictions,correct_predictions,incorrect_predictions,average_confidence}, activity:{active_markets,open_positions,staked_last_30d,available_reputation,staked_reputation}, recent_predictions:[{event,event_id,prediction_value,confidence,created_at,outcome}], open_positions:[{event_title,exposure_label,quantity_label,closing_date,staked_rp,market_prob}], persuasion:{reward_rp,rewarded_posts,episode_count,recent_payouts:[...]}}` — every field optional-chained with `--` fallbacks.
- Auth gate: unauthenticated → `SIGN IN TO VIEW ANALYTICS`, no API call.
- Layout: `[SUMMARY]` stat-tile grid (6 tiles), `[ACTIVITY]` tile row, `[RECENT PREDICTIONS]` dense rows (event | value | conf | status where status = outcome || PENDING), `[OPEN POSITIONS]` rows (title | exposure | staked | prob%), `[PERSUASION]` tiles + payout rows (skip section when absent). `[REFRESH]` button re-fetching (disabled while loading). Pure divs — no chart libs.
- Registry: `analytics: { title: 'ANALYTICS', component: lazy(() => import('./AnalyticsView')) }`.

- [ ] **Step 1: Failing e2e test**

```js
// tests/e2e/terminal-analytics.spec.js
const { test, expect } = require('@playwright/test');
const { createUser, cleanupUsers, SOLID_URL } = require('./helpers/solidMessaging');

const created = [];
test.afterAll(async () => cleanupUsers(created));

test('analytics view renders summary tiles', async ({ page }) => {
  const u = await createUser('tana1');
  created.push(u);
  await page.addInitScript((t) => localStorage.setItem('token', t), u.token);
  await page.goto(`${SOLID_URL}/?skin=terminal#analytics`, { waitUntil: 'domcontentloaded' });
  const view = page.locator('[data-view="analytics"]');
  await expect(view).toBeVisible({ timeout: 15000 });
  await expect(view.locator('[data-testid="analytics-summary"]')).toBeVisible({ timeout: 15000 });
  await expect(view).toContainText('TOTAL PREDICTIONS');
  await expect(view).toContainText('ACCURACY');
});
```

- [ ] **Step 2: RED** → **Step 3: implement** → **Step 4: GREEN + `terminal-views.spec.js` regression** → **Step 5: Commit** — `feat(terminal): native analytics view (stat tiles, positions, persuasion)`

---

### Task 2: ADMIN view + adminOnly registry gating

**Files:**
- Create: `frontend-solid/src/components/terminal/views/AdminView.jsx`
- Modify: `registry.js` (add `admin` with `adminOnly: true`), `TerminalApp.jsx` (palette + applyRoute skip adminOnly when `!isAdmin()`)
- Test: `tests/e2e/terminal-admin.spec.js`

**Interfaces:**
- Consumes: `isAdmin` from services/auth; `api.events.create({title, details, closing_date})` (import `{ api }`); `getEvents('')` + client filter `!e.outcome` for the resolution list; `resolveEvent(eventId, outcome)` with outcome `'yes'|'no'`; `getMarketQuestionReviewQueue({limit: 20})` (coerce to array defensively), `submitMarketQuestionReview(id, vote, note)` (vote `'approve'|'reject'` — VERIFY the actual vote values in MarketQuestionHub.jsx before wiring), `runMarketQuestionRewards()`; maintenance: `api.weekly.runAll()`, `api.persuasion.runRewards()` (result JSON-dumped in a result row).
- Sections: `[CREATE EVENT]` (title/details/datetime-local closing date), `[RESOLVE MARKET]` (unresolved select or searchable list + `[YES]/[NO]` toggle + `[RESOLVE]`), `[REVIEW QUEUE]` (rows + approve/reject + `[RUN REWARDS]`), `[MAINTENANCE]` (`[RUN WEEKLY ALL]`, `[RUN PERSUASION REWARDS]` with raw JSON result rows). Omit the van's misnamed "AdminEventManagement" prediction form — regular prediction placement exists in the market pane (document this deliberate parity deviation in the view with a comment).
- Gating: view renders `ADMIN ONLY` if `!isAdmin()` (defense in depth on top of routing/palette skip).
- Registry: `admin: { title: 'ADMIN', adminOnly: true, component: lazy(() => import('./AdminView')) }`. TerminalApp: palette filter becomes `.filter(([, v]) => !v.hidden && (!v.adminOnly || isAdmin()))`; `applyRoute` skips opening adminOnly views for non-admins.

- [ ] **Step 1: Failing e2e test**

```js
// tests/e2e/terminal-admin.spec.js
const { test, expect } = require('@playwright/test');
const { createUser, cleanupUsers, apiFetch, dbQuery, SOLID_URL } = require('./helpers/solidMessaging');

const created = [];
const createdEvents = [];
test.afterAll(async () => {
  for (const id of createdEvents) {
    try { dbQuery(`DELETE FROM predictions WHERE event_id = ${id}; DELETE FROM events WHERE id = ${id};`); } catch {}
  }
  await cleanupUsers(created);
});

async function makeAdmin(u) {
  dbQuery(`UPDATE users SET role = 'admin' WHERE id = ${u.id};`);
  const login = await apiFetch('/api/login', {
    method: 'POST',
    body: JSON.stringify({ email: u.email, password: u.password })
  });
  return login.body.token; // fresh JWT carrying the role claim
}

test('non-admin cannot open the admin view', async ({ page }) => {
  const u = await createUser('tadm1');
  created.push(u);
  await page.addInitScript((t) => localStorage.setItem('token', t), u.token);
  await page.goto(`${SOLID_URL}/?skin=terminal#admin`, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('body')).toHaveAttribute('data-skin', 'terminal', { timeout: 15000 });
  await expect(page.locator('[data-view="admin"]')).not.toBeVisible();
});

test('admin creates and resolves an event', async ({ page }) => {
  const u = await createUser('tadm2');
  created.push(u);
  const adminToken = await makeAdmin(u);

  await page.addInitScript((t) => localStorage.setItem('token', t), adminToken);
  await page.goto(`${SOLID_URL}/?skin=terminal#admin`, { waitUntil: 'domcontentloaded' });
  const view = page.locator('[data-view="admin"]');
  await expect(view).toBeVisible({ timeout: 15000 });

  const title = `TERM ADMIN E2E ${Date.now()}`;
  await view.locator('[data-testid="admin-event-title"]').fill(title);
  await view.locator('[data-testid="admin-event-closing"]').fill('2027-01-01T12:00');
  await view.locator('[data-testid="admin-event-create"]').click();
  await expect(view).toContainText('EVENT CREATED', { timeout: 10000 });
  const eid = dbQuery(`SELECT id FROM events WHERE title = '${title.replace(/'/g, "''")}' LIMIT 1;`).split('\n')[0];
  expect(Number(eid)).toBeGreaterThan(0);
  createdEvents.push(Number(eid));

  // Resolve it via the resolution section.
  await view.locator('[data-testid="admin-resolve-search"]').fill(title);
  await view.locator('[data-testid="admin-resolve-pick"]').first().click();
  await view.locator('[data-testid="admin-resolve-yes"]').click();
  await view.locator('[data-testid="admin-resolve-submit"]').click();
  await expect(view).toContainText('RESOLVED AS YES', { timeout: 10000 });
});
```

(Resolution section: `getEvents('')` returns thousands of rows — implement the resolution picker as a search input filtering client-side over unresolved events, showing top 10 matches as `[admin-resolve-pick]` rows. VERIFY `events` table cleanup FK constraints before the afterAll SQL; adapt.)

- [ ] **Step 2: RED** → **Step 3: implement (verify review-queue vote values + login role claim first; report findings)** → **Step 4: GREEN + `terminal-views.spec.js`** → **Step 5: Commit** — `feat(terminal): native admin view (create/resolve events, review queue, maintenance)`

---

### Task 3: Logged-out auth screens + LoginModal fixes

**Files:**
- Create: `frontend-solid/src/components/terminal/views/auth/AuthScreens.jsx` (one file: SignupScreen, ForgotScreen, ResetScreen, VerifyEmailScreen — internal components + a keyed `AUTH_SCREENS` map export)
- Modify: `frontend-solid/src/components/TerminalApp.jsx` (logged-out auth-route layer), `frontend-solid/src/components/auth/LoginModal.jsx` (forgot link + requiresApproval/429 handling)
- Test: `tests/e2e/terminal-auth-screens.spec.js`

**Interfaces:**
- Consumes: `registerUser(username, email, password)` → may return `{requiresApproval}`; 429 status = registration queue full; `forgotPassword(email)` → `{message}`; `resetPassword(token, newPassword, acknowledged)` → possibly `{status:'pending', executeAfter}`; `confirmEmailVerification(token)`; `clearToken` from services/auth (reset success also deletes the `intellacc_keystore` IndexedDB — mirror the van ResetPasswordPage).
- Token extraction: `#reset-password?token=...` / `#verify-email?token=...` — parse from the hash query (reuse the van's regex approach `hash.match(/[?&]token=([^&]+)/)`).
- TerminalApp integration: when `!isLoggedIn()` and `normalizeHashPath(hash)`'s route is one of `signup|forgot-password|reset-password|verify-email`, render the matching auth screen INSTEAD of `<LoginModal />` (full-screen terminal-styled layer, `data-auth-screen="<route>"`; a `[BACK TO LOGIN]` control sets `#home`). Logged-in users hitting these routes: verify-email still works (van allows it — auto-confirm); the others show `ALREADY SIGNED IN`.
- Behaviors: Signup validates (all fields, pw ≥ 6, confirm match); on `requiresApproval` → `ACCOUNT CREATED // AWAITING ADMIN APPROVAL` (no auto-login); on 429 → `REGISTRATION QUEUE FULL // TRY AGAIN LATER`. Forgot always shows the non-revealing sent message. Reset: warning-acknowledge checkbox stage → form → success (`clearToken` + keystore delete + `[GO TO LOGIN]`) or pending (`executeAfter` shown). Verify: auto-runs on mount; success links `#home`; error offers `[REQUEST NEW LINK]` → `#settings`.
- LoginModal fixes: (1) add `[FORGOT PASSWORD?]` link on the password stage → sets `window.location.hash = '#forgot-password'`; (2) register flow checks `response?.requiresApproval` BEFORE auto-login (approval-pending message, no login attempt) and surfaces 429 as the queue-full message.

- [ ] **Step 1: Failing e2e test**

```js
// tests/e2e/terminal-auth-screens.spec.js
const { test, expect } = require('@playwright/test');
const { SOLID_URL } = require('./helpers/solidMessaging');

test('logged-out forgot-password screen renders and submits', async ({ page }) => {
  await page.goto(`${SOLID_URL}/?skin=terminal#forgot-password`, { waitUntil: 'domcontentloaded' });
  const screen = page.locator('[data-auth-screen="forgot-password"]');
  await expect(screen).toBeVisible({ timeout: 15000 });
  await screen.locator('input[type="email"]').fill(`nosuch_${Date.now()}@example.com`);
  await screen.getByRole('button', { name: /SEND RESET LINK/i }).click();
  await expect(screen).toContainText(/RESET LINK|IF AN ACCOUNT EXISTS/i, { timeout: 10000 });
});

test('reset screen without token shows invalid state', async ({ page }) => {
  await page.goto(`${SOLID_URL}/?skin=terminal#reset-password`, { waitUntil: 'domcontentloaded' });
  const screen = page.locator('[data-auth-screen="reset-password"]');
  await expect(screen).toBeVisible({ timeout: 15000 });
  await expect(screen).toContainText(/INVALID|MISSING/i);
});

test('login modal links to forgot password', async ({ page }) => {
  await page.goto(`${SOLID_URL}/?skin=terminal#home`, { waitUntil: 'domcontentloaded' });
  // Advance to the password stage (identifier first).
  await page.locator('input').first().fill('someone@example.com');
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: /FORGOT PASSWORD/i }).click();
  await expect(page.locator('[data-auth-screen="forgot-password"]')).toBeVisible({ timeout: 10000 });
});

test('verify-email without token shows error state', async ({ page }) => {
  await page.goto(`${SOLID_URL}/?skin=terminal#verify-email`, { waitUntil: 'domcontentloaded' });
  const screen = page.locator('[data-auth-screen="verify-email"]');
  await expect(screen).toBeVisible({ timeout: 15000 });
  await expect(screen).toContainText(/INVALID|MISSING|FAILED/i, { timeout: 10000 });
});
```

(Adapt the login-modal navigation steps to the modal's actual stage markup — read LoginModal.jsx first; identifier stage may need a specific button click rather than Enter.)

- [ ] **Step 2: RED** → **Step 3: implement** → **Step 4: GREEN + `terminal-skin-back.spec.js` + `terminal-views.spec.js` regressions** → **Step 5: Commit** — `feat(terminal): logged-out auth screens + login modal forgot link and approval handling`

---

### Task 4: SETTINGS advanced I — API keys + passkeys

**Files:**
- Modify: `frontend-solid/src/components/terminal/views/SettingsView.jsx` (two new sections replacing part of the deferred note)
- Test: extend `tests/e2e/terminal-settings.spec.js`

**Interfaces:**
- API keys: `api.users.getApiKeys()` → `{keys:[{id,name,is_bot,created_at,last_used_at}]}`; `createApiKey(name, isBot)` → `{apiKey}` (shown ONCE in a highlighted row with a copy hint); `revokeApiKey(id)` (inline `[CONFIRM]` second-click instead of window.confirm); 403/'Forbidden' → `NEEDS EMAIL + PHONE VERIFICATION` banner replacing the create form (match ApiKeysManager's ApiError check).
- Passkeys: `webauthnService` default export — `isAvailable()`, `getCredentials()` → rows `{name, last_used_at}`, `register(name, prfInput)`, `deleteCredential(id)`. Vault-unlocked fork: when `vaultService.isUnlocked()`, show the extra CURRENT PASSWORD field and call `vaultService.setupPrfWrapping(...)` after register exactly as PasskeyManager does (soft-fail with a warning row); read PasskeyManager.jsx first and mirror its sequence faithfully. Unsupported browser → `WEBAUTHN NOT SUPPORTED`.
- e2e (API keys only — WebAuthn ceremonies can't run headless): provision the user to tier 2 via dbQuery, create a key, expect the reveal-once row, revoke it. Passkeys section: assert it renders (either the unsupported message or the empty list) — nothing deeper.

- [ ] **Step 1: extend spec (RED)** → **Step 2: implement** → **Step 3: GREEN + full `terminal-settings.spec.js`** → **Step 4: Commit** — `feat(terminal): api keys + passkeys sections in settings`

---

### Task 5: SETTINGS advanced II — devices + vault

**Files:**
- Modify: `frontend-solid/src/components/terminal/views/SettingsView.jsx` (DEVICES + VAULT sections; remove the deferred note row)
- Test: extend `tests/e2e/terminal-settings.spec.js`

**Interfaces:**
- Read `DeviceManager.jsx` and `VaultSettings.jsx` FIRST and mirror their flows faithfully — these orchestrate shared vault state:
- VAULT section: lock status row (`vaultStore.isLocked`/`vaultExists`); unlock form (`vaultService.unlockWithPassword`); `[LOCK NOW]` (`vaultService.lockKeys()` then `#home` — do NOT hard-redirect to `/#login` like the van; terminal stays in-app); auto-lock minutes `<select>` (`configureIdleAutoLock`, `loadIdleLockConfig`, `vaultStore.autoLockMinutes`); CHANGE PASSWORD two-step: `vaultService.changePassphrase(current, next)` THEN `api.users.changePassword(current, next)` — sequential, abort on step-1 failure (this REPLACES the Phase-3 simple password section — merge them: the password form must use the two-step path when a vault exists, plain changePassword otherwise); PANIC WIPE with a typed `WIPE` confirmation (terminal-styled inline confirm instead of the van's double window.confirm) → `vaultService.panicWipe()` (fallback `lockKeys`) → clearToken → `#home`.
- DEVICES section: gate on vault unlocked (`requiresVaultAuth` pattern); list (`api.devices.list()` rows `{id,name,is_primary,created_at}` + `[REVOKE]` with inline confirm); `[LINK NEW DEVICE]` → `api.devices.startLinking(devicePublicId, name)` → token display row + 3s status polling (`getLinkingStatus`) until approved (clear interval on cleanup/section close); APPROVE form (paste token + password → `api.devices.approveLinking`); pending-requests poll every 15s while the section is visible (cleanup on unmount).
- e2e: vault/device flows need real keystore ceremonies — keep it shallow: assert the VAULT section renders lock status, and the DEVICES section shows either the unlock gate or the device list. The password two-step: covered only when no vault exists (fresh test user) — exercise the plain change-password path end-to-end (change it, then re-login via apiFetch with the new password, expect 200).

- [ ] **Step 1: extend spec (RED)** → **Step 2: implement** → **Step 3: GREEN + full `terminal-settings.spec.js` + build** → **Step 4: Commit** — `feat(terminal): devices + vault sections in settings (shared vault services)`

---

### Task 6: Phase-4 gate + FINAL whole-branch review

**Files:** none (verification only)

- [ ] **Step 1: Full suite** — every terminal spec + van regressions, MINUS known-red feed-pagination:

```bash
SOLID_URL=http://127.0.0.1:4175 PLAYWRIGHT_BASE_URL=http://127.0.0.1:4175 npx playwright test \
  tests/e2e/terminal-views.spec.js tests/e2e/terminal-profile.spec.js \
  tests/e2e/terminal-notifications.spec.js tests/e2e/terminal-search.spec.js \
  tests/e2e/terminal-feed-comments.spec.js tests/e2e/terminal-feed-source.spec.js \
  tests/e2e/terminal-market-pagination.spec.js tests/e2e/terminal-weekly.spec.js \
  tests/e2e/terminal-settings.spec.js tests/e2e/terminal-groups.spec.js \
  tests/e2e/terminal-group-page.spec.js tests/e2e/terminal-network.spec.js \
  tests/e2e/terminal-analytics.spec.js tests/e2e/terminal-admin.spec.js \
  tests/e2e/terminal-auth-screens.spec.js tests/e2e/skin-preference-sync.spec.js \
  tests/e2e/terminal-skin-back.spec.js tests/e2e/predictions-pagination.spec.js \
  tests/e2e/predictions-tabs.spec.js
```

- [ ] **Step 2: Production build.**
- [ ] **Step 3: Smoke screenshots** (analytics, admin, auth screens, settings advanced sections) — scratchpad, eyeball.
- [ ] **Step 4: FINAL WHOLE-BRANCH review** — `scripts/review-package 2a41b5f HEAD` (all four phases) on the most capable model, with the accumulated deferred-minors list from the ledger for triage.
- [ ] **Step 5: Report** — no merge/push; hand off to superpowers:finishing-a-development-branch (user decides merge/PR/deploy; the backend getFeed fix + skin sync activate on deploy).
