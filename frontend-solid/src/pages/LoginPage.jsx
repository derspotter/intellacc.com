import { createSignal, Show } from 'solid-js';
import { login, saveToken, clearToken, isAuthenticated } from '../services/auth';

export default function LoginPage() {
  const [email, setEmail] = createSignal('');
  const [password, setPassword] = createSignal('');
  const [error, setError] = createSignal('');
  const [pending, setPending] = createSignal(false);
  const [message, setMessage] = createSignal('');

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
    try {
      const response = await login(emailValue, passwordValue);
      if (response?.token) {
        clearToken();
        saveToken(response.token);
        setMessage('Login successful. Redirecting…');
        window.location.hash = 'home';
        return;
      }
      setError(response?.message || 'Login failed.');
    } catch (err) {
      setError(err?.message || 'Login failed.');
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
          <form class="auth-form" onSubmit={handleSubmit}>
            <div class="form-group">
              <label class="field">
                <span>Email</span>
                <input
                  type="email"
                  value={email()}
                  onInput={(event) => setEmail(event.target.value)}
                  placeholder="you@example.com"
                  autocomplete="email"
                  required
                />
              </label>
            </div>
            <div class="form-group">
              <label class="field">
                <span>Password</span>
                <input
                  type="password"
                  value={password()}
                  onInput={(event) => setPassword(event.target.value)}
                  placeholder="Your password"
                  autocomplete="current-password"
                  required
                />
              </label>
            </div>
            <div class="form-actions">
              <button type="submit" class="btn-primary" disabled={pending()}>
                {pending() ? 'Signing in…' : 'Sign in'}
              </button>
            </div>
          </form>

          <Show when={error()}>
            <p class="error-message">{error()}</p>
          </Show>
          <Show when={message()}>
            <p class="error-message">{message()}</p>
          </Show>

          <div class="auth-links">
            <a href="#forgot-password">Forgot password?</a>
            <a href="#signup">Create account</a>
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
