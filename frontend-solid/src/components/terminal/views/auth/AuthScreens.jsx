import { createEffect, createSignal, Show } from 'solid-js';
import {
  registerUser,
  authLogin,
  forgotPassword,
  resetPassword,
  confirmEmailVerification
} from '../../../../services/api';
import { clearToken } from '../../../../services/auth';
import { saveToken, userData, isLoggedIn } from '../../../../services/tokenService';
import vaultService from '../../../../services/mls/vaultService';

// Full-screen logged-out auth layer, keyed by hash route segment. Mirrors the
// van skin's dedicated auth pages (ForgotPasswordPage / ResetPasswordPage /
// VerifyEmailPage) but styled as a terminal overlay, and consumed by
// TerminalApp instead of routed pages.

const getTokenFromHash = () => {
  const hash = window.location.hash;
  const match = hash.match(/[?&]token=([^&]+)/);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
};

// Shared chrome for every auth screen: the full-screen overlay, the
// data-auth-screen hook the e2e tests key off of, and the back-to-login
// control. `allowWhenLoggedIn` lets verify-email auto-run for signed-in
// users (van behavior) while the other three routes show an
// "ALREADY SIGNED IN" gate instead of re-running signup/forgot/reset forms.
function AuthScreenLayout(props) {
  const alreadySignedIn = () => isLoggedIn() && !props.allowWhenLoggedIn;

  return (
    <div
      class="absolute inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm font-mono"
      data-auth-screen={props.screen}
    >
      <div class="w-full max-w-md bg-bb-panel border border-bb-border p-4 shadow-2xl text-sm">
        <div class="text-center text-bb-accent mb-6 font-bold tracking-wider uppercase">{props.title}</div>

        <Show
          when={alreadySignedIn()}
          fallback={props.children}
        >
          <div class="text-bb-accent border border-bb-accent/30 bg-bb-accent/10 p-3 text-xs text-center uppercase font-bold">
            ALREADY SIGNED IN
          </div>
        </Show>

        <button
          type="button"
          onClick={() => { window.location.hash = '#home'; }}
          class="mt-6 text-bb-muted text-xs hover:text-bb-text text-center w-full uppercase tracking-wide"
        >
          {alreadySignedIn() ? '[GO HOME]' : '[BACK TO LOGIN]'}
        </button>
      </div>
    </div>
  );
}

function SignupScreen() {
  const [username, setUsername] = createSignal('');
  const [email, setEmail] = createSignal('');
  const [password, setPassword] = createSignal('');
  const [confirmPassword, setConfirmPassword] = createSignal('');
  const [error, setError] = createSignal('');
  const [message, setMessage] = createSignal('');
  const [pending, setPending] = createSignal(false);
  const [stage, setStage] = createSignal('form'); // form | pending-approval | manual-success

  const autoLogin = async (emailValue, passwordValue) => {
    const loginResult = await authLogin(emailValue, passwordValue);
    if (!loginResult?.token) return false;

    saveToken(loginResult.token);
    try {
      const user = userData();
      const userId = user?.username || (user?.userId != null ? String(user.userId) : null);
      if (userId) {
        const { default: vaultStore } = await import('../../../../store/vaultStore.js');
        vaultStore.setUserId(userId);
        const unlocked = await vaultService.findAndUnlock(passwordValue, userId);
        if (!unlocked) {
          await vaultService.setupKeystoreWithPassword(passwordValue);
        }
      }
    } catch (vaultErr) {
      console.warn('[SignupScreen] Vault auto-unlock failed:', vaultErr);
    }
    return true;
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (pending()) return;

    const usernameValue = username().trim();
    const emailValue = email().trim();
    const passwordValue = password();

    if (!usernameValue || !emailValue || !passwordValue || !confirmPassword()) {
      setError('ALL FIELDS ARE REQUIRED.');
      return;
    }
    if (passwordValue.length < 6) {
      setError('PASSWORD MUST BE AT LEAST 6 CHARACTERS LONG.');
      return;
    }
    if (passwordValue !== confirmPassword()) {
      setError('PASSWORDS DO NOT MATCH.');
      return;
    }

    setError('');
    setMessage('');
    setPending(true);
    try {
      const response = await registerUser(usernameValue, emailValue, passwordValue);

      if (response?.requiresApproval) {
        setMessage('ACCOUNT CREATED // AWAITING ADMIN APPROVAL');
        setStage('pending-approval');
        return;
      }

      let loggedIn = false;
      try {
        loggedIn = await autoLogin(emailValue, passwordValue);
      } catch (loginErr) {
        console.warn('[SignupScreen] Auto-login after registration failed:', loginErr);
      }

      if (loggedIn) {
        window.location.hash = '#home';
        return;
      }

      setMessage('ACCOUNT CREATED. PLEASE SIGN IN.');
      setStage('manual-success');
    } catch (err) {
      if (err?.status === 429) {
        setError('REGISTRATION QUEUE FULL // TRY AGAIN LATER');
      } else {
        setError((err?.message || 'REGISTRATION FAILED.').toUpperCase());
      }
    } finally {
      setPending(false);
    }
  };

  return (
    <AuthScreenLayout screen="signup" title="INTELLACC // NEW ACCOUNT">
      <Show when={stage() === 'form'}>
        <form onSubmit={handleSubmit} class="flex flex-col gap-4">
          <div class="flex flex-col gap-1">
            <label class="text-bb-muted text-xs uppercase">Identity // Username</label>
            <input
              type="text"
              value={username()}
              onInput={(e) => setUsername(e.target.value)}
              class="bg-bb-bg border border-bb-border p-2 text-bb-text focus:border-bb-accent focus:outline-none"
              placeholder="Choose handle..."
              required
              disabled={pending()}
              autofocus
            />
          </div>
          <div class="flex flex-col gap-1">
            <label class="text-bb-muted text-xs uppercase">Credentials // Email</label>
            <input
              type="email"
              value={email()}
              onInput={(e) => setEmail(e.target.value)}
              class="bg-bb-bg border border-bb-border p-2 text-bb-text focus:border-bb-accent focus:outline-none"
              placeholder="Enter system address..."
              required
              disabled={pending()}
            />
          </div>
          <div class="flex flex-col gap-1">
            <label class="text-bb-muted text-xs uppercase">Security // Password</label>
            <input
              type="password"
              value={password()}
              onInput={(e) => setPassword(e.target.value)}
              class="bg-bb-bg border border-bb-border p-2 text-bb-text focus:border-bb-accent focus:outline-none"
              placeholder="Create access key (min 6 chars)..."
              required
              disabled={pending()}
            />
          </div>
          <div class="flex flex-col gap-1">
            <label class="text-bb-muted text-xs uppercase">Security // Confirm Password</label>
            <input
              type="password"
              value={confirmPassword()}
              onInput={(e) => setConfirmPassword(e.target.value)}
              class="bg-bb-bg border border-bb-border p-2 text-bb-text focus:border-bb-accent focus:outline-none"
              placeholder="Re-enter access key..."
              required
              disabled={pending()}
            />
          </div>
          <button
            type="submit"
            class="mt-2 bg-bb-accent text-bb-bg font-bold py-2 hover:bg-bb-accent/90 uppercase tracking-widest"
            disabled={pending()}
          >
            {pending() ? '> CREATING ACCOUNT...' : '> CREATE ACCOUNT'}
          </button>
        </form>
      </Show>

      <Show when={stage() === 'pending-approval' || stage() === 'manual-success'}>
        <div class="text-bb-accent border border-bb-accent/30 bg-bb-accent/10 p-3 text-xs">{message()}</div>
      </Show>

      <Show when={error()}>
        <div class="text-market-down border border-market-down/30 bg-market-down/10 p-2 text-xs mt-4">
          &gt; ERROR: {error()}
        </div>
      </Show>
    </AuthScreenLayout>
  );
}

function ForgotScreen() {
  const [email, setEmail] = createSignal('');
  const [error, setError] = createSignal('');
  const [message, setMessage] = createSignal('');
  const [sending, setSending] = createSignal(false);
  const [sent, setSent] = createSignal(false);

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (sending()) return;

    const value = email().trim();
    if (!value) {
      setError('EMAIL IS REQUIRED.');
      return;
    }

    setError('');
    setMessage('');
    setSending(true);
    try {
      const response = await forgotPassword(value);
      setSent(true);
      setMessage((response?.message || 'If an account exists for that email, a reset link was sent.').toUpperCase());
    } catch (err) {
      setError((err?.message || 'FAILED TO REQUEST RESET LINK.').toUpperCase());
    } finally {
      setSending(false);
    }
  };

  return (
    <AuthScreenLayout screen="forgot-password" title="INTELLACC // PASSWORD RESET">
      <Show when={!sent()}>
        <form onSubmit={handleSubmit} class="flex flex-col gap-4">
          <div class="flex flex-col gap-1">
            <label class="text-bb-muted text-xs uppercase">Credentials // Email</label>
            <input
              type="email"
              value={email()}
              onInput={(e) => setEmail(e.target.value)}
              class="bg-bb-bg border border-bb-border p-2 text-bb-text focus:border-bb-accent focus:outline-none"
              placeholder="Enter your email..."
              required
              disabled={sending()}
              autofocus
            />
          </div>
          <button
            type="submit"
            class="mt-2 bg-bb-accent text-bb-bg font-bold py-2 hover:bg-bb-accent/90 uppercase tracking-widest"
            disabled={sending()}
          >
            {sending() ? '> SENDING...' : '> SEND RESET LINK'}
          </button>
        </form>
      </Show>

      <Show when={sent()}>
        <p class="text-bb-muted text-xs">CHECK YOUR INBOX AND SPAM FOLDER FOR THE RESET LINK.</p>
      </Show>

      <Show when={error()}>
        <div class="text-market-down border border-market-down/30 bg-market-down/10 p-2 text-xs mt-4">
          &gt; ERROR: {error()}
        </div>
      </Show>
      <Show when={message()}>
        <div class="text-bb-accent border border-bb-accent/30 bg-bb-accent/10 p-2 text-xs mt-4">{message()}</div>
      </Show>
    </AuthScreenLayout>
  );
}

function ResetScreen() {
  const token = getTokenFromHash();
  const [error, setError] = createSignal('');
  const [stage, setStage] = createSignal(token ? 'warning' : 'invalid');
  const [acknowledged, setAcknowledged] = createSignal(false);
  const [newPassword, setNewPassword] = createSignal('');
  const [confirmPassword, setConfirmPassword] = createSignal('');
  const [pending, setPending] = createSignal(false);
  const [message, setMessage] = createSignal('');
  const [executeAfter, setExecuteAfter] = createSignal('');

  const handleContinue = () => {
    if (!acknowledged()) {
      setError('PLEASE CONFIRM YOU UNDERSTAND THE IMPACT BEFORE CONTINUING.');
      return;
    }
    setError('');
    setStage('form');
  };

  const clearLocalResetState = () => {
    clearToken();
    if (typeof indexedDB !== 'undefined') {
      try {
        indexedDB.deleteDatabase('intellacc_keystore');
      } catch (err) {
        console.warn('Failed to clear keystore database:', err);
      }
    }
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (pending()) return;

    if (!token) {
      setError('RESET TOKEN IS MISSING.');
      return;
    }
    if (!acknowledged()) {
      setError('ACKNOWLEDGMENT IS REQUIRED.');
      return;
    }
    if (newPassword().length < 6) {
      setError('PASSWORD MUST BE AT LEAST 6 CHARACTERS LONG.');
      return;
    }
    if (newPassword() !== confirmPassword()) {
      setError('PASSWORDS DO NOT MATCH.');
      return;
    }

    setError('');
    setMessage('');
    setPending(true);
    setStage('resetting');
    try {
      const result = await resetPassword(token, newPassword(), acknowledged());
      clearToken();

      if (result?.status === 'pending') {
        if (result.executeAfter) {
          setExecuteAfter(new Date(result.executeAfter).toLocaleString());
        }
        setMessage('YOUR PASSWORD RESET IS PENDING AND WILL COMPLETE AFTER THE SECURITY DELAY.');
        setStage('pending');
        return;
      }

      setMessage('PASSWORD RESET COMPLETE. SIGN IN AGAIN.');
      clearLocalResetState();
      setStage('success');
    } catch (err) {
      setError((err?.message || 'FAILED TO RESET PASSWORD.').toUpperCase());
      setStage('invalid');
      return;
    } finally {
      setPending(false);
    }
  };

  return (
    <AuthScreenLayout screen="reset-password" title="INTELLACC // RESET PASSWORD">
      <Show when={stage() === 'invalid'}>
        <p class="text-market-down text-xs">THIS RESET LINK IS INVALID OR HAS EXPIRED.</p>
        <button
          type="button"
          onClick={() => { window.location.hash = '#forgot-password'; }}
          class="mt-3 text-bb-accent hover:underline text-xs"
        >
          Request a new link
        </button>
      </Show>

      <Show when={stage() === 'warning'}>
        <div class="flex flex-col gap-3 text-xs">
          <p class="text-market-down">WARNING: Resetting your password will permanently remove your access to encrypted data.</p>
          <p class="text-bb-muted">By resetting, you will lose:</p>
          <ul class="list-disc list-inside text-bb-muted">
            <li>Encrypted messages in your conversations</li>
            <li>Your MLS keys and group memberships</li>
            <li>Access to encrypted conversations until re-invited</li>
          </ul>
          <p class="text-bb-muted">This cannot be undone. Your account and public posts remain intact.</p>
          <div class="flex items-center gap-2">
            <input
              type="checkbox"
              id="reset-warning-checkbox"
              checked={acknowledged()}
              onChange={(e) => setAcknowledged(e.target.checked)}
            />
            <label for="reset-warning-checkbox">I understand and want to continue.</label>
          </div>
          <button
            type="button"
            onClick={handleContinue}
            class="mt-1 bg-bb-accent text-bb-bg font-bold py-2 uppercase tracking-widest hover:bg-bb-accent/90"
          >
            &gt; CONTINUE
          </button>
        </div>
      </Show>

      <Show when={stage() === 'form'}>
        <form onSubmit={handleSubmit} class="flex flex-col gap-4">
          <div class="flex flex-col gap-1">
            <label class="text-bb-muted text-xs uppercase">New Password</label>
            <input
              type="password"
              value={newPassword()}
              onInput={(e) => setNewPassword(e.target.value)}
              class="bg-bb-bg border border-bb-border p-2 text-bb-text focus:border-bb-accent focus:outline-none"
              placeholder="Enter new password"
              required
              disabled={pending()}
            />
          </div>
          <div class="flex flex-col gap-1">
            <label class="text-bb-muted text-xs uppercase">Confirm Password</label>
            <input
              type="password"
              value={confirmPassword()}
              onInput={(e) => setConfirmPassword(e.target.value)}
              class="bg-bb-bg border border-bb-border p-2 text-bb-text focus:border-bb-accent focus:outline-none"
              placeholder="Re-enter new password"
              required
              disabled={pending()}
            />
          </div>
          <div class="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              id="reset-confirm-checkbox"
              checked={acknowledged()}
              onChange={(e) => setAcknowledged(e.target.checked)}
            />
            <label for="reset-confirm-checkbox">I understand the encrypted data will be removed.</label>
          </div>
          <button
            type="submit"
            class="mt-1 bg-bb-accent text-bb-bg font-bold py-2 uppercase tracking-widest hover:bg-bb-accent/90"
            disabled={pending()}
          >
            {pending() ? '> RESETTING...' : '> RESET PASSWORD'}
          </button>
        </form>
      </Show>

      <Show when={stage() === 'resetting'}>
        <p class="text-bb-muted text-xs animate-pulse">APPLYING RESET...</p>
      </Show>

      <Show when={stage() === 'pending'}>
        <p class="text-bb-accent text-xs">{message()}</p>
        <Show when={executeAfter()}>
          <p class="text-bb-muted text-xs">COMPLETES AFTER: {executeAfter()}</p>
        </Show>
      </Show>

      <Show when={stage() === 'success'}>
        <p class="text-bb-accent text-xs">{message()}</p>
      </Show>

      <Show when={error()}>
        <div class="text-market-down border border-market-down/30 bg-market-down/10 p-2 text-xs mt-4">
          &gt; ERROR: {error()}
        </div>
      </Show>
    </AuthScreenLayout>
  );
}

function VerifyEmailScreen() {
  const [status, setStatus] = createSignal('verifying');
  const [message, setMessage] = createSignal('');

  const verify = async () => {
    const token = getTokenFromHash();
    if (!token) {
      setStatus('error');
      setMessage('VERIFICATION TOKEN MISSING. USE THE LINK FROM YOUR EMAIL.');
      return;
    }

    try {
      await confirmEmailVerification(token);
      setStatus('success');
      setMessage('YOUR EMAIL HAS BEEN VERIFIED SUCCESSFULLY.');
    } catch (err) {
      setStatus('error');
      setMessage((err?.data?.message || err?.message || 'EMAIL VERIFICATION FAILED').toUpperCase());
    }
  };

  createEffect(() => {
    verify();
  });

  return (
    <AuthScreenLayout screen="verify-email" title="INTELLACC // EMAIL VERIFICATION" allowWhenLoggedIn>
      <Show when={status() === 'verifying'}>
        <p class="text-bb-muted text-xs animate-pulse text-center py-4">VERIFYING YOUR EMAIL...</p>
      </Show>

      <Show when={status() === 'success'}>
        <div class="text-bb-accent border border-bb-accent/30 bg-bb-accent/10 p-3 text-xs">{message()}</div>
        <button
          type="button"
          onClick={() => { window.location.hash = '#home'; }}
          class="mt-4 bg-bb-accent text-bb-bg font-bold py-2 w-full uppercase tracking-widest hover:bg-bb-accent/90"
        >
          [GO HOME]
        </button>
      </Show>

      <Show when={status() === 'error'}>
        <div class="text-market-down border border-market-down/30 bg-market-down/10 p-3 text-xs">
          &gt; ERROR: {message()}
        </div>
        <button
          type="button"
          onClick={() => { window.location.hash = '#settings'; }}
          class="mt-4 border border-bb-border text-bb-muted py-2 w-full uppercase hover:text-bb-accent hover:border-bb-accent"
        >
          [REQUEST NEW LINK]
        </button>
      </Show>
    </AuthScreenLayout>
  );
}

export const AUTH_SCREENS = {
  signup: SignupScreen,
  'forgot-password': ForgotScreen,
  'reset-password': ResetScreen,
  'verify-email': VerifyEmailScreen
};
