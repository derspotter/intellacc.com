import {
  createSignal,
  onCleanup,
  onMount,
  Show
} from 'solid-js';
import { isAuthenticated, logout } from '../services/auth';
import { setSkin, skinState } from '../services/skinProvider';
import MobileTabBar from './MobileTabBar';
import { installShortcuts } from '../utils/keyboard';
import ShortcutHelp from './ShortcutHelp';

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

function VanSidebar(props) {
  return (
    <aside
      class="sidebar"
      classList={{ open: props.open }}
      onClick={(e) => {
        if (e.target.closest('a, button')) props.onClose();
      }}
    >
      <div class="sidebar-logo">INTELLACC</div>
      <div class="sidebar-content">
        <div class="sidebar-item">
          <a href="#home">Home</a>
        </div>
        <div class="sidebar-item">
          <a href="#search">Search</a>
        </div>
        <div class="sidebar-item">
          <a href="#predictions">Predictions</a>
        </div>
        <div class="sidebar-item">
          <a href="#analytics">Analytics</a>
        </div>
        <div class="sidebar-item">
          <a href="#network">Network</a>
        </div>
        <div class="sidebar-item">
          <a href="#groups">Groups</a>
        </div>
        <div class="sidebar-item">
          <a href="#notifications">Notifications</a>
        </div>
        <div class="sidebar-item">
          <a href="#messages">Messages</a>
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
  const [drawerOpen, setDrawerOpen] = createSignal(false);
  const closeDrawer = () => setDrawerOpen(false);
  const [helpOpen, setHelpOpen] = createSignal(false);

  onMount(() => {
    window.addEventListener('hashchange', closeDrawer);
    const dispose = installShortcuts({ openHelp: () => setHelpOpen(true) });
    onCleanup(dispose);
  });
  onCleanup(() => window.removeEventListener('hashchange', closeDrawer));

  return (
    <div class="app-container">
      <div class="wrapper">
        <div class="content-container">
          <VanSidebar open={drawerOpen()} onClose={closeDrawer} />
          <Show when={drawerOpen()}>
            <div class="sidebar-backdrop" onClick={closeDrawer} />
          </Show>
          <main class={`main-content page-${props.page || 'home'}`}>{props.children}</main>
        </div>
      </div>
      <MobileTabBar moreOpen={drawerOpen()} onMoreToggle={() => setDrawerOpen((v) => !v)} />
      <Show when={helpOpen()}>
        <ShortcutHelp onClose={() => setHelpOpen(false)} />
      </Show>
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
          <button type="button" class="nav-btn" onClick={() => (window.location.hash = 'analytics')}>
            Analytics
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
