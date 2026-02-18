import { createSignal, onCleanup, onMount } from 'solid-js';
import Layout from './components/Layout';
import HomePage from './pages/HomePage';
import LoginPage from './pages/LoginPage';
import SignUpPage from './pages/SignUpPage';
import ForgotPasswordPage from './pages/ForgotPasswordPage';
import ResetPasswordPage from './pages/ResetPasswordPage';

const ROUTES = {
  home: 'home',
  login: 'login',
  signup: 'signup',
  'forgot-password': 'forgot-password',
  'reset-password': 'reset-password'
};

const sanitizeRoute = (raw) => {
  const value = (raw || '').replace(/^#/, '') || 'home';
  const base = value.split('?')[0];
  return ROUTES[base] || 'not-found';
};

export default function App() {
  const [page, setPage] = createSignal(sanitizeRoute(window.location.hash || 'home'));

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

    return (
      <div class="not-found">
        <h1>404</h1>
        <p>Page not found.</p>
      </div>
    );
  };

  const handleHash = () => setPage(sanitizeRoute(window.location.hash));

  window.addEventListener('hashchange', handleHash);

  onMount(() => {
    if (!window.location.hash) {
      setPage('home');
    }
  });

  onCleanup(() => {
    window.removeEventListener('hashchange', handleHash);
  });

  return (
    <Layout>
      {renderPage()}
    </Layout>
  );
}
