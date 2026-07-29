import { createSignal, Show } from 'solid-js';
import { login, isAuthenticated, saveToken, clearToken, getCurrentUserId } from '../services/auth';
import { startVaultLoginBootstrap } from '../services/mls/vaultBootstrap';

const normalizeLoginError = (message) => {
  const text = String(message || '').trim();
  if (!text) {
    return 'Login failed';
  }
  return text.replace(/^ApiError:\s*/i, '');
};

export default function LoginPage() {
  const [identifier, setIdentifier] = createSignal('');
  const [password, setPassword] = createSignal('');
  const [error, setError] = createSignal('');
  const [pending, setPending] = createSignal(false);
  const [message, setMessage] = createSignal('');
  const [stage, setStage] = createSignal('form');

  const alreadySignedIn = () => isAuthenticated();

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (pending()) {
      return;
    }

    setError('');
    setMessage('');
    const identifierValue = identifier().trim();
    const passwordValue = password();

    if (!identifierValue || !passwordValue) {
      setError('Email/username and password are required.');
      return;
    }

    setPending(true);
    setStage('logging_in');

    try {
      const response = await login(identifierValue, passwordValue);
      if (!response?.token) {
        setError(response?.message || 'Login failed.');
        setStage('form');
      } else {
        clearToken();
        saveToken(response.token);

        // Unlock (or first-time set up) the MLS vault in the BACKGROUND —
        // awaiting it here blocked navigation for the whole crypto sequence
        // (2-5s on first devices). vaultBootstrap serializes the work so the
        // messaging unlock forms join it instead of racing it.
        const userId = getCurrentUserId();
        if (userId) {
          startVaultLoginBootstrap(userId, passwordValue);
        }

        setPassword('');
        setMessage('Login successful. Redirecting…');
        window.location.hash = 'home';
      }
    } catch (err) {
      setError(normalizeLoginError(err?.message));
      setStage('form');
    } finally {
      setPending(false);
    }
  };

  return (
    <section class="login-page">
      <div class="login-container">
        <h1>Sign In</h1>

        <Show when={alreadySignedIn()} fallback={
          <>
            <Show when={error()}>
              <p class="error-message login-error-message">{error()}</p>
            </Show>
            <Show when={message()}>
              <p class="success">{message()}</p>
            </Show>

            <form
              class="auth-form"
              onSubmit={handleSubmit}
              style={`display: ${stage() === 'logging_in' ? 'none' : 'block'}`}
            >
              <div class="form-group">
                <label for="email">Email or Username</label>
                <input
                  id="email"
                  type="text"
                  value={identifier()}
                  onInput={(event) => setIdentifier(event.target.value)}
                  placeholder="Enter your email or username"
                  autocomplete="username"
                  required
                  disabled={pending()}
                />
              </div>

              <div class="form-group">
                <label for="password">Password</label>
                <input
                  id="password"
                  type="password"
                  value={password()}
                  onInput={(event) => setPassword(event.target.value)}
                  placeholder="Enter your password"
                  autocomplete="current-password"
                  required
                  disabled={pending()}
                />
              </div>

              <div class="form-actions">
                  <button type="submit" class="btn-primary" disabled={pending() || stage() !== 'form'}>
                    {pending() ? 'Signing in…' : 'Sign In'}
                  </button>

                {/* Social login (Bluesky/Mastodon) UI removed for launch: the
                    buttons only called a placeholder handler and never reached
                    the backend OAuth routes. Restore from git history once the
                    UI is actually wired to /auth/atproto|mastodon/start. */}

                <div class="auth-links">
                  <a href="#forgot-password">Forgot password?</a>
                  <p>
                    No account yet? <a href="#signup">Create one</a>
                  </p>
                </div>
              </div>
            </form>

            <div
              class="verification-stage"
              style={`display: ${stage() === 'logging_in' ? 'block' : 'none'}`}
            >
              <div class="loading-spinner" />
              <p>Signing in...</p>
            </div>
          </>
        }>
          <p class="success">You are already signed in.</p>
          <button type="button" onClick={() => (window.location.hash = 'home')}>
            Go to feed
          </button>
        </Show>
      </div>
    </section>
  );
}
