import { createSignal, onCleanup, onMount, Show } from 'solid-js';
import Layout from './components/Layout';
import HomePage from './pages/HomePage';
import LoginPage from './pages/LoginPage';
import SignUpPage from './pages/SignUpPage';
import ForgotPasswordPage from './pages/ForgotPasswordPage';
import ResetPasswordPage from './pages/ResetPasswordPage';
import ProfilePage from './pages/ProfilePage';
import PredictionsPage from './pages/PredictionsPage';
import MessagesPage from './pages/MessagesPage';
import NotificationsPage from './pages/NotificationsPage';
import SettingsPage from './pages/SettingsPage';
import VerifyEmailPage from './pages/VerifyEmailPage';

const ROUTES = {
  home: 'home',
  login: 'login',
  signup: 'signup',
  'forgot-password': 'forgot-password',
  'reset-password': 'reset-password',
  profile: 'profile',
  user: 'user',
  predictions: 'predictions',
  messages: 'messages',
  notifications: 'notifications',
  settings: 'settings',
  'verify-email': 'verify-email'
};

const NOT_FOUND_ROUTE = 'notFound';

const AUTH_ROUTES = [
  'login',
  'signup',
  'forgot-password',
  'reset-password',
  'verify-email'
];

const normalizeHashPath = (raw) => {
  const value = (raw || '').replace(/^#/, '').trim();
  if (!value || value.startsWith('?')) {
    return 'home';
  }

  const [path] = value.split('?');
  const normalized = path.replace(/^\/+/, '').replace(/\/+$/, '');

  return normalized || 'home';
};

const sanitizeRoute = (raw) => {
  const route = normalizeHashPath(raw).split('/')[0];
  return ROUTES[route] || NOT_FOUND_ROUTE;
};

export default function App() {
  const [page, setPage] = createSignal(sanitizeRoute(window.location.hash || 'home'));
  const [routeParam, setRouteParam] = createSignal(null);
  const isAuthPage = () => AUTH_ROUTES.includes(page());

  const parseRoute = (hashValue) => {
    const value = normalizeHashPath(hashValue);
    const [route, param] = value.split('/');

    if (route === 'user' && !param) {
      setPage(NOT_FOUND_ROUTE);
      setRouteParam(null);
      return;
    }

    const normalizedRoute = ROUTES[route] || NOT_FOUND_ROUTE;

    setPage(normalizedRoute);
    setRouteParam(param || null);
  };

  const profilePageId = () => routeParam();

  const renderPage = () => {
    if (page() === 'home') {
      return <HomePage />;
    }
    if (page() === 'login') {
      return <LoginPage />;
    }
    if (page() === 'signup') {
      return <SignUpPage />;
    }
    if (page() === 'forgot-password') {
      return <ForgotPasswordPage />;
    }
    if (page() === 'reset-password') {
      return <ResetPasswordPage />;
    }
    if (page() === 'predictions') {
      return <PredictionsPage />;
    }
    if (page() === 'settings') {
      return <SettingsPage />;
    }
    if (page() === 'verify-email') {
      return <VerifyEmailPage />;
    }
    if (page() === 'messages') {
      return <MessagesPage />;
    }
    if (page() === 'notifications') {
      return <NotificationsPage />;
    }
    if (page() === 'profile') {
      return <ProfilePage />;
    }
    if (page() === 'user') {
      return <ProfilePage userId={profilePageId} />;
    }

    if (page() === 'notFound' || page() === 'not-found') {
      return (
        <div class="not-found">
          <h1>404</h1>
          <p>Page not found.</p>
        </div>
      );
    }

    return (
      <div class="not-found">
        <h1>404</h1>
        <p>Page not found.</p>
      </div>
    );
  };

  const handleHash = () => parseRoute(window.location.hash);

  window.addEventListener('hashchange', handleHash);

  onMount(() => {
    if (!window.location.hash) {
      setPage('home');
      setRouteParam(null);
      return;
    }
    parseRoute(window.location.hash);
  });

  onCleanup(() => {
    window.removeEventListener('hashchange', handleHash);
  });

  return (
    <Show
      when={isAuthPage()}
      fallback={
        <Layout page={page()}>
          {renderPage()}
        </Layout>
      }
    >
      {renderPage()}
    </Show>
  );
}
