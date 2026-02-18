import { createSignal, onCleanup, onMount } from 'solid-js';
import Layout from './components/Layout';
import HomePage from './pages/HomePage';

const ROUTES = {
  home: 'home',
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
