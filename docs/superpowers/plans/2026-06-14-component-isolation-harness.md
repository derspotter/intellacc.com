# Component-Isolation Visual Harness (PostItem) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A dev-only `#__harness` route that renders `PostItem` with fixed-data fixtures, screenshotted by the visual net for deterministic feed-component coverage.

**Architecture:** A self-contained `Harness.jsx` renders a gallery of `<PostItem>` instances from hardcoded fixtures, wired into `VanApp` behind an `import.meta.env.DEV` guard so it is stripped from the prod bundle. New Playwright baselines screenshot the gallery — no auth, no masking (fixtures are deterministic).

**Tech Stack:** SolidJS + Vite (`import.meta.env.DEV` for dev-only gating), Playwright `toHaveScreenshot`.

**Spec:** `docs/superpowers/specs/2026-06-14-component-isolation-harness-design.md`

**Conventions (read before starting):**
- Dev stack up first, ALWAYS `-p solid-local`: `docker compose -p solid-local -f docker-compose.solid-local.yml up -d`; confirm `curl -sf -o /dev/null http://localhost:4174/`. It runs `vite dev`, so `import.meta.env.DEV === true` there; prod uses `vite build` (`DEV === false`).
- Tests run from repo root on the host: `npx playwright test tests/e2e/<spec>`.
- Screenshot lifecycle: a new `toHaveScreenshot('x.png')` with no baseline FAILS ("snapshot doesn't exist, writing actual"); re-run with `--update-snapshots=all` to write it, then a plain run passes. Use `--update-snapshots=all` (plain `--update-snapshots` skips rewrites within `maxDiffPixelRatio`).
- After generating a baseline, OPEN the PNG and eyeball it before committing (the controller does this for visual tasks).
- `PostItem` is `frontend-solid/src/components/posts/PostItem.jsx` (default export); it reads from `props.post`: `id, user_id, username, content, created_at, like_count, comment_count, liked_by_user, avatar_url, image_url, image_attachment_id, reposted_post, ai_is_flagged, ai_probability, ai_detected_model`. It also takes `onPostUpdate`/`onPostDelete` callbacks (pass no-ops).

---

### Task 1: Harness component + fixtures + dev-only route

**Files:**
- Create: `frontend-solid/src/_harness/postItemFixtures.js`
- Create: `frontend-solid/src/_harness/Harness.jsx`
- Modify: `frontend-solid/src/VanApp.jsx`

- [ ] **Step 1: Create fixtures `frontend-solid/src/_harness/postItemFixtures.js`**

```js
// Deterministic PostItem fixtures for the visual harness. Fixed created_at and
// counts so the rendered timestamp/like/comment text never changes between runs.
const BASE = {
  id: 1,
  user_id: 101,
  username: 'fixture_user',
  content: 'A short baseline post.',
  created_at: '2026-01-01T00:00:00Z',
  like_count: 3,
  comment_count: 2,
  liked_by_user: false,
  avatar_url: null,
  image_url: null,
  image_attachment_id: null,
  reposted_post: null,
  ai_is_flagged: false,
  ai_probability: null,
  ai_detected_model: null
};

export const postItemFixtures = [
  { ...BASE, id: 1, content: 'A short baseline post.' },
  {
    ...BASE,
    id: 2,
    content:
      'A long, multi-line baseline post. ' +
      'It wraps across several lines so we catch any regression in line-height, ' +
      'card padding, or the global button rule affecting action buttons. ' +
      'Forecasting is a skill you can train; calibration beats confidence.'
  },
  {
    ...BASE,
    id: 3,
    content: 'This post reposts another.',
    reposted_post: {
      id: 99,
      user_id: 102,
      username: 'original_author',
      content: 'The original post being reposted.',
      avatar_url: null
    }
  },
  {
    ...BASE,
    id: 4,
    content: 'A post flagged by AI analysis.',
    ai_is_flagged: true,
    ai_probability: 0.92,
    ai_detected_model: 'gpt-x'
  },
  { ...BASE, id: 5, content: 'A post with high engagement.', like_count: 1234, comment_count: 567 }
];
```

- [ ] **Step 2: Create `frontend-solid/src/_harness/Harness.jsx`**

```jsx
// Dev-only visual-regression harness: renders PostItem in isolation with fixed
// fixtures so the feed component can be screenshotted deterministically.
import { For } from 'solid-js';
import PostItem from '../components/posts/PostItem';
import { postItemFixtures } from './postItemFixtures';

const noop = () => {};

export default function Harness() {
  return (
    <section class="home-page" data-harness="postitem">
      <section class="posts-list">
        <For each={postItemFixtures}>
          {(post) => <PostItem post={post} onPostUpdate={noop} onPostDelete={noop} />}
        </For>
      </section>
    </section>
  );
}
```

- [ ] **Step 3: Wire the dev-only route in `frontend-solid/src/VanApp.jsx`**

(a) Add a dev-only lazy import near the other imports (top of file, after the existing page imports). Using the `import.meta.env.DEV ? ... : null` pattern so Rollup drops the dynamic import in prod:

```jsx
import { lazy } from 'solid-js';
const Harness = import.meta.env.DEV ? lazy(() => import('./_harness/Harness')) : null;
```
(If `lazy` is already imported from `solid-js`, merge it into the existing import instead of adding a duplicate.)

(b) Add `__harness` to `ROUTES` only in dev, so it doesn't resolve to NOT_FOUND:

```jsx
const ROUTES = {
  home: 'home',
  login: 'login',
  signup: 'signup',
  'forgot-password': 'forgot-password',
  'reset-password': 'reset-password',
  profile: 'profile',
  user: 'user',
  predictions: 'predictions',
  analytics: 'analytics',
  network: 'network',
  messages: 'messages',
  notifications: 'notifications',
  settings: 'settings',
  'verify-email': 'verify-email',
  search: 'search',
  ...(import.meta.env.DEV ? { __harness: '__harness' } : {})
};
```

(c) In `renderPage`, add a branch (before the final not-found fallback):

```jsx
    if (import.meta.env.DEV && page() === '__harness') {
      return <Harness />;
    }
```

(d) Render the harness WITHOUT the Layout chrome (clean component shot). Find the top-level return:
```jsx
      <Show
        when={isAuthPage()}
        fallback={
          <Layout page={page()}>
            <Show when={!needsTopics()} fallback={<TopicPicker onDone={() => setNeedsTopics(false)} />}>
              {renderPage()}
            </Show>
          </Layout>
        }
      >
        {renderPage()}
      </Show>
```
Change the `when` so the harness also bypasses Layout:
```jsx
      <Show
        when={isAuthPage() || (import.meta.env.DEV && page() === '__harness')}
        fallback={ /* unchanged Layout block */ }
      >
        {renderPage()}
      </Show>
```
(Keep the fallback block exactly as it was — only the `when` expression changes.)

- [ ] **Step 4: Bring up the dev stack and verify the harness renders (no console errors)**

Run:
```bash
docker compose -p solid-local -f docker-compose.solid-local.yml up -d
until curl -sf -o /dev/null http://localhost:4174/; do sleep 2; done
```
Then verify via a throwaway Playwright check that the gallery renders and PostItem mounts without throwing:
```bash
cat > tests/e2e/_harness_check.spec.js <<'EOF'
const { test, expect } = require('@playwright/test');
const { SOLID_URL } = require('./helpers/solidMessaging');
test('harness renders', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${SOLID_URL}/#__harness`, { waitUntil: 'networkidle' });
  await expect(page.locator('[data-harness="postitem"] .posts-list')).toBeVisible();
  // 5 fixtures → 5 post items (PostItem root has class card-content or post-*; assert >=5 post bodies)
  expect(await page.locator('[data-harness="postitem"] .post-author').count()).toBeGreaterThanOrEqual(5);
  expect(errors, errors.join('\n')).toEqual([]);
});
EOF
npx playwright test tests/e2e/_harness_check.spec.js --reporter=line
rm -f tests/e2e/_harness_check.spec.js
```
Expected: PASS (gallery visible, ≥5 post authors, no page errors). If PostItem throws without auth context, report BLOCKED with the error — do not paper over it (a real component may need a guard; the controller decides).

- [ ] **Step 5: Commit**

```bash
git add frontend-solid/src/_harness/ frontend-solid/src/VanApp.jsx
git commit -m "feat(harness): dev-only PostItem visual harness route (#__harness)"
```

---

### Task 2: Harness visual baseline

**Files:**
- Create: `tests/e2e/visual-harness.spec.js`

- [ ] **Step 1: Create the spec**

```js
// Component-isolation visual baselines (dev-only #__harness route). Deterministic
// fixtures → no auth, no masking. See
// docs/superpowers/specs/2026-06-14-component-isolation-harness-design.md
// Update baselines: npx playwright test tests/e2e/visual-harness.spec.js --update-snapshots=all
const { test, expect } = require('@playwright/test');
const { SOLID_URL } = require('./helpers/solidMessaging');

test('postitem gallery', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto(`${SOLID_URL}/#__harness`, { waitUntil: 'networkidle' });
  await expect(page.locator('[data-harness="postitem"] .posts-list')).toBeVisible();
  await page.waitForTimeout(500);
  await expect(page).toHaveScreenshot('postitem-gallery.png', { fullPage: true });
});
```

- [ ] **Step 2: Run (expect baseline-missing FAIL)**

Run: `npx playwright test tests/e2e/visual-harness.spec.js`
Expected: FAIL — "A snapshot doesn't exist … postitem-gallery … writing actual."

- [ ] **Step 3: Generate baseline, then run twice for stability**

```bash
npx playwright test tests/e2e/visual-harness.spec.js --update-snapshots=all
npx playwright test tests/e2e/visual-harness.spec.js
npx playwright test tests/e2e/visual-harness.spec.js
```
Expected: both plain runs PASS. Report the baseline path
(`tests/e2e/visual-harness.spec.js-snapshots/postitem-gallery-linux.png`). The
controller will open the PNG to confirm all 5 fixture variants render correctly
(basic, long-wrapping, repost, AI-flagged, high-counts) with no overflow/garble.

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/visual-harness.spec.js tests/e2e/visual-harness.spec.js-snapshots/
git commit -m "test(visual): PostItem gallery baseline via harness"
```

---

### Task 3: Prove regression catch + verify prod-stripping + finalize

**Files:**
- Modify (temporarily, reverted): `frontend-solid/src/styles.css`
- Modify: `docs/feature-roadmap.md`

- [ ] **Step 1: Prove the harness catches a feed regression**

Temporarily break a PostItem style. Find the post card rule and change a layout property — e.g. in `frontend-solid/src/styles.css`, locate a `.post-author` or `.posts-list` rule and add an obvious shift (append a new rule at end of file):
```css
.post-author { padding-left: 40px; }
```
Then:
```bash
npx playwright test tests/e2e/visual-harness.spec.js --grep "postitem gallery"
```
Expected: FAIL with a pixel diff (diff image under `.playwright-test-results/`). This proves the harness guards the feed component.

- [ ] **Step 2: Revert the temporary break**

```bash
git checkout frontend-solid/src/styles.css
npx playwright test tests/e2e/visual-harness.spec.js
```
Expected: PASS again (no source change committed).

- [ ] **Step 3: Verify the harness is stripped from the production build**

```bash
cd frontend-solid
docker run --rm -v "$PWD":/app -v /var/opt/docker/intellacc.com/shared:/shared -w /app node:25-alpine sh -c 'npm run build' 2>&1 | tail -3
grep -rc "data-harness\|postItemFixtures\|_harness" dist/ || echo "0 — harness absent from prod bundle ✓"
cd ..
```
Expected: the build succeeds and the grep reports `0` (no harness strings in `dist/`). If non-zero, the dev-only gating failed — STOP and report; the `import.meta.env.DEV ? ... : null` lazy pattern must keep the import out of prod.

- [ ] **Step 4: Roadmap note + commit**

Add under "Later (unordered)" in `docs/feature-roadmap.md`:
```markdown
- **Component-isolation visual harness (v1 shipped 2026-06-14)**: dev-only
  `#__harness` route renders PostItem with fixed fixtures; baseline in
  `tests/e2e/visual-harness.spec.js`. Closes the feed-component coverage gap the
  7 page-level baselines couldn't (deterministic, no masking). Stripped from prod
  via `import.meta.env.DEV`. Follow-up: extend to store-driven components
  (MarketPanel, RPBalance) with a data-mock layer if the gap still hurts.
```
```bash
git add docs/feature-roadmap.md
git commit -m "docs(roadmap): note component-isolation harness v1"
```

---

## Self-review notes

- **Spec coverage:** dev-only route → Task 1 (DEV-gated import/ROUTES/renderPage); PostItem prop-driven gallery + fixtures → Task 1; deterministic (no masking) baseline → Task 2; regression-catch + prod-stripping verification → Task 3; success criteria (3 stable runs, regression caught, prod-absent) → Tasks 2–3.
- **No fixture user / auth** — harness renders logged-out; the Task 1 check asserts no page errors (catches any auth-context crash early).
- **Prod-stripping** is the one real risk; Task 3 Step 3 verifies it by grepping `dist/`, with a clear stop condition if the gating leaks.
- **Adaptation point flagged (Task 1 Step 4):** if `PostItem` throws without auth context, report BLOCKED rather than guess — a guard or a minimal context provider may be needed.
