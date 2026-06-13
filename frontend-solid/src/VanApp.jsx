import { createSignal, onCleanup, onMount, Show } from 'solid-js';
import Layout from './components/Layout';
import HomePage from './pages/HomePage';
import LoginPage from './pages/LoginPage';
import SignUpPage from './pages/SignUpPage';
import ForgotPasswordPage from './pages/ForgotPasswordPage';
import ResetPasswordPage from './pages/ResetPasswordPage';
import ProfilePage from './pages/ProfilePage';
import PredictionsPage from './pages/PredictionsPage';
import AnalyticsPage from './pages/AnalyticsPage';
import NetworkPage from './pages/NetworkPage';
import MessagesPage from './pages/MessagesPage';
import NotificationsPage from './pages/NotificationsPage';
import SettingsPage from './pages/SettingsPage';
import VerifyEmailPage from './pages/VerifyEmailPage';
import SearchPage from './pages/SearchPage';
import TopicPicker from './components/onboarding/TopicPicker';
import { api } from './services/api';
import { isAuthenticated } from './services/auth';

const ROUTES = {
  home: 'home',
  login: 'login',
  signup: 'signup',
  'forgot-password': 'forgot-password',
  'reset-password': 'reset-password',
  profile: 'profile',
  user: 'user',
  predictions: 'predictions',
  analytics: 'analytics',
  network: 'network',
  messages: 'messages',
  notifications: 'notifications',
  settings: 'settings',
  'verify-email': 'verify-email',
  search: 'search'
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

function AppBackground() {
  return (
    <svg
      id="background-svg"
      style="position: fixed; top: 0; left: 0; width: 100%; height: 100%; z-index: -1;"
      viewBox="0 0 1000 562.5"
      preserveAspectRatio="xMidYMid slice"
      aria-hidden="true"
    >
      <rect x="936" y="0" width="18" height="562.5" fill="#FF0000" />
      <rect x="0" y="350" width="1000" height="18" fill="#000000" />
      <circle cx="856" cy="288" r="80" fill="#0000FF" />
      <rect x="900" y="0" width="18" height="562.5" fill="#FF0000" />
    </svg>
  );
}

export default function App() {
  const [page, setPage] = createSignal(sanitizeRoute(window.location.hash || 'home'));
  const [routeParam, setRouteParam] = createSignal(null);
  const [needsTopics, setNeedsTopics] = createSignal(false);
  const isAuthPage = () => AUTH_ROUTES.includes(page());

  // Blocking gate: an authenticated user with zero topics must pick topics
  // before seeing normal content. Fail open on any error so a topics-service
  // outage can never lock users out.
  const checkTopics = async () => {
    if (!isAuthenticated()) {
      setNeedsTopics(false);
      return;
    }
    try {
      const res = await api.topics.getMine();
      const topicIds = res?.topicIds || [];
      setNeedsTopics(topicIds.length === 0);
    } catch {
      setNeedsTopics(false);
    }
  };

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
      return <PredictionsPage marketId={routeParam()} />;
    }
    if (page() === 'analytics') {
      return <AnalyticsPage />;
    }
    if (page() === 'network') {
      return <NetworkPage />;
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
    if (page() === 'search') {
      return <SearchPage />;
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
  const handleAuthChange = () => checkTopics();

  window.addEventListener('hashchange', handleHash);
  window.addEventListener('solid-auth-changed', handleAuthChange);

  onMount(() => {
    checkTopics();
    if (!window.location.hash) {
      setPage('home');
      setRouteParam(null);
      return;
    }
    parseRoute(window.location.hash);
  });

  onCleanup(() => {
    window.removeEventListener('hashchange', handleHash);
    window.removeEventListener('solid-auth-changed', handleAuthChange);
  });

  return (
    <>
      <AppBackground />
      <Show
        when={isAuthPage()}
        fallback={
          <Layout page={page()}>
            <Show when={needsTopics()} fallback={renderPage()}>
              <TopicPicker onDone={() => setNeedsTopics(false)} />
            </Show>
          </Layout>
        }
      >
        {renderPage()}
      </Show>
    </>
  );
}
