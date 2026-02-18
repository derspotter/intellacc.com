import { createSignal, onCleanup, onMount } from 'solid-js';
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
  settings: 'settings'
};

const AUTH_ROUTES = ['login', 'signup', 'forgot-password', 'reset-password'];

const sanitizeRoute = (raw) => {
  const value = (raw || '').replace(/^#/, '') || 'home';
  const base = value.split('?')[0];
  const [route = 'home'] = base.split('/');
  return ROUTES[route] || 'not-found';
};

export default function App() {
  const [page, setPage] = createSignal(sanitizeRoute(window.location.hash || 'home'));
  const [routeParam, setRouteParam] = createSignal(null);
  const isAuthPage = () => AUTH_ROUTES.includes(page());

  const parseRoute = (hashValue) => {
    const value = (hashValue || '').replace(/^#/, '') || 'home';
    const [routeValue] = value.split('?');
    const [route, param] = routeValue.split('/');
    if (route === 'user' && !param) {
      setPage('not-found');
      setRouteParam(null);
      return;
    }

    const normalizedRoute = ROUTES[route] || 'not-found';

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

  if (isAuthPage()) {
    return renderPage();
  }

  return (
    <Layout page={page()}>
      {renderPage()}
    </Layout>
  );
}
