import { children, createSignal, onCleanup, onMount, Show } from 'solid-js';
import { skinState } from '../services/skinProvider';
import { setSkin } from '../services/skinProvider';
import { isAuthenticated, logout } from '../services/auth';

function SkinPill({ label, value, active, onClick }) {
  return (
    <button
      classList={{ active: active === value }}
      type="button"
      onClick={() => onClick(value)}
    >
      {label}
    </button>
  );
}

export default function Layout(props) {
  const getChildren = children(() => props.children);
  const [authed, setAuthed] = createSignal(isAuthenticated());
  const handleLogout = () => {
    logout();
  };
  const onLogout = (event) => {
    event.preventDefault();
    handleLogout();
  };
  const refreshAuth = () => setAuthed(isAuthenticated());

  onMount(() => {
    refreshAuth();
    window.addEventListener('solid-auth-changed', refreshAuth);
    window.addEventListener('storage', refreshAuth);
  });

  onCleanup(() => {
    window.removeEventListener('solid-auth-changed', refreshAuth);
    window.removeEventListener('storage', refreshAuth);
  });

  return (
    <div class="app-shell">
      <header class="top-nav">
        <a href="#home" class="brand">Intellacc</a>
        <nav>
          <button type="button" class="nav-btn" onClick={() => (window.location.hash = 'home')}>
            Home
          </button>
          <Show when={!authed()}>
            <button type="button" class="nav-btn" onClick={() => (window.location.hash = 'login')}>
              Login
            </button>
            <button type="button" class="nav-btn" onClick={() => (window.location.hash = 'signup')}>
              Sign Up
            </button>
          </Show>
          <Show when={authed()}>
            <button type="button" class="nav-btn" onClick={onLogout}>
              Sign Out
            </button>
          </Show>
        </nav>
        <div class="skin-toggle">
          <span>Skin:</span>
          <SkinPill label="Van" value="van" active={skinState()} onClick={setSkin} />
          <SkinPill
            label="Terminal"
            value="terminal"
            active={skinState()}
            onClick={setSkin}
          />
        </div>
      </header>
      <main>{getChildren()}</main>
    </div>
  );
}
