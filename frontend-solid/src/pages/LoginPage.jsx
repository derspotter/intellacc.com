import { createSignal, Show } from 'solid-js';
import { login, isAuthenticated, saveToken, clearToken } from '../services/auth';

const normalizeLoginError = (message) => {
  const text = String(message || '').trim();
  if (!text) {
    return 'Login failed';
  }
  return text.replace(/^ApiError:\s*/i, '');
};

export default function LoginPage() {
  const [email, setEmail] = createSignal('');
  const [password, setPassword] = createSignal('');
  const [blueskyHandle, setBlueskyHandle] = createSignal('');
  const [mastodonInstance, setMastodonInstance] = createSignal('');
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
    const emailValue = email().trim();
    const passwordValue = password();

    if (!emailValue || !passwordValue) {
      setError('Email and password are required.');
      return;
    }

    setPending(true);
    setStage('logging_in');

    try {
      const response = await login(emailValue, passwordValue);
      if (!response?.token) {
        setError(response?.message || 'Login failed.');
        setStage('form');
      } else {
        clearToken();
        saveToken(response.token);
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

  const handleSocialPlaceholder = (type) => {
    const handle = type === 'bluesky' ? blueskyHandle().trim() : mastodonInstance().trim();
    if (!handle) {
      setError(`Enter your ${type === 'bluesky' ? 'Bluesky handle' : 'Mastodon instance'} first.`);
      return;
    }
    setError('');
    setMessage(`Starting ${type === 'bluesky' ? 'Bluesky' : 'Mastodon'} login...`);
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
                <label for="email">Email</label>
                <input
                  id="email"
                  type="email"
                  value={email()}
                  onInput={(event) => setEmail(event.target.value)}
                  placeholder="Enter your email"
                  autocomplete="email"
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

                <div class="social-auth-section">
                  <p class="social-auth-title">or continue with</p>
                  <div class="social-auth-provider">
                    <label for="bluesky-identifier">Bluesky handle</label>
                    <input
                      id="bluesky-identifier"
                      type="text"
                      placeholder="you.bsky.social"
                      value={blueskyHandle()}
                      onInput={(event) => setBlueskyHandle(event.target.value)}
                      disabled={pending()}
                    />
                    <button type="button" class="button social-auth-button" onClick={() => handleSocialPlaceholder('bluesky')}>
                      Continue with Bluesky
                    </button>
                  </div>

                  <div class="social-auth-provider">
                    <label for="mastodon-instance">Mastodon instance</label>
                    <input
                      id="mastodon-instance"
                      type="text"
                      placeholder="mastodon.social"
                      value={mastodonInstance()}
                      onInput={(event) => setMastodonInstance(event.target.value)}
                      disabled={pending()}
                    />
                    <button type="button" class="button social-auth-button" onClick={() => handleSocialPlaceholder('mastodon')}>
                      Continue with Mastodon
                    </button>
                  </div>
                </div>

                <div class="auth-links">
                  <a href="#forgot-password">Forgot password?</a>
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
