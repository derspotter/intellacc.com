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

  const handleUseSignup = () => {
    window.location.hash = 'signup';
  };

  return (
    <section class="auth-page">
      <h1>Sign in to continue</h1>

      <Show when={alreadySignedIn()} fallback={(
        <>
          <form class="auth-form" onSubmit={handleSubmit}>
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
            <button type="submit" disabled={pending()}>
              {pending() ? 'Signing in…' : 'Sign in'}
            </button>
          </form>

          <Show when={error()}>
            <p class="error">{error()}</p>
          </Show>
          <Show when={message()}>
            <p class="success">{message()}</p>
          </Show>

          <div class="auth-links">
            <a href="#forgot-password">Forgot password?</a>
            <button type="button" onClick={handleUseSignup}>Create account</button>
          </div>
        </>
      )}>
        <p class="success">You are already signed in.</p>
        <button type="button" onClick={() => (window.location.hash = 'home')}>Go to feed</button>
      </Show>
    </section>
  );
}
