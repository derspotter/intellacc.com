import { createSignal, Show } from 'solid-js';
import { register, isAuthenticated } from '../services/auth';

export default function SignUpPage() {
  const [username, setUsername] = createSignal('');
  const [email, setEmail] = createSignal('');
  const [password, setPassword] = createSignal('');
  const [confirm, setConfirm] = createSignal('');
  const [error, setError] = createSignal('');
  const [pending, setPending] = createSignal(false);
  const [resultMessage, setResultMessage] = createSignal('');
  const [requiresApproval, setRequiresApproval] = createSignal(false);

  const alreadySignedIn = () => isAuthenticated();

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (pending()) {
      return;
    }

    setError('');
    setResultMessage('');
    setRequiresApproval(false);

    const usernameValue = username().trim();
    const emailValue = email().trim();
    const passwordValue = password();
    const confirmValue = confirm();

    if (!usernameValue || !emailValue || !passwordValue || !confirmValue) {
      setError('All fields are required.');
      return;
    }
    if (passwordValue.length < 6) {
      setError('Password must be at least 6 characters.');
      return;
    }
    if (passwordValue !== confirmValue) {
      setError('Passwords do not match.');
      return;
    }

    setPending(true);
    try {
      const response = await register(usernameValue, emailValue, passwordValue);
      if (response?.requiresApproval) {
        setRequiresApproval(true);
        setResultMessage(response.message || 'Account created and awaiting approval.');
        return;
      }
      setResultMessage('Account created. You can sign in now.');
    } catch (err) {
      setError(err?.message || 'Registration failed.');
    } finally {
      setPending(false);
    }
  };

  return (
    <section class="signup-page">
      <div class="signup-container">
        <h1>Create Account</h1>

        <Show when={alreadySignedIn()} fallback={
          <>
            <form class="auth-form" onSubmit={handleSubmit}>
              <div class="form-group">
                <label class="field">
                  <span>Username</span>
                  <input
                    type="text"
                    value={username()}
                    onInput={(event) => setUsername(event.target.value)}
                    placeholder="Choose a username"
                    required
                  />
                </label>
              </div>
              <div class="form-group">
                <label class="field">
                  <span>Email</span>
                  <input
                    type="email"
                    value={email()}
                    onInput={(event) => setEmail(event.target.value)}
                    placeholder="you@example.com"
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
                    placeholder="Create password"
                    required
                  />
                </label>
              </div>
              <div class="form-group">
                <label class="field">
                  <span>Confirm password</span>
                  <input
                    type="password"
                    value={confirm()}
                    onInput={(event) => setConfirm(event.target.value)}
                    placeholder="Re-enter password"
                    required
                  />
                </label>
              </div>
              <div class="form-actions">
                <button type="submit" class="btn-primary" disabled={pending()}>
                  {pending() ? 'Creating account…' : 'Sign up'}
                </button>
              </div>
            </form>

            <Show when={error()}>
              <p class="error-message">{error()}</p>
            </Show>
            <Show when={resultMessage()}>
              <p class={requiresApproval() ? 'info' : 'success'}>{resultMessage()}</p>
            </Show>

            <div class="auth-links">
              <a href="#login">Already have an account? Sign in</a>
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
