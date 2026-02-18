import {
  createSignal,
  onCleanup,
  onMount,
  Show
} from 'solid-js';
import { isAuthenticated, logout } from '../services/auth';
import { setSkin, skinState } from '../services/skinProvider';

const refreshAuth = () => isAuthenticated();

function TerminalSkinToggle() {
  return (
    <div class="skin-toggle">
      <span>Skin:</span>
      <button
        type="button"
        classList={{ active: skinState() === 'van' }}
        onClick={() => setSkin('van')}
      >
        Van
      </button>
      <button
        type="button"
        classList={{ active: skinState() === 'terminal' }}
        onClick={() => setSkin('terminal')}
      >
        Terminal
      </button>
    </div>
  );
}

function VanSidebar() {
  return (
    <aside class="sidebar">
      <div class="sidebar-logo">INTELLACC</div>
      <div class="sidebar-content">
        <div class="sidebar-item">
          <a href="#home">Home</a>
        </div>
        <div class="sidebar-item">
          <a href="#predictions">Predictions</a>
        </div>
        <div class="sidebar-item">
          <a href="#messages">Messages</a>
        </div>
        <div class="sidebar-item">
          <a href="#notifications">Notifications</a>
        </div>
        <div class="sidebar-item">
          <a href="#settings">Settings</a>
        </div>
        <Show when={isAuthenticated()}>
          <div class="auth-items">
            <div class="sidebar-item">
              <a href="#profile">My Profile</a>
            </div>
            <div class="sidebar-item">
              <button type="button" class="logout-btn" onClick={logout}>
                Logout
              </button>
            </div>
          </div>
        </Show>
        <Show when={!isAuthenticated()}>
          <div class="sidebar-item">
            <a href="#login">Login</a>
          </div>
        </Show>
      </div>
    </aside>
  );
}

function VanLayout(props) {
  return (
    <div class="app-container">
      <div class="wrapper">
        <div class="content-container">
          <VanSidebar />
          <main class={`main-content page-${props.page || 'home'}`}>{props.children}</main>
        </div>
      </div>
    </div>
  );
}

export default function Layout(props) {
  const [authed, setAuthed] = createSignal(refreshAuth());

  const handleAuthChange = () => {
    setAuthed(refreshAuth());
  };

  onMount(() => {
    window.addEventListener('storage', handleAuthChange);
    window.addEventListener('solid-auth-changed', handleAuthChange);
  });

  onCleanup(() => {
    window.removeEventListener('storage', handleAuthChange);
    window.removeEventListener('solid-auth-changed', handleAuthChange);
  });

  return (
    <Show
      when={skinState() === 'van'}
      fallback={
        <div>
      <header class="top-nav">
        <a href="#home" class="brand">Intellacc</a>
        <nav>
          <button type="button" class="nav-btn" onClick={() => (window.location.hash = 'home')}>
            Home
          </button>
          <button type="button" class="nav-btn" onClick={() => (window.location.hash = 'messages')}>
            Messages
          </button>
          <button type="button" class="nav-btn" onClick={() => (window.location.hash = 'notifications')}>
            Notifications
          </button>
          <button type="button" class="nav-btn" onClick={() => (window.location.hash = 'settings')}>
            Settings
          </button>
          <button type="button" class="nav-btn" onClick={() => (window.location.hash = 'profile')}>
            Profile
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
                <button type="button" class="nav-btn" onClick={logout}>
                  Sign Out
                </button>
              </Show>
            </nav>
            <TerminalSkinToggle />
          </header>
          <main class={`main-content page-${props.page || 'home'}`}>{props.children}</main>
        </div>
      }
    >
      <VanLayout page={props.page}>{props.children}</VanLayout>
    </Show>
  );
}
