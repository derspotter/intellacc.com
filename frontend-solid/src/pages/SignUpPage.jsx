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
                <label for="signup-username">Username</label>
                <input
                  id="signup-username"
                  type="text"
                  value={username()}
                  onInput={(event) => setUsername(event.target.value)}
                  placeholder="Choose a username"
                  autocomplete="username"
                  required
                  disabled={pending()}
                />
              </div>

              <div class="form-group">
                <label for="signup-email">Email</label>
                <input
                  id="signup-email"
                  type="email"
                  value={email()}
                  onInput={(event) => setEmail(event.target.value)}
                  placeholder="Enter your email"
                  autocomplete="email"
                  inputmode="email"
                  required
                  disabled={pending()}
                />
              </div>

              <div class="form-group">
                <label for="signup-password">Password</label>
                <input
                  id="signup-password"
                  type="password"
                  value={password()}
                  onInput={(event) => setPassword(event.target.value)}
                  placeholder="Choose a password"
                  autocomplete="new-password"
                  required
                  disabled={pending()}
                />
              </div>

              <div class="form-group">
                <label for="signup-confirm-password">Confirm Password</label>
                <input
                  id="signup-confirm-password"
                  type="password"
                  value={confirm()}
                  onInput={(event) => setConfirm(event.target.value)}
                  placeholder="Confirm your password"
                  autocomplete="new-password"
                  required
                  disabled={pending()}
                />
              </div>

              <Show when={error()}>
                <p class="error-message">{error()}</p>
              </Show>

              <div class="form-actions">
                <button type="submit" class="btn-primary" disabled={pending()}>
                  {pending() ? 'Creating Account…' : 'Create Account'}
                </button>
                <p class="login-link">Already have an account? <a href="#login">Sign in here</a></p>
              </div>
            </form>

            <Show when={resultMessage() && !requiresApproval()}>
              <p class={error() ? 'error-message' : 'success'}>{resultMessage()}</p>
            </Show>

            <Show when={requiresApproval()}>
              <div class="register-link">
                <div
                  style="margin: 0.75rem 0; padding: 0.75rem; border-radius: 8px; background: rgba(34, 197, 94, 0.12); border: 1px solid #22c55e; color: #0f5132;"
                >
                  {resultMessage()}
                </div>
                <p>Need another account? <a href="#signup">Register another</a></p>
                <p>Already registered? <a href="#login">Sign in now</a></p>
              </div>
            </Show>
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
