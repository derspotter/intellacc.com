// Terminal-skin signup branch coverage for LoginModal.jsx
// (frontend-solid/src/components/auth/LoginModal.jsx):
//   - client-side validation guards on the register stage (native `required`
//     + the whitespace-trim guard in handleRegisterSubmit)
//   - response?.requiresApproval -> "approval-pending" stage
//   - err?.status === 429 -> "Registration queue full // try again later"
//
// CRITICAL: this host serves production. POST /api/users/register emails a
// real approver and creates real pending-approval rows, so EVERY test here
// intercepts the register endpoint (and aborts /api/login) before any form is
// submitted. Route-hit counters are asserted so a silently non-intercepted
// request can never fake a pass.
//
// Canned response shapes mirror the real backend
// (backend/src/controllers/userController.js createUser):
//   201: { user, requiresApproval: true, message: 'Registration is pending admin approval.' }
//   429: { code: 'REGISTRATION_QUEUE_FULL', message: 'There is already N registration(s) waiting...' }

const { test, expect } = require('@playwright/test');
const { SOLID_URL } = require('./helpers/solidMessaging');

const REGISTER_ENDPOINT = '**/api/users/register';

// Install network guards. Must be called BEFORE any navigation.
// Returns counters so tests can assert exactly which routes were hit.
// Playwright matches routes newest-first, so the broad /api/users** net only
// catches POSTs that the specific register route did not.
async function installNetworkGuards(page, registerHandler) {
  const counters = { register: 0, login: 0, otherUserPosts: 0 };

  await page.route('**/api/users**', (route) => {
    if (route.request().method() === 'POST') {
      counters.otherUserPosts += 1;
      return route.abort();
    }
    return route.continue();
  });

  await page.route('**/api/login', (route) => {
    counters.login += 1;
    return route.abort();
  });

  await page.route(REGISTER_ENDPOINT, async (route) => {
    counters.register += 1;
    if (registerHandler) {
      await registerHandler(route);
    } else {
      // Tests that expect zero network must never reach here; abort defensively.
      await route.abort();
    }
  });

  return counters;
}

// Navigate (logged out) to the terminal skin and switch the login modal to
// the register stage.
async function openRegisterStage(page) {
  await page.goto(`${SOLID_URL}/?skin=terminal#home`, { waitUntil: 'domcontentloaded' });
  const modal = page.getByRole('dialog', { name: 'Sign in' });
  await expect(modal).toBeVisible({ timeout: 15000 });
  await modal.getByRole('button', { name: 'Register here' }).click();
  await expect(modal.getByRole('button', { name: '> REGISTER' })).toBeVisible();
  return modal;
}

async function fillRegisterForm(modal, { username, email, password }) {
  await modal.getByPlaceholder('Choose handle...').fill(username);
  await modal.getByPlaceholder('Enter system address...').fill(email);
  await modal.getByPlaceholder('Create access key...').fill(password);
}

test('register stage: client-side validation blocks submit without any network call', async ({ page }) => {
  const counters = await installNetworkGuards(page, null);
  const modal = await openRegisterStage(page);
  const submit = modal.getByRole('button', { name: '> REGISTER' });

  // Branch A: empty fields -> native `required` validation blocks submission.
  await submit.click();
  expect(
    await modal.getByPlaceholder('Choose handle...').evaluate((el) => el.validity.valueMissing)
  ).toBe(true);
  await expect(submit).toBeVisible(); // still on register stage

  // Branch B: whitespace-only username passes `required` but is caught by the
  // trim guard in handleRegisterSubmit (early return, no fetch; shows
  // "All fields are required" so the click is not a silent no-op).
  await fillRegisterForm(modal, {
    username: '   ',
    email: 'nosuch_signup_branch@example.com',
    password: 'password123'
  });
  await submit.click();
  // The guard runs synchronously before any fetch: if it had NOT fired,
  // setStage("loading") would have already replaced the form. Its continued
  // visibility is therefore a deterministic proof no request was started.
  await expect(submit).toBeVisible();
  await expect(modal.getByText('AUTHENTICATING...')).toHaveCount(0);
  await expect(modal.getByText('All fields are required')).toBeVisible();

  expect(counters.register).toBe(0);
  expect(counters.login).toBe(0);
  expect(counters.otherUserPosts).toBe(0);
});

test('register stage: requiresApproval response shows pending-approval UX without logging in', async ({ page }) => {
  const counters = await installNetworkGuards(page, (route) =>
    route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({
        user: {
          id: 999999,
          username: 'signup_branch_user',
          email: 'nosuch_signup_branch@example.com',
          is_approved: false,
          created_at: new Date().toISOString()
        },
        requiresApproval: true,
        message: 'Registration is pending admin approval.'
      })
    })
  );
  const modal = await openRegisterStage(page);

  await fillRegisterForm(modal, {
    username: 'signup_branch_user',
    email: 'nosuch_signup_branch@example.com',
    password: 'password123'
  });
  await modal.getByRole('button', { name: '> REGISTER' }).click();

  // Approval-pending stage copy (LoginModal.jsx "approval-pending" stage).
  await expect(
    modal.getByText('Account created // Awaiting admin approval')
  ).toBeVisible({ timeout: 10000 });
  await expect(
    modal.getByText("You'll be able to sign in once an administrator approves your account.")
  ).toBeVisible();

  // Not logged in: no token was saved and no login request was attempted.
  expect(await page.evaluate(() => localStorage.getItem('token'))).toBeNull();
  expect(counters.register).toBe(1);
  expect(counters.login).toBe(0);
  expect(counters.otherUserPosts).toBe(0);

  // "Back to sign in" returns to the identifier stage.
  await modal.getByRole('button', { name: 'Back to sign in' }).click();
  await expect(modal.getByRole('button', { name: '> CONTINUE' })).toBeVisible();
});

test('register stage: 429 shows rate-limit message and the form stays usable', async ({ page }) => {
  const counters = await installNetworkGuards(page, (route) =>
    route.fulfill({
      status: 429,
      contentType: 'application/json',
      body: JSON.stringify({
        code: 'REGISTRATION_QUEUE_FULL',
        message:
          'There is already 1 registration(s) waiting for approval. Please wait until one is approved before creating a new account.'
      })
    })
  );
  const modal = await openRegisterStage(page);

  await fillRegisterForm(modal, {
    username: 'signup_branch_user',
    email: 'nosuch_signup_branch@example.com',
    password: 'password123'
  });
  await modal.getByRole('button', { name: '> REGISTER' }).click();

  // The 429 branch renders its dedicated copy (not the backend message).
  await expect(
    modal.getByText('ERROR: Registration queue full // try again later')
  ).toBeVisible({ timeout: 10000 });

  // Back on the register stage with values retained and fields editable.
  const usernameInput = modal.getByPlaceholder('Choose handle...');
  await expect(usernameInput).toHaveValue('signup_branch_user');
  await usernameInput.fill('signup_branch_user2');
  await expect(usernameInput).toHaveValue('signup_branch_user2');

  // Retry works: a second submit hits the (still intercepted) endpoint again.
  await modal.getByRole('button', { name: '> REGISTER' }).click();
  await expect(
    modal.getByText('ERROR: Registration queue full // try again later')
  ).toBeVisible({ timeout: 10000 });

  expect(await page.evaluate(() => localStorage.getItem('token'))).toBeNull();
  expect(counters.register).toBe(2);
  expect(counters.login).toBe(0);
  expect(counters.otherUserPosts).toBe(0);
});
